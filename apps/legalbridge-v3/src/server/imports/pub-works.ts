import type { Queryable, Transactable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionScope } from "../core/model.js";
import { SHARE_TOTAL_PPM, loadShares, validateShareInput } from "../royalty/shares.js";
import { toCsv } from "../exports/csv.js";
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
 *
 * 既存の作品の一括修正（mode = update）も同じ列で受ける。作品コード（無ければ作品名）で
 * 作品に当て、書いてある列だけを直す：料率・独占・期間・支払条件・備考は紙・電子の
 * 条件に、取り分・分配は電子（無ければ紙）の条件から作品全体に、CID は作品に、
 * カナ・著作権表示・第三者権利・作品備考・事業区分は作品に。空欄の列は触らない。
 * 料率が書いてあって条件が無い媒体は、その媒体の条件を新しく作る。
 * 取り分を消すときは「なし」。書き出し（exportCsv）は同じ列で出すので、
 * 書き出して直してそのまま取り込める。
 */

export interface PubWorkPatch {
  titleKana?: string | null; businessLine?: string | null; remarks?: string | null;
  copyrightNotice?: string | null; thirdPartyRights?: string | null;
}
export interface PubConditionPatch {
  ratePpm?: number; exclusivity?: "exclusive" | "non_exclusive";
  termStart?: string | null; termEnd?: string | null; paymentTerms?: string | null; notes?: string | null;
}

