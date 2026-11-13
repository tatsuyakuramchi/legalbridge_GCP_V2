import { type Queryable } from "../core/db.js";

/**
 * 契約の記録の版（infra/v3/208_agreement_versions.sql）。
 *
 * 契約の記録（agreements）は 1 行を上書きする。版はトリガーが足す：登録・変更・削除のたびに、
 * その時点の中身を agreement_versions に 1 行。画面からの編集も、文書の決定・締結で自動に動く分も、
 * SQL で直した分も同じように残る。アプリは「だれが・なぜ」を変更の前に渡すだけ（noteAgreementChange）。
 */

/**
 * これから行う契約の変更に、だれが・なぜを添える（トランザクションの中で、UPDATE の前に呼ぶ）。
 * トリガーが lb.actor／lb.reason を読む。トランザクションの外で呼んでも害は無い（何も残らない）。
 */
export async function noteAgreementChange(client: Queryable, actor: string, reason?: string | null): Promise<void> {
  await client.query("SELECT set_config('lb.actor', $1, true), set_config('lb.reason', $2, true)",
    [actor, String(reason ?? "").trim()]);
}

export interface VersionChange { field: string; label: string; from: string; to: string }
export interface AgreementVersion {
  versionNo: number;
  kind: "baseline" | "created" | "changed" | "deleted";
  changedAt: string;
  changedBy: string | null;
  reason: string | null;
  /** 前の版から変わった項目（第 1 版は空）。 */
  changes: VersionChange[];
  /** その版の主な中身（番号・件名・状態・日付）。 */
  summary: { agreementNo: string | null; title: string; status: string; executedOn: string | null;
             effectiveOn: string | null; expiresOn: string | null; terminatedOn: string | null };
}

const LABEL: Record<string, string> = {
  agreement_no: "契約番号", title: "件名", counterparty_id: "相手先", direction: "向き", status: "状態",
  executed_on: "締結日", effective_on: "有効期間の開始", expires_on: "有効期間の終了",
  auto_renewal: "自動更新", renewal_months: "更新期間（か月）", renewal_notice_months: "更新の通知（か月前）",
  renewal_stopped_on: "更新しない通知の日", terminated_on: "終了日", kind: "種類", domain: "種別",
  parent_id: "親の契約", counterparty_ref_no: "相手方の契約番号", source_url: "契約書（リンク）",
  order_document_id: "発注書", source_system: "出どころ", legacy_id: "移行元の番号"
};
const STATUS: Record<string, string> = { draft: "下書き", negotiating: "交渉中", executed: "締結済み", expired: "満了", terminated: "終了" };
const KIND: Record<string, string> = { master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書", termination: "解除合意", document: "文書だけ" };
const DOMAIN: Record<string, string> = { service: "業務委託", license: "ライセンス", hybrid: "ハイブリッド", sale: "売買", other: "その他" };

type Names = { parties: Map<number, string>; agreements: Map<number, string>; documents: Map<number, string> };

function show(field: string, value: unknown, names: Names): string {
  if (value === null || value === undefined || value === "") return "（なし）";
  if (field === "status") return STATUS[String(value)] ?? String(value);
  if (field === "kind") return KIND[String(value)] ?? String(value);
  if (field === "domain") return DOMAIN[String(value)] ?? String(value);
  if (field === "direction") return value === "in" ? "IN" : value === "out" ? "OUT" : String(value);
  if (field === "auto_renewal") return value === true ? "あり" : "なし";
  if (field === "counterparty_id") return names.parties.get(Number(value)) ?? `#${value}`;
  if (field === "parent_id") return names.agreements.get(Number(value)) ?? `#${value}`;
  if (field === "order_document_id") return names.documents.get(Number(value)) ?? `#${value}`;
  return String(value);
}

/** 2 つの版の中身から、変わった項目を並べる（画面の項目の順）。 */
export function diffVersions(prev: Record<string, unknown>, next: Record<string, unknown>,
                             names: Names = { parties: new Map(), agreements: new Map(), documents: new Map() }): VersionChange[] {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])]
    .filter((k) => k !== "id" && JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null));
  const order = Object.keys(LABEL);
  keys.sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  return keys.map((k) => ({ field: k, label: LABEL[k] ?? k, from: show(k, prev[k], names), to: show(k, next[k], names) }));
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * 契約の版の一覧（新しい順）。208 を流していない環境は available=false（表が無い）。
 */
export async function agreementVersions(db: Queryable, agreementId: number): Promise<{ available: boolean; versions: AgreementVersion[] }> {
  let rows: any[];
  try {
    rows = (await db.query(
      `SELECT version_no, change_kind, snapshot, changed_by, reason, changed_at
         FROM agreement_versions WHERE agreement_id = $1 ORDER BY version_no`, [agreementId])).rows as any[];
  } catch (error) {
    // 42P01：表が無い（208 をまだ流していない）。
    if ((error as { code?: string }).code === "42P01") return { available: false, versions: [] };
    throw error;
  }
  const snaps = rows.map((r) => (r.snapshot ?? {}) as Record<string, unknown>);
  const ids = (key: string) => [...new Set(snaps.map((s) => Number(s[key])).filter((n) => Number.isInteger(n) && n > 0))];
  const names: Names = { parties: new Map(), agreements: new Map(), documents: new Map() };
  const partyIds = ids("counterparty_id"), parentIds = ids("parent_id"), docIds = ids("order_document_id");
  if (partyIds.length) {
    for (const r of (await db.query("SELECT id, name FROM parties WHERE id = ANY($1::bigint[])", [partyIds])).rows as any[]) names.parties.set(Number(r.id), String(r.name));
  }
  if (parentIds.length) {
    for (const r of (await db.query("SELECT id, agreement_no, title FROM agreements WHERE id = ANY($1::bigint[])", [parentIds])).rows as any[]) {
      names.agreements.set(Number(r.id), String(r.agreement_no ?? r.title ?? `#${r.id}`));
    }
  }
  if (docIds.length) {
    for (const r of (await db.query("SELECT id, document_no FROM documents WHERE id = ANY($1::bigint[])", [docIds])).rows as any[]) {
      names.documents.set(Number(r.id), String(r.document_no ?? `#${r.id}`));
    }
  }
  const versions = rows.map((r, i): AgreementVersion => {
    const s = snaps[i]!;
    return {
      versionNo: Number(r.version_no), kind: r.change_kind,
      changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at),
      changedBy: str(r.changed_by), reason: str(r.reason),
      changes: i === 0 || r.change_kind === "deleted" ? [] : diffVersions(snaps[i - 1]!, s, names),
      summary: { agreementNo: str(s.agreement_no), title: String(s.title ?? ""), status: String(s.status ?? ""),
                 executedOn: str(s.executed_on), effectiveOn: str(s.effective_on), expiresOn: str(s.expires_on),
                 terminatedOn: str(s.terminated_on) }
    };
  });
  return { available: true, versions: versions.reverse() };
}
