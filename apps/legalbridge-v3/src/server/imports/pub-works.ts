import type { Queryable, Transactable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionScope } from "../core/model.js";
import { SHARE_TOTAL_PPM, validateShareInput } from "../royalty/shares.js";
import type { ImportReport, RowOutcome } from "./service.js";

/**
 * 出版作品の一括登録（作品＋紙・電子の条件＋共著の取り分＋CID）。
 *
 * 新しい作品を 1 行で入れる。作品が無ければ作り（作品コードか作品名で当たれば既存を使う）、
 * 相手先（代表＝契約の当事者）との紙・電子の料率条件を出版セットで作り、取り分と
 * 分配のスイッチ（当社が分配／代表が分配）を両方の条件に入れ、電子書籍の CID を覚える。
 *
 * 必ず試算（dry-run）を通す。試算は書かずに同じ検証を通し、「作品は新規か既存か、
 * 条件は何本、取り分は誰に何 %」を返す。登録は通常の登録サービスを呼ぶ
 * （取込だけ別の規則で入ると、画面から入れた行と品質が変わる）。
 */

export interface PubWorksDeps {
  works: { create(input: { title: string; titleKana?: string | null; kind?: "own"; status?: "released";
                           businessLine?: string | null; remarks?: string | null; workCode?: string | null;
                           copyrightNotice?: string | null; thirdPartyRights?: string | null }, actor: string):
            Promise<{ id: number; workCode: string | null }> };
  conditions: {
    createPublishingSet(input: {
      counterpartyId: number; workId: number; agreementId?: number | null;
      termStart?: string | null; termEnd?: string | null; paymentTerms?: string | null; notes?: string | null;
      scopes?: ConditionScope[];
      print?: { ratePct: number; exclusivity: "exclusive" | "non_exclusive" | null } | null;
      digital?: { ratePct: number; exclusivity: "exclusive" | "non_exclusive" | null } | null;
    }, actor: string): Promise<{ print: { id: number; conditionNo: string | null } | null;
                                 digital: { id: number; conditionNo: string | null } | null }>;
    replaceShares(id: number, shares: Array<{ partyId: number; sharePpm: number; note?: string | null }>, actor: string,
                  distribution: "direct" | "representative" | null, options: { applyToWork?: boolean }): Promise<unknown>;
  };
}

const EXCLUSIVITY: Record<string, "exclusive" | "non_exclusive"> = {
  独占: "exclusive", exclusive: "exclusive", 非独占: "non_exclusive", non_exclusive: "non_exclusive"
};
const DISTRIBUTION: Record<string, "direct" | "representative"> = {
  当社: "direct", 当社が分配: "direct", 直接: "direct", direct: "direct",
  代表: "representative", 代表が分配: "representative", 代表者: "representative", representative: "representative"
};

export interface PubWorkRow {
  line: number;
  label: string;
  title: string;
  work: { id: number; code: string | null; title: string } | null;   // 既存。null なら作る
  newWork: { title: string; titleKana: string | null; workCode: string | null; remarks: string | null;
             copyrightNotice: string | null; thirdPartyRights: string | null; businessLine: string | null } | null;
  party: { id: number; name: string };
  agreementId: number | null;
  print: { ratePct: number; exclusivity: "exclusive" | "non_exclusive" | null } | null;
  digital: { ratePct: number; exclusivity: "exclusive" | "non_exclusive" | null } | null;
  termStart: string | null; termEnd: string | null;
  paymentTerms: string | null; notes: string | null;
  scopes: ConditionScope[];
  shares: Array<{ partyId: number; name: string; sharePpm: number }>;
  distribution: "direct" | "representative" | null;
  cids: string[];
}

const text = (row: Record<string, string>, header: string) => String(row[header] ?? "").trim();