export interface PubWorksDeps {
  works: {
    create(input: { title: string; titleKana?: string | null; kind?: "own"; status?: "released";
                    businessLine?: string | null; remarks?: string | null; workCode?: string | null;
                    copyrightNotice?: string | null; thirdPartyRights?: string | null }, actor: string):
      Promise<{ id: number; workCode: string | null }>;
    update(id: number, patch: PubWorkPatch, actor: string): Promise<unknown>;
  };
  conditions: {
    updateEconomics(id: number, patch: PubConditionPatch, actor: string, effectiveFrom: string | null): Promise<unknown>;
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
    replaceScopes(id: number, scopes: ConditionScope[], actor: string): Promise<unknown>;
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

interface PubCondition {
  id: number; conditionNo: string | null; usageType: string; ratePpm: number | null;
  exclusivity: string | null; counterpartyId: number; partyName: string;
}

const text = (row: Record<string, string>, header: string) => String(row[header] ?? "").trim();
/** 小数 4 桁までで、末尾の 0 を落とす（15 → "15"、11.25 → "11.25"）。 */
const trimNumber = (n: number) => String(Number(n.toFixed(4)));

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
 * 取り分の列。「作家B（V-0102） 10／作家C（V-0103） 5」のように 名前（取引先コード） と 数 の組を
 * ／ ; | で区切る。権利者は取引先コードで当て、名前は登録の名前と照らす（同姓同名や表記違いを
 * 間違って払わないため）。コードが無ければ止める。
 * 数は電子（無ければ紙）の料率を分けた率で、合計がその料率と同じなら比に直す。
 * 合計が 100 なら比率（%）として読む。どちらでもなければ止める。
 */
export function parseShareText(
  value: string, wholeRatePct: number | null
): Array<{ name: string; code: string; ppm: number }> {
  const s = value.trim();
  if (!s) return [];
  const parts = s.split(/[／/;|｜]/).map((p) => p.trim()).filter(Boolean);
  const pairs = parts.map((p) => {
    const m = p.match(/^(.+?)[\s　:：]+([0-9]+(?:\.[0-9]+)?)\s*[%％]?$/);
    if (!m) {
      throw new DomainError("VALIDATION", `取り分は「名前（取引先コード） 10／名前（取引先コード） 5」のように入れてください（"${p}"）`);
    }
    const who = m[1].trim();
    const coded = who.match(/^(.*?)\s*[（(]\s*([^（）()]+?)\s*[）)]$/);
    if (!coded || !coded[2].trim()) {
      throw new DomainError("VALIDATION",
        `取り分の権利者「${who}」に取引先コードがありません。「名前（取引先コード） 率」の形で入れてください`);
    }
    return { name: coded[1].trim(), code: coded[2].trim(), value: Number(m[2]) };
  });
  const sum = pairs.reduce((a, p) => a + p.value, 0);
  // 書き出した率は小数 4 桁に丸めてあるので、その分の誤差は同じとみなす。
  const close = (a: number, b: number) => Math.abs(a - b) < 0.005;
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
  if (ppm.length && Math.abs(total - SHARE_TOTAL_PPM) <= ppm.length * 10) ppm[ppm.length - 1] += SHARE_TOTAL_PPM - total;
  return pairs.map((p, i) => ({ name: p.name, code: p.code, ppm: ppm[i] }));
}

export class PubWorksImportService {
  constructor(private readonly database: Transactable, private readonly deps: PubWorksDeps) {}

  async run(raw: Array<Record<string, string>>, dryRun: boolean, actor: string,
            mode: "create" | "update" = "create"): Promise<ImportReport> {
    if (mode === "update") return this.runUpdate(raw, dryRun, actor);
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

  // ---- 既存の作品の一括修正（update） -------------------------------------

  private async runUpdate(raw: Array<Record<string, string>>, dryRun: boolean, actor: string): Promise<ImportReport> {
    const outcomes: RowOutcome[] = [];
    for (const [index, row] of raw.entries()) {
      const line = index + 2;
      const label = text(row, "作品名") || text(row, "作品コード") || `${line} 行目`;
      try {
        outcomes.push({ line, label, ...(await this.updateRow(row, dryRun, actor)) });
      } catch (error) {
        const e = error as DomainError;
        outcomes.push({ line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label,
                        message: e?.message ?? "更新に失敗しました" });
      }
    }
    return {
      kind: "pub_works", mode: "update", dryRun, total: outcomes.length,
      ok: outcomes.filter((r) => r.status === "ok").length,
      duplicate: outcomes.filter((r) => r.status === "duplicate").length,
      skipped: outcomes.filter((r) => r.status === "skip").length,
      error: outcomes.filter((r) => r.status === "error").length,
      rows: outcomes
    };
  }

  /** 既存の作品の紙・電子の IN 許諾条件（有効・予定）。 */
  private async pubConditionsOf(workId: number, partyId: number | null): Promise<PubCondition[]> {
    const r = await this.database.query(
      `SELECT c.id, c.condition_no, c.usage_type, c.rate_ppm, c.exclusivity, c.counterparty_id, p.name AS party_name
         FROM conditions c LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE c.work_id = $1 AND c.direction = 'in' AND c.kind = 'license'
          AND c.status IN ('active', 'scheduled') AND c.usage_type IN ('pub_print', 'pub_digital')
          AND ($2::bigint IS NULL OR c.counterparty_id = $2)
        ORDER BY c.id`, [workId, partyId]);
    return (r.rows as Array<Record<string, any>>).map((row) => ({
      id: Number(row.id), conditionNo: row.condition_no ?? null, usageType: String(row.usage_type),
      ratePpm: row.rate_ppm === null || row.rate_ppm === undefined ? null : Number(row.rate_ppm),
      exclusivity: row.exclusivity ?? null,
      counterpartyId: Number(row.counterparty_id), partyName: String(row.party_name ?? "")
    }));
  }

  private async updateRow(row: Record<string, string>, dryRun: boolean, actor: string): Promise<Omit<RowOutcome, "line" | "label">> {
    const title = text(row, "作品名");
    const code = text(row, "作品コード");
    if (!title && !code) throw new DomainError("VALIDATION", "作品コードか作品名が空です");
    const hits = (await this.database.query(
      `SELECT id, work_code, title FROM works
        WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
           OR ($1 = '' AND btrim(title) = btrim($2))
        LIMIT 3`, [code, title])).rows as Array<{ id: number; work_code: string | null; title: string }>;
    if (hits.length > 1) throw new DomainError("VALIDATION", `作品「${code || title}」が複数当たります。作品コードで指定してください`);
    if (!hits[0]) {
      throw new DomainError("VALIDATION",
        `作品「${code || title}」が見つかりません。新しく作るなら「新しく登録する」で取り込んでください`);
    }
    const work = { id: Number(hits[0].id), code: hits[0].work_code, title: String(hits[0].title) };
    const who = `作品 ${work.code ?? work.title}`;

    // 相手先は任意。書いてあればその相手先の条件だけを直す（同じ作品に別の相手先の条件があるとき用）。
    const partyText = text(row, "相手先") || text(row, "相手先コード");
    const party = partyText ? await this.findParty(text(row, "相手先コード"), text(row, "相手先"), "相手先") : null;
    const existing = await this.pubConditionsOf(work.id, party?.id ?? null);
    const pick = (usage: string): PubCondition | null => {
      const found = existing.filter((c) => c.usageType === usage);
      if (found.length > 1) {
        throw new DomainError("VALIDATION",
          `${who} の${usage === "pub_print" ? "紙" : "電子"}の条件が複数あります（${found.map((c) => `${c.partyName} ${c.conditionNo ?? `#${c.id}`}`).join("・")}）。相手先で指定してください`);
      }
      return found[0] ?? null;
    };
    const printCond = pick("pub_print");
    const digitalCond = pick("pub_digital");

    // 作品そのものの列。
    const workPatch: PubWorkPatch = {};
    const workChanged: string[] = [];
    const putWork = (header: string, key: keyof PubWorkPatch) => {
      const v = text(row, header);
      if (v) { workPatch[key] = v; workChanged.push(header); }
    };
    putWork("カナ", "titleKana"); putWork("著作権表示", "copyrightNotice"); putWork("第三者権利", "thirdPartyRights");
    putWork("作品備考", "remarks"); putWork("事業区分", "businessLine");

    // 条件の列（紙・電子に同じものを当てる）。
    const print = ratePct(text(row, "紙料率"), "紙料率");
    const digital = ratePct(text(row, "電子料率"), "電子料率");
    const exclText = text(row, "独占");
    if (exclText && !EXCLUSIVITY[exclText]) throw new DomainError("VALIDATION", `独占は「独占」か「非独占」です（"${exclText}"）`);
    const common: PubConditionPatch = {};
    const commonChanged: string[] = [];
    if (exclText) { common.exclusivity = EXCLUSIVITY[exclText]; commonChanged.push("独占"); }
    if (text(row, "開始日")) { common.termStart = csvDate(text(row, "開始日")); commonChanged.push("開始日"); }
    if (text(row, "終了日")) { common.termEnd = csvDate(text(row, "終了日")); commonChanged.push("終了日"); }
    if (text(row, "支払条件")) { common.paymentTerms = text(row, "支払条件"); commonChanged.push("支払条件"); }
    if (text(row, "備考")) { common.notes = text(row, "備考"); commonChanged.push("備考"); }
    const scopes: ConditionScope[] = [
      ...parseRegions(text(row, "地域")).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
      ...parseLanguages(text(row, "言語")).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
    ];

    type Plan = { cond: PubCondition; patch: PubConditionPatch; what: string[] };
    const plans: Plan[] = [];
    const creates: Array<{ usage: "pub_print" | "pub_digital"; ratePct: number }> = [];
    const planFor = (cond: PubCondition | null, usage: "pub_print" | "pub_digital", rate: number | null) => {
      if (!cond) {
        if (rate !== null) creates.push({ usage, ratePct: rate });
        return;
      }
      const patch: PubConditionPatch = { ...common };
      const what = [...commonChanged];
      if (rate !== null) {
        const ppm = Math.round(rate * 10000);
        if (ppm !== cond.ratePpm) { patch.ratePpm = ppm; what.push(`料率 ${rate}%`); }
      }
      if (patch.exclusivity && patch.exclusivity === cond.exclusivity) { delete patch.exclusivity; what.splice(what.indexOf("独占"), 1); }
      if (what.length) plans.push({ cond, patch, what });
    };
    planFor(printCond, "pub_print", print);
    planFor(digitalCond, "pub_digital", digital);
    // 条件が無い媒体に料率が書いてあれば、その媒体の条件を作る。相手先は列か、もう片方の条件から。
    const createParty = party ?? (existing[0] ? { id: existing[0].counterpartyId, name: existing[0].partyName } : null);
    if (creates.length && !createParty) {
      throw new DomainError("VALIDATION", `${who} に${creates.map((c) => c.usage === "pub_print" ? "紙" : "電子").join("・")}の条件がありません。作るなら相手先を入れてください`);
    }

    // 取り分・分配。電子（無ければ紙）の条件から作品全体に入れる。
    const shareText = text(row, "取り分");
    const distText = text(row, "分配");
    if (distText && !DISTRIBUTION[distText]) throw new DomainError("VALIDATION", `分配は「当社」か「代表」です（"${distText}"）`);
    const wholeRate = digital ?? (digitalCond?.ratePpm !== null && digitalCond?.ratePpm !== undefined ? digitalCond.ratePpm / 10000 : null)
      ?? print ?? (printCond?.ratePpm !== null && printCond?.ratePpm !== undefined ? printCond.ratePpm / 10000 : null);
    let shares: Array<{ partyId: number; name: string; sharePpm: number }> | null = null;   // null = 触らない
    if (/^(なし|無し|none|clear)$/i.test(shareText)) shares = [];
    else if (shareText) {
      shares = [];
      for (const s of parseShareText(shareText, wholeRate)) {
        const p = await this.findShareParty(s.code, s.name);
        shares.push({ partyId: p.id, name: p.name, sharePpm: s.ppm });
      }
      validateShareInput(shares);
    }
    const shareTarget = digitalCond ?? printCond;
    const shareTargetUsage: "pub_print" | "pub_digital" | null = digitalCond ? "pub_digital" : printCond ? "pub_print" : null;
    let distribution: "direct" | "representative" | null = distText ? DISTRIBUTION[distText] : null;
    if (shares === null && distribution) {
      // 分配のスイッチだけ替える：いまの取り分をそのまま入れ直す。
      if (!shareTarget) throw new DomainError("VALIDATION", `${who} に条件が無いので分配は替えられません`);
      const cur = await loadShares(this.database, shareTarget.id);
      if (!cur.length) throw new DomainError("VALIDATION", "分配を入れるなら取り分も入れてください（いまは取り分がありません）");
      shares = cur.map((s) => ({ partyId: s.partyId, name: s.partyName, sharePpm: s.sharePpm }));
    }
    if (shares && shares.length && !distribution) distribution = "direct";
    const representative = createParty ?? (shareTarget ? { id: shareTarget.counterpartyId, name: shareTarget.partyName } : null);
    if (distribution === "representative" && shares && shares.length && representative && !shares.some((s) => s.partyId === representative.id)) {
      throw new DomainError("VALIDATION", "代表が分配する契約では、相手先（代表）を取り分の中に入れてください");
    }
    if (shares && !shareTarget && !creates.length) {
      throw new DomainError("VALIDATION", `${who} に紙・電子の条件が無いので取り分は入れられません。料率も入れて条件を作ってください`);
    }

    const cids = text(row, "CID").split(/[／/;|｜,、\s]+/).map((c) => c.trim()).filter(Boolean);

    // 読み上げ。
    const parts: string[] = [];
    if (workChanged.length) parts.push(`作品の${workChanged.join("・")}`);
    for (const plan of plans) {
      parts.push(`${plan.cond.usageType === "pub_print" ? "紙" : "電子"}（${plan.cond.conditionNo ?? `#${plan.cond.id}`}）の${plan.what.join("・")}`);
    }
    for (const c of creates) parts.push(`${c.usage === "pub_print" ? "紙" : "電子"}の条件を新しく作る（${c.ratePct}%・相手先 ${createParty!.name}）`);
    if (scopes.length) parts.push(`地域・言語（${scopes.map((s) => s.label).join("、")}）`);
    if (shares) {
      parts.push(shares.length
        ? `取り分 ${shares.map((s) => `${s.name} ${Math.round(s.sharePpm / 100) / 100}%`).join("／")}（${distribution === "representative" ? "代表が分配" : "当社が分配"}）`
        : "取り分を消す");
    }
    if (cids.length) parts.push(`CID ${cids.length} 件`);
    if (!parts.length) {
      return { status: "skip", id: work.id, code: work.code, message: `${who}：当てる項目がありません（空欄の列は触りません）` };
    }
    const summary = parts.join("・");
    if (dryRun) return { status: "ok", id: work.id, code: work.code, message: `${who} の ${summary} を更新します` };

    // 書く。
    if (workChanged.length) await this.deps.works.update(work.id, workPatch, actor);
    for (const plan of plans) {
      await this.deps.conditions.updateEconomics(plan.cond.id, plan.patch, actor, null);
    }
    let madeDigital: { id: number } | null = null;
    let madePrint: { id: number } | null = null;
    if (creates.length) {
      const wantPrint = creates.find((c) => c.usage === "pub_print");
      const wantDigital = creates.find((c) => c.usage === "pub_digital");
      const set = await this.deps.conditions.createPublishingSet({
        counterpartyId: createParty!.id, workId: work.id,
        termStart: common.termStart ?? null, termEnd: common.termEnd ?? null,
        paymentTerms: common.paymentTerms ?? null, notes: common.notes ?? null, scopes,
        print: wantPrint ? { ratePct: wantPrint.ratePct, exclusivity: common.exclusivity ?? "non_exclusive" } : null,
        digital: wantDigital ? { ratePct: wantDigital.ratePct, exclusivity: common.exclusivity ?? "non_exclusive" } : null
      }, actor);
      madePrint = set.print; madeDigital = set.digital;
    }
    if (scopes.length) {
      for (const cond of [printCond, digitalCond]) {
        if (cond) await this.deps.conditions.replaceScopes(cond.id, scopes, actor);
      }
    }
    if (shares) {
      const target = (shareTargetUsage === "pub_digital" ? shareTarget : madeDigital ?? shareTarget ?? madePrint) ?? null;
      if (target) {
        await this.deps.conditions.replaceShares(target.id,
          shares.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm })), actor, distribution, { applyToWork: true });
      }
    }
    for (const cid of cids) {
      await this.database.query(
        `INSERT INTO ebook_work_codes (cid, work_id, title, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cid) DO UPDATE SET work_id = EXCLUDED.work_id, title = EXCLUDED.title, created_by = EXCLUDED.created_by`,
        [cid, work.id, work.title, actor]);
    }
    await recordAudit(this.database, {
      actor, action: "pub_works.update", targetType: "work", targetId: work.id,
      detail: { summary, shares: shares?.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm })) ?? null,
                distribution, cids }
    });
    return { status: "ok", id: work.id, code: work.code, message: `${who} の ${summary} を更新しました` };
  }

  // ---- 書き出し ----------------------------------------------------------

  /**
   * 登録済みの出版作品を取込と同じ列で出す。作品 × 相手先で 1 行（紙・電子をまとめる）。
   * 直して「登録済みに当てる」で取り込める。取り分は電子（無ければ紙）の料率を分けた率。
   */
  async exportCsv(): Promise<string> {
    const r = await this.database.query(
      `SELECT w.id AS work_id, w.title, w.work_code, w.title_kana, w.business_line, w.remarks AS work_remarks,
              to_jsonb(w) ->> 'copyright_notice' AS copyright_notice, to_jsonb(w) ->> 'third_party_rights' AS third_party_rights,
              c.id, c.usage_type, c.rate_ppm, c.exclusivity, c.counterparty_id, p.name AS party_name,
              to_jsonb(p) ->> 'party_code' AS party_code,
              ag.agreement_no, c.term_start, c.term_end, c.payment_terms, c.notes,
              to_jsonb(c) ->> 'distribution' AS distribution
         FROM conditions c
         JOIN works w ON w.id = c.work_id
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN agreements ag ON ag.id = c.agreement_id
        WHERE c.direction = 'in' AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
          AND c.usage_type IN ('pub_print', 'pub_digital')
        ORDER BY w.title, w.id, c.counterparty_id, c.id`);
    const conds = r.rows as Array<Record<string, any>>;
    const ids = conds.map((c) => Number(c.id));
    const workIds = [...new Set(conds.map((c) => Number(c.work_id)))];
    const shareRows = ids.length ? (await this.database.query(
      `SELECT s.condition_id, sp.name, sp.party_code, s.share_ppm FROM condition_shares s JOIN parties sp ON sp.id = s.party_id
        WHERE s.condition_id = ANY($1::bigint[]) ORDER BY s.sort_order, s.id`, [ids])).rows as Array<Record<string, any>> : [];
    const scopeRows = ids.length ? (await this.database.query(
      `SELECT condition_id, scope_type, label FROM condition_scopes WHERE condition_id = ANY($1::bigint[]) ORDER BY sort_order, label`,
      [ids])).rows as Array<Record<string, any>> : [];
    const cidRows = workIds.length ? (await this.database.query(
      `SELECT work_id, cid FROM ebook_work_codes WHERE work_id = ANY($1::bigint[]) ORDER BY cid`, [workIds])).rows as Array<Record<string, any>> : [];

    const groupBy = <T,>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const row of rows) { const k = key(row); m.set(k, [...(m.get(k) ?? []), row]); }
      return m;
    };
    const sharesOf = groupBy(shareRows, (s) => String(s.condition_id));
    const scopesOf = groupBy(scopeRows, (s) => String(s.condition_id));
    const cidsOf = groupBy(cidRows, (s) => String(s.work_id));
    const groups = groupBy(conds, (c) => `${c.work_id}:${c.counterparty_id}`);

    const date = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : "");
    const pct = (ppm: unknown) => (ppm === null || ppm === undefined ? "" : trimNumber(Number(ppm) / 10000));
    const rows = [...groups.values()].map((list) => {
      const printC = list.find((c) => c.usage_type === "pub_print") ?? null;
      const digitalC = list.find((c) => c.usage_type === "pub_digital") ?? null;
      const main = digitalC ?? printC!;
      const whole = main.rate_ppm === null || main.rate_ppm === undefined ? null : Number(main.rate_ppm) / 10000;
      const shares = sharesOf.get(String(main.id)) ?? [];
      const shareText = whole === null ? "" : shares
        // 取引先コードの無い権利者はそのまま出す（取り込むときに「コードがありません」で止まる）。
        .map((s) => `${s.name}${s.party_code ? `（${s.party_code}）` : ""} ${trimNumber((whole * Number(s.share_ppm)) / SHARE_TOTAL_PPM)}`)
        .join("／");
      const scopes = scopesOf.get(String(main.id)) ?? [];
      return {
        "作品名": String(main.title ?? ""), "作品コード": main.work_code ?? "", "カナ": main.title_kana ?? "",
        "相手先": main.party_name ?? "", "相手先コード": main.party_code ?? "",
        "紙料率": printC ? pct(printC.rate_ppm) : "", "電子料率": digitalC ? pct(digitalC.rate_ppm) : "",
        "独占": main.exclusivity === "exclusive" ? "独占" : main.exclusivity === "non_exclusive" ? "非独占" : "",
        "取り分": shareText,
        "分配": shares.length ? (main.distribution === "representative" ? "代表" : "当社") : "",
        "CID": (cidsOf.get(String(main.work_id)) ?? []).map((c) => String(c.cid)).join("／"),
        "契約番号": main.agreement_no ?? "", "開始日": date(main.term_start), "終了日": date(main.term_end),
        "支払条件": main.payment_terms ?? "",
        "地域": scopes.filter((s) => s.scope_type === "region").map((s) => String(s.label)).join("、"),
        "言語": scopes.filter((s) => s.scope_type === "language").map((s) => String(s.label)).join("、"),
        "著作権表示": main.copyright_notice ?? "", "第三者権利": main.third_party_rights ?? "",
        "備考": main.notes ?? "", "作品備考": main.work_remarks ?? "", "事業区分": main.business_line ?? ""
      };
    });
    return toCsv(PUB_WORKS_HEADERS.map((h) => ({ header: h, value: (row: Record<string, string>) => row[h] })), rows);
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
      const p = await this.findShareParty(s.code, s.name);
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

  /**
   * 取り分の権利者。取引先コードで当て、名前が登録（名称・カナ・別名）と合わなければ止める。
   * 名前だけで当てると同姓同名や表記違いで別人に払う。コードだけだと打ち間違いに気づけない。
   */
  private async findShareParty(code: string, name: string): Promise<{ id: number; name: string }> {
    const r = await this.database.query(
      `SELECT id, name, name_kana, aliases FROM parties
        WHERE status <> 'merged' AND lower(btrim(party_code)) = lower(btrim($1))
        LIMIT 2`, [code]);
    const rows = r.rows as Array<{ id: number; name: string; name_kana: string | null; aliases: string[] | null }>;
    if (rows.length !== 1) {
      throw new DomainError("VALIDATION", rows.length
        ? `取り分の権利者の取引先コード「${code}」が複数当たります`
        : `取り分の権利者の取引先コード「${code}」が見つかりません。先に取引先を登録してください`);
    }
    const hit = rows[0];
    const norm = (v: string | null | undefined) => String(v ?? "").replace(/[\s　]+/g, "");
    const names = [hit.name, hit.name_kana, ...(hit.aliases ?? [])].map(norm).filter(Boolean);
    if (name && !names.includes(norm(name))) {
      throw new DomainError("VALIDATION",
        `取り分の権利者「${name}」と取引先コード「${code}」が合いません（コード ${code} は「${hit.name}」です）`);
    }
    return { id: Number(hit.id), name: String(hit.name) };
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

export const PUB_WORKS_HEADERS = [
  "作品名", "作品コード", "カナ", "相手先", "相手先コード", "紙料率", "電子料率", "独占", "取り分", "分配", "CID",
  "契約番号", "開始日", "終了日", "支払条件", "地域", "言語", "著作権表示", "第三者権利", "備考", "作品備考", "事業区分"
];

export const PUB_WORKS_SAMPLE =
  "作品名,作品コード,カナ,相手先,相手先コード,紙料率,電子料率,独占,取り分,分配,CID,契約番号,開始日,終了日,支払条件,地域,言語,著作権表示,第三者権利,備考\n" +
  "サタスペ エキスパンション デッドマン・ウォーキング,,,冒険支援株式会社,,10,15,非独占,,,BT000105758300100101,,2009-12-22,2031-09-30,,,日本語,© 冒険企画局 © 河嶋陶一朗,著：河嶋陶一朗,\n" +
  "光砕のリヴァルチャー,,,瀧里フユ,,10,15,非独占,瀧里フユ（V-0102） 11.25／宝井ロメロ（V-0188） 3.75,当社,BT000110567300100101,,2025-07-01,,,,日本語,,,\n" +
  "神我狩 ストーリー＆データ集 神化の誓約,,,合同会社ダックルーズ,,10,15,非独占,合同会社ダックルーズ（V-0231） 10／力造（V-0232） 5,代表,,,2025-07-01,,,,日本語,,,";

export const PUB_WORKS_UPDATE_SAMPLE =
  "作品コード,作品名,相手先,紙料率,電子料率,取り分,分配,CID\n" +
  "WRK-2026-0012,,,10,15,瀧里フユ（V-0102） 11.25／宝井ロメロ（V-0188） 3.75,当社,BT000110567300100101\n" +
  ",神我狩 ストーリー＆データ集 神化の誓約,合同会社ダックルーズ,,,合同会社ダックルーズ（V-0231） 10／力造（V-0232） 5,代表,\n" +
  "WRK-2026-0030,,,,,なし,,";
