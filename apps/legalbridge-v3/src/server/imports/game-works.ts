import type { Queryable, Transactable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionScope } from "../core/model.js";
import type { EditionInput } from "../works/editions.js";
import { refuseSimilarWork } from "./similar-work.js";
import type { ImportReport, RowOutcome } from "./service.js";
import {
  GAME_EDITION_NAMES, editionColumns, editionRowLabel, readEditionColumns, writeEditionRow, type EditionRow
} from "./edition-columns.js";

/**
 * ゲーム作品の一括登録（docs/work-editions.md §6）。
 *
 * 1 行 = 作品 × 相手先（作者）。作品が無ければ作り（作品コードか作品名で当たれば既存を使う）、
 * 相手先との許諾（IN）の条件を取引モデルごとに作る（自社製造・自社販売／自社製造・他社販売／再許諾）。
 * 作者が何人もいるゲームは、同じ作品名で相手先ごとに行を足す（各作者が全額にそれぞれの料率を掛ける）。
 *
 * 製品の列（販売元・JAN・発売日・希望小売価格・販売元料率）が書いてあれば、作品の下に製品を足す。
 * 同じ JAN が同じ作品にもうあれば足さない（作者の行ごとに同じ JAN を書いてよい）。
 * 販売元料率は再許諾のとき、販売元との再許諾の条件（OUT）を作るか既存を使う。他社販売は既存の OEM の条件に繋ぐ。
 *
 * 必ず試算（dry-run）を通す。同じ CSV をもう一度流しても、条件は重複、JAN は登録済みで飛ぶ。
 */

export interface GameWorksDeps {
  works: {
    create(input: { title: string; titleKana?: string | null; kind?: "own"; status?: "released";
                    businessLine?: string | null; remarks?: string | null; workCode?: string | null;
                    copyrightNotice?: string | null; thirdPartyRights?: string | null }, actor: string):
      Promise<{ id: number; workCode: string | null }>;
  };
  conditions: {
    createLicenseSet(input: {
      counterpartyId: number; workId: number; agreementId?: number | null;
      termStart?: string | null; termEnd?: string | null; paymentTerms?: string | null; notes?: string | null;
      currency?: string; scopes?: ConditionScope[];
      rows: Array<{ usageType: "in_house" | "oem" | "sublicense"; ratePct: number; exclusivity?: "exclusive" | "non_exclusive" | null }>;
    }, actor: string): Promise<{ conditions: Array<{ usageType: string; id: number; conditionNo: string | null }> }>;
    create?(input: {
      name: string; direction: "out"; kind: "license"; usageType: "sublicense"; counterpartyId: number; workId: number;
      pricingModel: "revenue_rate"; ratePpm: number; priceBasis: "list" | "receipts" | null; statementTiming: "event" | "periodic";
      currency: string; notes?: string | null;
    }, actor: string): Promise<{ id: number; conditionNo: string | null }>;
  };
  editions?: { create(workId: number, input: EditionInput, actor: string): Promise<{ id: number }> };
}

/** 料率の列と取引モデル。 */
export const GAME_RATE_COLUMNS: Array<{ header: string; usage: "in_house" | "oem" | "sublicense"; label: string }> = [
  { header: "自社販売料率", usage: "in_house", label: "自社製造・自社販売" },
  { header: "他社販売料率", usage: "oem", label: "自社製造・他社販売" },
  { header: "再許諾料率", usage: "sublicense", label: "再許諾" }
];

export const GAME_WORKS_HEADERS = [
  "作品名", "作品コード", "カナ", "相手先", "相手先コード", ...GAME_RATE_COLUMNS.map((c) => c.header), "独占",
  "契約番号", "開始日", "終了日", "支払条件", "地域", "言語", "著作権表示", "第三者権利", "備考", "作品備考", "事業区分",
  ...editionColumns(GAME_EDITION_NAMES)
];

