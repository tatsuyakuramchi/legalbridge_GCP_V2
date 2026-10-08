import type { Queryable, Transactable } from "../core/db.js";
import { inTransaction, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { ImportReport, RowOutcome } from "./service.js";

/**
 * 既存契約の一括登録（docs/royalty-shares.md §5.7）。
 *
 * 移行前に紙で結んだ出版の契約（基本契約＋作品ごとの条件書）を、システムの番号を
 * 使わずに「外部で付けた番号」のまま登録し、作品の条件に繋ぐ。計算書の「契約番号」と
 * 運用 › 契約なし の判定はこの繋がりを見るので、繋がっていないと二重に発行してしまう。
 *
 *   1 行＝作品 × 相手先。
 *   - 基本契約番号 … あれば当てる（同じ相手先の契約であること）。無ければその番号で
 *                     基本契約（IN・ライセンス・締結済み）を作る。空なら基本契約は触らない。
 *   - 個別契約番号 … 条件書の番号。同じ番号の文書が既にあれば（番号だけ先に出した空の
 *                     条件書）それを使い、無ければその番号で取込文書を作る。作品の紙・電子の
 *                     条件を文書に繋ぎ、文書を基本契約の下に置く。
 *   - 作品の条件は基本契約にぶら下げる（別の契約に載っていれば止める）。
 *
 * 試算（dryRun）は何も書かない。同じ CSV の前の行で作る基本契約は、後の行でも当たる。
 */

export interface ExistingContractsDeps {
  agreements: {
    create(input: {
      counterpartyId: number; direction: "in"; kind: "master"; domain: "license"; title: string;
      agreementNo: string; status: "executed"; executedOn: string | null;
    }, actor: string): Promise<{ id: number; agreementNo: string | null }>;
  };
}

export const EXISTING_CONTRACTS_HEADERS = [
  "作品名", "作品コード", "相手先", "相手先コード", "基本契約番号", "基本契約名", "個別契約番号", "個別契約名", "締結日"
];

export const EXISTING_CONTRACTS_SAMPLE =
  "作品名,作品コード,相手先,相手先コード,基本契約番号,基本契約名,個別契約番号,個別契約名,締結日\n" +
  "武装伝奇RPG　神我狩,,合同会社DucQrews,V-0120,ATT-2026-00069,出版及び著作物利用許諾に関する基本契約書,ARC-PUBT-2026-0026,出版等利用許諾条件書（1通目／神我狩シリーズ）,2026-09-24\n" +
  "神我狩リプレイ 黒剣のスレイヤー,,合同会社DucQrews,V-0120,ATT-2026-00069,,ARC-PUBT-2026-0012,,2026-09-24";

const DEFAULT_MASTER_TITLE = "出版及び著作物利用許諾に関する基本契約書";
const DEFAULT_TERMS_TITLE = "出版等利用許諾条件書";
/** 取込文書の種別。条件書として扱う種別（conditions/contracts.ts の TERMS_IMPORT_KINDS）。 */
const TERMS_KIND = "利用許諾契約書";

const text = (row: Record<string, string>, key: string) => String(row[key] ?? "").trim();

interface Plan {
  line: number;
  label: string;
  work: { id: number; title: string };
  party: { id: number; name: string };
  conditions: Array<{ id: number; conditionNo: string | null; usageType: string; agreementId: number | null }>;
  masterNo: string | null;
  master: { id: number; create: boolean; title: string };
  termsNo: string;
  terms: { id: number | null; create: boolean; title: string; alreadyLinked: number[] };
  signedOn: string | null;
}

export class ExistingContractsImportService {
  constructor(private readonly database: Transactable, private readonly deps: ExistingContractsDeps) {}

  async run(raw: Array<Record<string, string>>, dryRun: boolean, actor: string): Promise<ImportReport> {
    const outcomes: RowOutcome[] = [];
    // 同じ CSV で作る基本契約。番号 → id（試算では -1）。
    const made = new Map<string, number>();
    for (const [index, row] of raw.entries()) {
      const line = index + 2;
      const label = text(row, "作品名") || text(row, "作品コード") || `${line} 行目`;
      try {
        const plan = await this.plan(this.database, line, row, made);
        if (plan.master.create && !made.has(plan.masterNo!.toLowerCase())) made.set(plan.masterNo!.toLowerCase(), -1);
        const summary = this.summary(plan);
        if (dryRun) { outcomes.push({ line, status: "ok", label, message: summary }); continue; }
        const result = await this.apply(plan, actor, made);
        outcomes.push({ line, status: "ok", label, id: result.documentId, code: plan.termsNo, message: summary });
      } catch (e: any) {
        outcomes.push({ line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label,
                        message: e?.message ?? "登録に失敗しました" });
      }
    }
    return {
      kind: "existing_contracts", mode: "create", dryRun, total: outcomes.length,
      ok: outcomes.filter((r) => r.status === "ok").length,
      duplicate: outcomes.filter((r) => r.status === "duplicate").length,
      skipped: 0,
      error: outcomes.filter((r) => r.status === "error").length,
      rows: outcomes
    };
  }

  private summary(p: Plan): string {
    const parts = [
      p.masterNo ? `基本契約 ${p.masterNo}${p.master.create ? "（作る）" : ""}` : "基本契約なし",
      `条件書 ${p.termsNo}${p.terms.create ? "（作る）" : p.terms.id ? "（既存に繋ぐ）" : ""}`,
      `条件 ${p.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}`
    ];
    return parts.join("／");
  }

  private async plan(client: Queryable, line: number, row: Record<string, string>, made: Map<string, number>): Promise<Plan> {
    const termsNo = text(row, "個別契約番号");
    if (!termsNo) throw new DomainError("VALIDATION", "個別契約番号が空です");
    const signedOn = text(row, "締結日") || null;
    if (signedOn && !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw new DomainError("VALIDATION", `締結日は YYYY-MM-DD で書いてください（"${signedOn}"）`);

    // 作品
    const code = text(row, "作品コード"), title = text(row, "作品名");
    if (!code && !title) throw new DomainError("VALIDATION", "作品名か作品コードを入れてください");
    const hits = (await client.query(
      `SELECT id, work_code, title FROM works
        WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
           OR ($1 = '' AND btrim(title) = btrim($2))
        LIMIT 3`, [code, title])).rows as Array<{ id: number; work_code: string | null; title: string }>;
    if (hits.length !== 1) {
      throw new DomainError("VALIDATION", hits.length
        ? `作品「${code || title}」が複数当たります。作品コードで指定してください`
        : `作品「${code || title}」が見つかりません。先に出版作品の CSV で登録してください`);
    }
    const work = { id: Number(hits[0].id), title: String(hits[0].title) };

    // 相手先
    const party = await this.findParty(client, text(row, "相手先コード"), text(row, "相手先"));

    // 条件：作品 × 相手先 の有効な出版の IN 条件。
    const conds = (await client.query(
      `SELECT id, condition_no, usage_type, agreement_id FROM conditions
        WHERE work_id = $1 AND counterparty_id = $2 AND direction = 'in' AND kind = 'license'
          AND status = 'active' AND usage_type IN ('pub_print', 'pub_digital')
        ORDER BY usage_type, id`, [work.id, party.id])).rows as Array<Record<string, unknown>>;
    if (!conds.length) {
      throw new DomainError("VALIDATION", `作品「${work.title}」に ${party.name} の出版条件（紙・電子）がありません`);
    }
    const conditions = conds.map((c) => ({
      id: Number(c.id), conditionNo: str(c.condition_no), usageType: String(c.usage_type),
      agreementId: c.agreement_id === null || c.agreement_id === undefined ? null : Number(c.agreement_id)
    }));

    // 基本契約
    const masterNo = text(row, "基本契約番号") || null;
    let master: Plan["master"] = { id: 0, create: false, title: "" };
    if (masterNo) {
      const a = (await client.query(
        "SELECT id, counterparty_id, kind, title FROM agreements WHERE lower(btrim(agreement_no)) = lower($1) LIMIT 2",
        [masterNo])).rows as Array<Record<string, unknown>>;
      if (a.length > 1) throw new DomainError("VALIDATION", `契約番号 ${masterNo} が複数当たります`);
      if (a.length === 1) {
        if (Number(a[0].counterparty_id) !== party.id) throw new DomainError("VALIDATION", `契約 ${masterNo} は ${party.name} の契約ではありません`);
        if (!["master", "standalone"].includes(String(a[0].kind))) throw new DomainError("VALIDATION", `契約 ${masterNo} は基本契約ではありません（${String(a[0].kind)}）`);
        master = { id: Number(a[0].id), create: false, title: String(a[0].title ?? "") };
      } else {
        const earlier = made.get(masterNo.toLowerCase());
        master = { id: earlier ?? 0, create: earlier === undefined || earlier < 0,
                   title: text(row, "基本契約名") || DEFAULT_MASTER_TITLE };
      }
      // 条件が別の基本契約に載っていれば止める（黙って付け替えない）。
      const other = conditions.filter((c) => c.agreementId !== null && master.id > 0 && c.agreementId !== master.id);
      if (other.length) {
        throw new DomainError("VALIDATION",
          `条件 ${other.map((c) => c.conditionNo ?? `#${c.id}`).join("・")} は別の契約（#${other[0].agreementId}）に載っています。契約明細で外してから`);
      }
    }

    // 条件書の文書
    const d = (await client.query(
      `SELECT d.id, d.status, d.agreement_id, d.template_version_id,
              (SELECT array_agg(dc.condition_id) FROM document_conditions dc WHERE dc.document_id = d.id) AS condition_ids,
              (SELECT array_agg(DISTINCT c.counterparty_id) FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
                WHERE dc.document_id = d.id) AS party_ids
         FROM documents d WHERE d.document_no = $1`, [termsNo])).rows[0] as Record<string, unknown> | undefined;
    let terms: Plan["terms"];
    const termsTitle = text(row, "個別契約名") || DEFAULT_TERMS_TITLE;
    if (d) {
      if (String(d.status) === "void") throw new DomainError("VALIDATION", `文書 ${termsNo} は無効化されています`);
      const partyIds = ((d.party_ids as unknown[] | null) ?? []).map(Number);
      if (partyIds.some((p) => p !== party.id)) throw new DomainError("VALIDATION", `文書 ${termsNo} は別の相手先の条件に繋がっています`);
      if (d.agreement_id !== null && d.agreement_id !== undefined && master.id > 0 && Number(d.agreement_id) !== master.id) {
        throw new DomainError("VALIDATION", `文書 ${termsNo} は別の契約（#${Number(d.agreement_id)}）の下にあります`);
      }
      const linked = ((d.condition_ids as unknown[] | null) ?? []).map(Number);
      terms = { id: Number(d.id), create: false, title: termsTitle, alreadyLinked: linked };
    } else {
      terms = { id: null, create: true, title: termsTitle, alreadyLinked: [] };
    }

    return { line, label: work.title, work, party, conditions, masterNo, master, termsNo, terms, signedOn };
  }

  private async apply(plan: Plan, actor: string, made: Map<string, number>): Promise<{ documentId: number }> {
    try {
      // 基本契約は取引の書き込みと同じ経路（採番せず外部番号で）。先に作ってから本体の取引へ。
      if (plan.masterNo && plan.master.create) {
        const key = plan.masterNo.toLowerCase();
        const earlier = made.get(key);
        if (earlier !== undefined && earlier > 0) {
          plan.master = { ...plan.master, id: earlier, create: false };
        } else {
          const a = await this.deps.agreements.create({
            counterpartyId: plan.party.id, direction: "in", kind: "master", domain: "license",
            title: plan.master.title, agreementNo: plan.masterNo, status: "executed", executedOn: plan.signedOn
          }, actor);
          made.set(key, a.id);
          plan.master = { ...plan.master, id: a.id, create: false };
        }
      }
      return await inTransaction(this.database, async (client) => {
        const masterId = plan.masterNo ? plan.master.id : null;
        const conditionIds = plan.conditions.map((c) => c.id);
        if (masterId) {
          await client.query(
            "UPDATE conditions SET agreement_id = $2, updated_at = now() WHERE id = ANY($1::bigint[]) AND agreement_id IS DISTINCT FROM $2",
            [conditionIds, masterId]);
        }

        let documentId: number;
        if (plan.terms.create) {
          const r = await client.query(
            `INSERT INTO documents
               (document_no, template_version_id, agreement_id, status, manual_inputs, issued_at, issued_by)
             VALUES ($1, NULL, $2, 'issued', $3::jsonb, COALESCE($4::date, current_date), $5)
             RETURNING id`,
            [plan.termsNo, masterId,
             JSON.stringify({ title: plan.terms.title, documentKind: TERMS_KIND, imported: true, externalNumber: true,
                              registeredFrom: "existing_contracts" }),
             plan.signedOn, actor]);
          documentId = Number((r.rows[0] as { id: number }).id);
        } else {
          documentId = plan.terms.id!;
          // 空の条件書（番号だけ先に出したもの）を契約として使い直す。ひな形の無い取込文書なら
          // 種別を条件書にする。決定済みでなければ決定済みにする（番号は相手に渡っている）。
          await client.query(
            `UPDATE documents
                SET agreement_id = COALESCE($2, agreement_id),
                    manual_inputs = COALESCE(manual_inputs, '{}'::jsonb)
                      || CASE WHEN template_version_id IS NULL
                              THEN jsonb_build_object('documentKind', $3::text, 'imported', true, 'externalNumber', true)
                              ELSE '{}'::jsonb END
                      || jsonb_build_object('title', COALESCE(manual_inputs->>'title', $4::text), 'registeredFrom', 'existing_contracts'),
                    status = CASE WHEN status = 'draft' THEN 'issued' ELSE status END,
                    issued_at = COALESCE(issued_at, $5::date, current_date),
                    issued_by = COALESCE(issued_by, $6)
              WHERE id = $1`,
            [documentId, masterId, TERMS_KIND, plan.terms.title, plan.signedOn, actor]);
        }
        const toLink = conditionIds.filter((id) => !plan.terms.alreadyLinked.includes(id));
        if (toLink.length) {
          const next = (await client.query(
            "SELECT COALESCE(max(line_no), 0) AS n FROM document_conditions WHERE document_id = $1", [documentId])).rows[0] as { n: number };
          let lineNo = Number(next.n);
          for (const id of toLink) {
            lineNo += 1;
            await client.query(
              "INSERT INTO document_conditions (document_id, condition_id, line_no) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
              [documentId, id, lineNo]);
          }
        }
        await recordAudit(client, {
          actor, action: "contracts.register_existing", targetType: "document", targetId: documentId,
          detail: { documentNo: plan.termsNo, created: plan.terms.create, masterNo: plan.masterNo, masterId,
                    workId: plan.work.id, partyId: plan.party.id, conditionIds }
        });
        return { documentId };
      });
    } catch (error) { throw translate(error); }
  }

  private async findParty(client: Queryable, code: string, name: string): Promise<{ id: number; name: string }> {
    if (!code && !name) throw new DomainError("VALIDATION", "相手先が空です");
    const r = await client.query(
      `SELECT id, name FROM parties
        WHERE status <> 'merged'
          AND (($1 <> '' AND lower(btrim(party_code)) = lower(btrim($1)))
            OR ($2 <> '' AND (btrim(name) = btrim($2) OR btrim(COALESCE(name_kana, '')) = btrim($2)
                              OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE btrim(a) = btrim($2)))))
        LIMIT 3`, [code, name]);
    const rows = r.rows as Array<{ id: number; name: string }>;
    if (rows.length === 1) return { id: Number(rows[0].id), name: String(rows[0].name) };
    throw new DomainError("VALIDATION", rows.length
      ? `相手先「${code || name}」が複数当たります。コードで指定してください`
      : `相手先「${code || name}」が見つかりません。先に取引先を登録してください`);
  }
}