function csvDate(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) throw new DomainError("VALIDATION", `日付は 2026-10-01 か 2026/10/01 の形で入れてください（"${s}"）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function ratePct(value: string, header: string): number | null {
  const s = value.trim().replace(/[%％]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new DomainError("VALIDATION", `${header}は 0〜100（%）で入れてください（"${value.trim()}"）`);
  }
  return n;
}

/**
 * 取り分の列。「作家B 10／作家C 5」のように 名前 と 数 の組を ／ ; | で区切る。
 * 数は電子（無ければ紙）の料率を分けた率で、合計がその料率と同じなら比に直す。
 * 合計が 100 なら比率（%）として読む。どちらでもなければ止める。
 */
export function parseShareText(value: string, wholeRatePct: number | null): Array<{ name: string; ppm: number }> {
  const s = value.trim();
  if (!s) return [];
  const parts = s.split(/[／/;|｜]/).map((p) => p.trim()).filter(Boolean);
  const pairs = parts.map((p) => {
    const m = p.match(/^(.+?)[\s　:：]+([0-9]+(?:\.[0-9]+)?)\s*[%％]?$/);
    if (!m) throw new DomainError("VALIDATION", `取り分は「名前 10／名前 5」のように入れてください（"${p}"）`);
    return { name: m[1].trim(), value: Number(m[2]) };
  });
  const sum = pairs.reduce((a, p) => a + p.value, 0);
  const close = (a: number, b: number) => Math.abs(a - b) < 0.0001;
  let ppm: number[];
  if (wholeRatePct !== null && close(sum, wholeRatePct)) {
    ppm = pairs.map((p) => Math.round((p.value / wholeRatePct) * SHARE_TOTAL_PPM));
  } else if (close(sum, 100)) {
    ppm = pairs.map((p) => Math.round(p.value * 10000));
  } else {
    throw new DomainError("VALIDATION",
      `取り分の合計が合いません（${sum}）。電子（無ければ紙）の料率${wholeRatePct === null ? "" : ` ${wholeRatePct}%`} と同じか、比率なら 100 にしてください`);
  }
  const total = ppm.reduce((a, b) => a + b, 0);
  if (ppm.length && Math.abs(total - SHARE_TOTAL_PPM) <= ppm.length * 2) ppm[ppm.length - 1] += SHARE_TOTAL_PPM - total;
  return pairs.map((p, i) => ({ name: p.name, ppm: ppm[i] }));
}

export class PubWorksImportService {
  constructor(private readonly database: Transactable, private readonly deps: PubWorksDeps) {}

  async run(raw: Array<Record<string, string>>, dryRun: boolean, actor: string): Promise<ImportReport> {
    const outcomes: RowOutcome[] = [];
    // 同じ CSV の前の行で作る作品名（試算では「新規」として扱う）。
    const madeTitles = new Set<string>();
    for (const [index, row] of raw.entries()) {
      const line = index + 2;
      const label = text(row, "作品名") || `${line} 行目`;
      try {
        const parsed = await this.parseRow(line, row);
        const summary = this.describe(parsed);
        if (dryRun) {
          const dup = await this.duplicateOf(parsed);
          outcomes.push(dup
            ? { line, status: "duplicate", label, message: dup }
            : { line, status: "ok", label, message: summary });
          madeTitles.add(parsed.title.toLowerCase());
          continue;
        }
        const dup = await this.duplicateOf(parsed);
        if (dup) { outcomes.push({ line, status: "duplicate", label, message: dup }); continue; }
        const made = await this.write(parsed, actor);
        outcomes.push({ line, status: "ok", label, id: made.workId, code: made.workCode,
                        message: `${summary}／条件 ${made.conditionNos.join("・")}` });
      } catch (error) {
        const e = error as DomainError;
        outcomes.push({ line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label,
                        message: e?.message ?? "登録に失敗しました" });
      }
    }
    return {
      kind: "pub_works", mode: "create", dryRun, total: outcomes.length,
      ok: outcomes.filter((r) => r.status === "ok").length,
      duplicate: outcomes.filter((r) => r.status === "duplicate").length,
      skipped: 0,
      error: outcomes.filter((r) => r.status === "error").length,
      rows: outcomes
    };
  }

  private describe(p: PubWorkRow): string {
    const parts = [
      p.work ? `既存の作品 ${p.work.code ?? ""}`.trim() : "作品を新しく作る",
      [p.print ? `紙 ${p.print.ratePct}%` : null, p.digital ? `電子 ${p.digital.ratePct}%` : null].filter(Boolean).join("・"),
      `相手先 ${p.party.name}`
    ];
    if (p.shares.length) {
      parts.push(`取り分 ${p.shares.map((s) => `${s.name} ${Math.round(s.sharePpm / 100) / 100}%`).join("／")}`
        + `（${p.distribution === "representative" ? "代表が分配" : "当社が分配"}）`);
    }
    if (p.cids.length) parts.push(`CID ${p.cids.length} 件`);
    return parts.join("・");
  }

  /** 既存の作品に、同じ相手先の紙・電子の条件がもうあれば重複。 */
  private async duplicateOf(p: PubWorkRow): Promise<string | null> {
    if (!p.work) return null;
    const usages = [p.print ? "pub_print" : null, p.digital ? "pub_digital" : null].filter(Boolean) as string[];
    const r = await this.database.query(
      `SELECT condition_no, usage_type FROM conditions
        WHERE work_id = $1 AND counterparty_id = $2 AND direction = 'in' AND kind = 'license'
          AND status IN ('active', 'scheduled') AND usage_type = ANY($3::text[])`,
      [p.work.id, p.party.id, usages]);
    const hits = r.rows as Array<{ condition_no: string | null; usage_type: string }>;
    if (!hits.length) return null;
    return `${p.party.name} の ${hits.map((h) => `${h.usage_type === "pub_print" ? "紙" : "電子"}（${h.condition_no ?? "番号なし"}）`).join("・")}が既にあります。この行は飛ばされます`;
  }

  private async write(p: PubWorkRow, actor: string): Promise<{ workId: number; workCode: string | null; conditionNos: string[] }> {
    let workId: number;
    let workCode: string | null;
    if (p.work) { workId = p.work.id; workCode = p.work.code; }
    else {
      const made = await this.deps.works.create({
        title: p.newWork!.title, titleKana: p.newWork!.titleKana, kind: "own", status: "released",
        businessLine: p.newWork!.businessLine, remarks: p.newWork!.remarks, workCode: p.newWork!.workCode,
        copyrightNotice: p.newWork!.copyrightNotice, thirdPartyRights: p.newWork!.thirdPartyRights
      }, actor);
      workId = made.id; workCode = made.workCode;
    }
    const set = await this.deps.conditions.createPublishingSet({
      counterpartyId: p.party.id, workId, agreementId: p.agreementId,
      termStart: p.termStart, termEnd: p.termEnd, paymentTerms: p.paymentTerms, notes: p.notes,
      scopes: p.scopes, print: p.print, digital: p.digital
    }, actor);
    const conditionNos = [set.print, set.digital].filter(Boolean).map((c) => c!.conditionNo ?? `#${c!.id}`);
    if (p.shares.length) {
      const target = set.digital ?? set.print;
      if (target) {
        await this.deps.conditions.replaceShares(target.id,
          p.shares.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm })), actor, p.distribution, { applyToWork: true });
      }
    }
    for (const cid of p.cids) {
      await this.database.query(
        `INSERT INTO ebook_work_codes (cid, work_id, title, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cid) DO UPDATE SET work_id = EXCLUDED.work_id, title = EXCLUDED.title, created_by = EXCLUDED.created_by`,
        [cid, workId, p.title, actor]);
    }
    await recordAudit(this.database, {
      actor, action: "pub_works.import", targetType: "work", targetId: workId,
      detail: { newWork: !p.work, conditionNos, shares: p.shares.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm })),
                distribution: p.distribution, cids: p.cids }
    });
    return { workId, workCode, conditionNos };
  }

  private async parseRow(line: number, row: Record<string, string>): Promise<PubWorkRow> {
    const title = text(row, "作品名");
    if (!title) throw new DomainError("VALIDATION", "作品名が空です");
    const print = ratePct(text(row, "紙料率"), "紙料率");
    const digital = ratePct(text(row, "電子料率"), "電子料率");
    if (print === null && digital === null) throw new DomainError("VALIDATION", "紙料率か電子料率のどちらかは入れてください");
    const exclText = text(row, "独占");
    if (exclText && !EXCLUSIVITY[exclText]) throw new DomainError("VALIDATION", `独占は「独占」か「非独占」です（"${exclText}"）`);
    const exclusivity = exclText ? EXCLUSIVITY[exclText] : "non_exclusive";
    const distText = text(row, "分配");
    if (distText && !DISTRIBUTION[distText]) throw new DomainError("VALIDATION", `分配は「当社」か「代表」です（"${distText}"）`);

    // 作品：コードか作品名で当たれば既存。無ければ作る。
    const code = text(row, "作品コード");
    const hits = (await this.database.query(
      `SELECT id, work_code, title FROM works
        WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
           OR ($1 = '' AND btrim(title) = btrim($2))
        LIMIT 3`, [code, title])).rows as Array<{ id: number; work_code: string | null; title: string }>;
    if (hits.length > 1) throw new DomainError("VALIDATION", `作品「${code || title}」が複数当たります。作品コードで指定してください`);
    const work = hits[0] ? { id: Number(hits[0].id), code: hits[0].work_code, title: String(hits[0].title) } : null;

    const party = await this.findParty(text(row, "相手先コード"), text(row, "相手先"), "相手先");
    let agreementId: number | null = null;
    const agreementNo = text(row, "契約番号");
    if (agreementNo) {
      const a = (await this.database.query(
        "SELECT id, counterparty_id AS cp FROM agreements WHERE lower(btrim(agreement_no)) = lower(btrim($1)) LIMIT 2",
        [agreementNo])).rows as Array<{ id: number; cp: number }>;
      if (a.length !== 1) throw new DomainError("VALIDATION", `契約番号 ${agreementNo} が${a.length ? "複数当たります" : "見つかりません"}`);
      if (Number(a[0].cp) !== party.id) throw new DomainError("VALIDATION", `契約 ${agreementNo} は ${party.name} の契約ではありません`);
      agreementId = Number(a[0].id);
    }

    // 取り分。電子（無ければ紙）の料率を分けた率で読む。
    const shareText = text(row, "取り分");
    const parsedShares = parseShareText(shareText, digital ?? print);
    const shares: PubWorkRow["shares"] = [];
    for (const s of parsedShares) {
      const p = await this.findParty("", s.name, "取り分の権利者");
      shares.push({ partyId: p.id, name: p.name, sharePpm: s.ppm });
    }
    validateShareInput(shares);
    const distribution = shares.length ? (distText ? DISTRIBUTION[distText] : "direct") : null;
    if (distribution === "representative" && !shares.some((s) => s.partyId === party.id)) {
      throw new DomainError("VALIDATION", "代表が分配する契約では、相手先（代表）を取り分の中に入れてください");
    }
    if (!shares.length && distText) {
      throw new DomainError("VALIDATION", "分配を入れるなら取り分も入れてください");
    }

    const cids = text(row, "CID").split(/[／/;|｜,、\s]+/).map((c) => c.trim()).filter(Boolean);
    const scopes: ConditionScope[] = [
      ...parseRegions(text(row, "地域")).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
      ...parseLanguages(text(row, "言語")).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
    ];
    return {
      line, label: title, title, work,
      newWork: work ? null : {
        title, titleKana: text(row, "カナ") || null, workCode: code || null, remarks: text(row, "作品備考") || null,
        copyrightNotice: text(row, "著作権表示") || null, thirdPartyRights: text(row, "第三者権利") || null,
        businessLine: text(row, "事業区分") || "出版"
      },
      party, agreementId,
      print: print === null ? null : { ratePct: print, exclusivity },
      digital: digital === null ? null : { ratePct: digital, exclusivity },
      termStart: csvDate(text(row, "開始日")), termEnd: csvDate(text(row, "終了日")),
      paymentTerms: text(row, "支払条件") || null, notes: text(row, "備考") || null,
      scopes, shares, distribution, cids
    };
  }

  private async findParty(code: string, name: string, what: string): Promise<{ id: number; name: string }> {
    if (!code && !name) throw new DomainError("VALIDATION", `${what}が空です`);
    const r = await this.database.query(
      `SELECT id, name FROM parties
        WHERE status <> 'merged'
          AND (($1 <> '' AND lower(btrim(party_code)) = lower(btrim($1)))
            OR ($2 <> '' AND (btrim(name) = btrim($2) OR btrim(COALESCE(name_kana, '')) = btrim($2)
                              OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE btrim(a) = btrim($2)))))
        LIMIT 3`, [code, name]);
    const rows = r.rows as Array<{ id: number; name: string }>;
    if (rows.length === 1) return { id: Number(rows[0].id), name: String(rows[0].name) };
    throw new DomainError("VALIDATION", rows.length
      ? `${what}「${code || name}」が複数当たります。コードで指定してください`
      : `${what}「${code || name}」が見つかりません。先に取引先を登録してください`);
  }
}

export const PUB_WORKS_SAMPLE =
  "作品名,作品コード,カナ,相手先,相手先コード,紙料率,電子料率,独占,取り分,分配,CID,契約番号,開始日,終了日,支払条件,地域,言語,著作権表示,第三者権利,備考\n" +
  "サタスペ エキスパンション デッドマン・ウォーキング,,,冒険支援株式会社,,10,15,非独占,,,BT000105758300100101,,2009-12-22,2031-09-30,,,日本語,© 冒険企画局 © 河嶋陶一朗,著：河嶋陶一朗,\n" +
  "光砕のリヴァルチャー,,,瀧里フユ,,10,15,非独占,瀧里フユ 11.25／宝井ロメロ 3.75,当社,BT000110567300100101,,2025-07-01,,,,日本語,,,\n" +
  "神我狩 ストーリー＆データ集 神化の誓約,,,合同会社ダックルーズ,,10,15,非独占,合同会社ダックルーズ 10／力造 5,代表,,,2025-07-01,,,,日本語,,,";