export const GAME_WORKS_SAMPLE =
  GAME_WORKS_HEADERS.join(",") + "\n" +
  "新作ボードゲーム,,シンサクボードゲーム,デザイナーA,V-0101,5,3,50,非独占,,2026-10-01,,,全世界,,,,,,,,,,4901234567894,2026-11-20,4400,\n" +
  "新作ボードゲーム,,,イラストB,V-0102,2,1,20,非独占,,2026-10-01,,,全世界,,,,,,,,,,4901234567894,2026-11-20,4400,\n" +
  "新作ボードゲーム,,,デザイナーA,V-0101,,,,,,,,,,,,,,,,Alpha Games,,再許諾,,2027-06-01,,30";

const EXCLUSIVITY: Record<string, "exclusive" | "non_exclusive"> = {
  独占: "exclusive", exclusive: "exclusive", 非独占: "non_exclusive", non_exclusive: "non_exclusive"
};
const text = (row: Record<string, string>, header: string) => String(row[header] ?? "").trim();

function ratePct(value: string, header: string): number | null {
  const s = value.trim().replace(/[%％]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new DomainError("VALIDATION", `${header}は 0〜100（%）で入れてください（"${value.trim()}"）`);
  return n;
}
function csvDate(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) throw new DomainError("VALIDATION", `日付は 2026-10-01 か 2026/10/01 の形で入れてください（"${s}"）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export interface GameWorkRow {
  title: string;
  work: { id: number; code: string | null } | null;
  newWork: { title: string; titleKana: string | null; workCode: string | null; remarks: string | null;
             copyrightNotice: string | null; thirdPartyRights: string | null; businessLine: string } | null;
  /** 製品だけの行（料率なし）では空でよい。 */
  party: { id: number; name: string } | null;
  agreementId: number | null;
  rates: Array<{ usage: "in_house" | "oem" | "sublicense"; label: string; ratePct: number }>;
  exclusivity: "exclusive" | "non_exclusive";
  termStart: string | null; termEnd: string | null; paymentTerms: string | null; notes: string | null;
  scopes: ConditionScope[];
  product: (EditionRow & { reuse: boolean }) | null;
}

export class GameWorksImportService {
  constructor(private readonly database: Transactable, private readonly deps: GameWorksDeps) {}

  async run(raw: Array<Record<string, string>>, dryRun: boolean, actor: string): Promise<ImportReport> {
    const outcomes: RowOutcome[] = [];
    // 同じ CSV の前の行で作る作品・足す JAN（試算では書かないので、ここで覚える）。
    const madeTitles = new Set<string>();
    const madeCodes = new Set<string>();
    for (const [index, row] of raw.entries()) {
      const line = index + 2;
      const label = text(row, "作品名") || `${line} 行目`;
      try {
        const earlier = (t: string) => madeTitles.has(t.toLowerCase());
        const p = await this.parseRow(row);
        if (!p.work && !p.rates.length && !earlier(p.title)) {
          throw new DomainError("VALIDATION", "新しい作品には料率（自社販売料率・他社販売料率・再許諾料率のどれか）を入れてください");
        }
        if (!p.rates.length && !p.product) throw new DomainError("VALIDATION", "料率か製品（販売元・JAN など）のどちらかは入れてください");
        if (p.product?.isbn && madeCodes.has(p.product.isbn)) p.product.reuse = true;
        const dup = p.rates.length ? await this.duplicateOf(p) : null;
        const parts = this.describe(p, earlier(p.title), dup);
        if (dup && !p.product) { outcomes.push({ line, status: "duplicate", label, message: dup }); continue; }
        if (!p.rates.length && p.product?.reuse) { outcomes.push({ line, status: "duplicate", label, message: "製品は登録済みです。この行は飛ばされます" }); continue; }
        if (dup && p.product?.reuse) { outcomes.push({ line, status: "duplicate", label, message: `${dup}。製品も登録済み` }); continue; }
        if (dryRun) {
          outcomes.push({ line, status: "ok", label, message: parts });
        } else {
          const made = await this.write(p, dup !== null, actor);
          outcomes.push({ line, status: "ok", label, id: made.workId, code: made.workCode,
                          message: [parts, made.conditionNos.length ? `条件 ${made.conditionNos.join("・")}` : "", made.product]
                            .filter(Boolean).join("／") });
        }
        madeTitles.add(p.title.toLowerCase());
        if (p.product?.isbn) madeCodes.add(p.product.isbn);
      } catch (error) {
        const e = error as DomainError;
        outcomes.push({ line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label, message: e?.message ?? "登録に失敗しました" });
      }
    }
    return {
      kind: "game_works", mode: "create", dryRun, total: outcomes.length,
      ok: outcomes.filter((r) => r.status === "ok").length,
      duplicate: outcomes.filter((r) => r.status === "duplicate").length,
      skipped: 0,
      error: outcomes.filter((r) => r.status === "error").length,
      rows: outcomes
    };
  }

  private describe(p: GameWorkRow, earlier: boolean, dup: string | null): string {
    const parts = [
      p.work ? `既存の作品 ${p.work.code ?? ""}`.trim() : earlier ? "前の行で作る作品" : "作品を新しく作る",
      dup ? "作者の条件は既にあるので作らない"
        : p.rates.length ? `${p.rates.map((r) => `${r.label} ${r.ratePct}%`).join("・")}・相手先 ${p.party!.name}` : ""
    ];
    if (p.product) parts.push(p.product.reuse ? `製品 ${p.product.isbn ?? (p.product.publisher?.name ?? "")} は登録済み（足さない）` : editionRowLabel(p.product, GAME_EDITION_NAMES));
    return parts.filter(Boolean).join("・");
  }

  /** 既存の作品に、同じ相手先・同じ取引モデルの生きた条件があれば重複。 */
  private async duplicateOf(p: GameWorkRow): Promise<string | null> {
    if (!p.work || !p.party) return null;
    const r = await this.database.query(
      `SELECT condition_no, usage_type FROM conditions
        WHERE work_id = $1 AND counterparty_id = $2 AND direction = 'in' AND kind = 'license'
          AND status IN ('active', 'scheduled') AND usage_type = ANY($3::text[])`,
      [p.work.id, p.party.id, p.rates.map((x) => x.usage)]);
    const hits = r.rows as Array<{ condition_no: string | null; usage_type: string }>;
    if (!hits.length) return null;
    const labelOf = (u: string) => GAME_RATE_COLUMNS.find((c) => c.usage === u)?.label ?? u;
    return `${p.party.name} の ${hits.map((h) => `${labelOf(h.usage_type)}（${h.condition_no ?? "番号なし"}）`).join("・")}が既にあります。この行の条件は飛ばされます`;
  }

  private async write(p: GameWorkRow, skipConditions: boolean, actor: string):
    Promise<{ workId: number; workCode: string | null; conditionNos: string[]; product: string }> {
    let workId: number;
    let workCode: string | null;
    const again = p.work ?? await this.findWork("", p.title);   // 前の行で作った作品
    if (again) { workId = again.id; workCode = again.code; }
    else {
      const made = await this.deps.works.create({ ...p.newWork!, kind: "own", status: "released" }, actor);
      workId = made.id; workCode = made.workCode;
    }
    let conditionNos: string[] = [];
    if (p.rates.length && p.party && !skipConditions) {
      const set = await this.deps.conditions.createLicenseSet({
        counterpartyId: p.party.id, workId, agreementId: p.agreementId,
        termStart: p.termStart, termEnd: p.termEnd, paymentTerms: p.paymentTerms, notes: p.notes, scopes: p.scopes,
        rows: p.rates.map((r) => ({ usageType: r.usage, ratePct: r.ratePct, exclusivity: p.exclusivity }))
      }, actor);
      conditionNos = set.conditions.map((c) => c.conditionNo ?? `#${c.id}`);
    }
    let product = "";
    if (p.product) {
      const e = p.product;
      product = await writeEditionRow(this.database, {
        createOut: this.deps.conditions.create ? (i, by) => this.deps.conditions.create!(i, by) : undefined,
        editions: this.deps.editions
      }, workId, p.title, e, GAME_EDITION_NAMES, actor);
    }
    await recordAudit(this.database, {
      actor, action: "game_works.import", targetType: "work", targetId: workId,
      detail: { newWork: !again, conditionNos, partyId: p.party?.id ?? null, product: p.product ? { ...p.product } : null }
    });
    return { workId, workCode, conditionNos, product };
  }

  private async findWork(code: string, title: string): Promise<{ id: number; code: string | null } | null> {
    const hits = (await this.database.query(
      `SELECT id, work_code, title FROM works
        WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
           OR ($1 = '' AND btrim(title) = btrim($2))
        LIMIT 3`, [code, title])).rows as Array<{ id: number; work_code: string | null }>;
    if (hits.length > 1) throw new DomainError("VALIDATION", `作品「${code || title}」が複数当たります。作品コードで指定してください`);
    return hits[0] ? { id: Number(hits[0].id), code: hits[0].work_code } : null;
  }

  private async parseRow(row: Record<string, string>): Promise<GameWorkRow> {
    const title = text(row, "作品名");
    if (!title) throw new DomainError("VALIDATION", "作品名が空です");
    const code = text(row, "作品コード");
    const work = await this.findWork(code, title);
    // 新しく作る作品名が、登録済みの作品と表記だけ違うなら止める（二重に作らない）。
    if (!work && !code) await refuseSimilarWork(this.database, title);
    const rates = GAME_RATE_COLUMNS
      .map((c) => ({ usage: c.usage, label: c.label, ratePct: ratePct(text(row, c.header), c.header) }))
      .filter((r): r is { usage: "in_house" | "oem" | "sublicense"; label: string; ratePct: number } => r.ratePct !== null);
    // 相手先（作者）は料率があるときに要る。製品だけの行（2 冊目・海外版）は空でよい。
    const party = rates.length || text(row, "相手先") || text(row, "相手先コード")
      ? await this.findParty(text(row, "相手先コード"), text(row, "相手先"), "相手先") : null;
    const exclText = text(row, "独占");
    if (exclText && !EXCLUSIVITY[exclText]) throw new DomainError("VALIDATION", `独占は「独占」か「非独占」です（"${exclText}"）`);
    let agreementId: number | null = null;
    const agreementNo = text(row, "契約番号");
    if (agreementNo) {
      const a = (await this.database.query(
        "SELECT id, counterparty_id AS cp FROM agreements WHERE lower(btrim(agreement_no)) = lower(btrim($1)) LIMIT 2",
        [agreementNo])).rows as Array<{ id: number; cp: number }>;
      if (a.length !== 1) throw new DomainError("VALIDATION", `契約番号 ${agreementNo} が${a.length ? "複数当たります" : "見つかりません"}`);
      if (!party) throw new DomainError("VALIDATION", "契約番号を入れるなら相手先も入れてください");
      if (Number(a[0].cp) !== party.id) throw new DomainError("VALIDATION", `契約 ${agreementNo} は ${party.name} の契約ではありません`);
      agreementId = Number(a[0].id);
    }
    const scopes: ConditionScope[] = [
      ...parseRegions(text(row, "地域")).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
      ...parseLanguages(text(row, "言語")).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
    ];
    const product = await readEditionColumns(this.database, row, GAME_EDITION_NAMES, (c, n, w) => this.findParty(c, n, w),
                                             work?.id ?? null);
    return {
      title, work,
      newWork: work ? null : {
        title, titleKana: text(row, "カナ") || null, workCode: code || null, remarks: text(row, "作品備考") || null,
        copyrightNotice: text(row, "著作権表示") || null, thirdPartyRights: text(row, "第三者権利") || null,
        businessLine: text(row, "事業区分") || "ボードゲーム"
      },
      party, agreementId, rates, exclusivity: exclText ? EXCLUSIVITY[exclText] : "non_exclusive",
      termStart: csvDate(text(row, "開始日")), termEnd: csvDate(text(row, "終了日")),
      paymentTerms: text(row, "支払条件") || null, notes: text(row, "備考") || null, scopes, product
    };
  }

  private async findParty(code: string, name: string, what: string): Promise<{ id: number; name: string }> {
    if (!code && !name) throw new DomainError("VALIDATION", `${what}が空です`);
    const q: Queryable = this.database;
    const r = await q.query(
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
