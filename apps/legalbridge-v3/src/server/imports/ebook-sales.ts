import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { floorRoyalty } from "../royalty/rounding.js";
import { parseCsv } from "./parse.js";
import { readWorkbook, serialToDate, type CellValue, type Workbook } from "./xlsx.js";

/**
 * 電子書籍売上の取込（A-069。docs/royalty-shares.md §5）。
 *
 * 事業部から月次で来る Excel（シート＝月。販売月・書店会社名・書店名・タイトル・
 * 著者名・CID・販売価格・料率・支払い単価・DL数・税抜き金額・印税）を読み、
 * 作品の電子出版（pub_digital）の IN 条件に実績を立てる。
 *
 *   1. 読む     … XLSX か CSV を行に直す（readRows）。見出しの名前で列を当てる。
 *   2. 当てる   … CID → 作品（ebook_work_codes）。無ければ「タイトル 巻数」が一致する作品、
 *                 巻数が無い（1 巻だけ）ならタイトルが一致する作品。作品は作品名 × 巻数で
 *                 1 件（原作は 1 つで、巻は別の作品）。巻ごとの作品が無ければ当てない
 *                 （シリーズ名の作品に黙って載せない）。
 *                 完全一致で決まらなければ、報告の題名を含む作品名（事業部の報告は題名を
 *                 省く：「ソング・オブ・ホープ」→「ブレイド・オブ・アルカナ … サプリメント
 *                 ソング・オブ・ホープ」）で、巻数も合うものが 1 件ならそれ。2 件以上は候補。
 *                 作品 → 有効な電子出版の料率条件。無ければ「印税なし」か「条件なし」。
 *   3. まとめる … 条件 × 販売月 × 報告月 × 書店 × 販売価格 で 1 件の実績（報告売上 = 配信価格 × DL数）。
 *                 事業部の Excel の行と同じ単位。印税は行ごとに切り捨て（rounding.ts の
 *                 floorRoyalty）で、計算書もその実績ごとに切り捨てて足す（Excel と 1 円まで合う）。
 *                 期間（集計期間の判定）は A 列の販売月で持つ（契約の集計期間は販売月基準）。
 *                 報告月はシート名（「2026年3月」）。シートには前々月の販売月の行や
 *                 遅れて報告された古い月の行が載るので、期間はシートの月で持ち、
 *                 販売月は備考に書く。シート名が月でなければ（CSV など）販売月で持つ。
 *   4. 登録     … 通常の実績の登録（ConditionEventService.add）を呼ぶ。取込だけ別の
 *                 規則で入ると、画面から入れた行と品質が変わる。出版の実績は台帳の
 *                 「報告を追加」と同じ形（利用形態なし・総額＝報告売上）で、料率は
 *                 計算書を出すときに条件から掛かる。
 *
 * 必ず試算（preview）を見てから登録する。登録は同じ突合をもう一度通す（画面の値は信用しない）。
 * 同じ月を二度入れない：条件 × 期間 × 販売価格 の実績がすでにあれば「登録済み」として飛ばす。
 */

export interface EbookSalesRow {
  sheet: string;
  line: number;
  /** 販売月 YYYY-MM */
  month: string;
  /** 報告月 YYYY-MM（シート名「2026年3月」から）。シート名が月でなければ null。 */
  reportMonth: string | null;
  storeCompany: string | null;
  store: string | null;
  title: string;
  /** 巻数（「1」「3」）。無ければ null。 */
  volume: string | null;
  authors: string | null;
  cid: string | null;
  /** 販売価格（税抜の配信価格）。円。 */
  listPrice: number;
  /** 書店の掛率（%）。参考。 */
  storeRatePct: number | null;
  downloads: number;
  /** 税抜き金額（書店からの入金ベース）。参考。 */
  netAmount: number | null;
  /** Excel が出していた印税。突合の参考。 */
  royaltyInFile: number | null;
}

export interface ReadResult {
  rows: EbookSalesRow[];
  sheets: Array<{ name: string; rows: number; note: string | null }>;
}

const HEADERS = {
  month: ["販売月"],
  storeCompany: ["書店会社名"],
  store: ["書店名"],
  title: ["コンテンツ名称", "タイトル名称"],
  volume: ["巻数", "巻"],
  authors: ["著者名"],
  cid: ["CID"],
  listPrice: ["販売価格"],
  storeRatePct: ["料率"],
  downloads: ["DL数"],
  netAmount: ["税抜き金額"],
  royalty: ["印税"]
} as const;

const norm = (v: CellValue): string => String(v ?? "").replace(/\s+/g, " ").trim();
const numOf = (v: CellValue): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** 販売月。シリアル値・日付文字列・「2026/01」「2026年1月」を YYYY-MM に。 */
export function monthOf(v: CellValue): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    const d = serialToDate(v);
    return d ? d.slice(0, 7) : null;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/年.](\d{1,2})(?:[-/月.]\d{0,2}日?)?/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
}

/** 巻数。数なら整数の文字列に（1.0 → "1"）。空や読めないものは null。 */
export function volumeOf(v: CellValue): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v)) : null;
  const s = String(v).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = s.match(/(\d+)/);
  return m ? String(Number(m[1])) : (s || null);
}

/** 販売月の末日（実績の発生日）。 */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月分`;
}

function headerIndex(row: CellValue[]): Record<keyof typeof HEADERS, number> | null {
  const cells = row.map(norm);
  const find = (names: readonly string[]) => {
    for (const n of names) { const i = cells.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const idx = Object.fromEntries(
    (Object.keys(HEADERS) as Array<keyof typeof HEADERS>).map((k) => [k, find(HEADERS[k])])
  ) as Record<keyof typeof HEADERS, number>;
  if (idx.month < 0 || idx.downloads < 0 || idx.title < 0 || idx.listPrice < 0) return null;
  return idx;
}

/** シートの表（見出し行＋データ行）を行に直す。見出しの無いシートは飛ばす。 */
export function rowsOfSheet(name: string, cells: CellValue[][]): { rows: EbookSalesRow[]; note: string | null } {
  let headerAt = -1;
  let idx: ReturnType<typeof headerIndex> = null;
  for (let i = 0; i < Math.min(cells.length, 10); i += 1) {
    idx = headerIndex(cells[i] ?? []);
    if (idx) { headerAt = i; break; }
  }
  if (!idx) return { rows: [], note: "売上の表ではありません（販売月・タイトル・販売価格・DL数 の見出しが無い）" };
  const rows: EbookSalesRow[] = [];
  let footer = 0;
  for (let i = headerAt + 1; i < cells.length; i += 1) {
    const r = cells[i] ?? [];
    const at = (k: keyof typeof HEADERS) => (idx![k] >= 0 ? r[idx![k]] ?? null : null);
    const title = norm(at("title"));
    const month = monthOf(at("month"));
    const downloads = numOf(at("downloads"));
    const listPrice = numOf(at("listPrice"));
    if (!title || !month) { if (r.some((c) => c !== null && c !== "")) footer += 1; continue; }
    if (downloads === null || listPrice === null) { footer += 1; continue; }
    rows.push({
      sheet: name, line: i + 1, month, reportMonth: monthOf(name),
      storeCompany: norm(at("storeCompany")) || null,
      store: norm(at("store")) || null,
      title,
      volume: volumeOf(at("volume")),
      authors: norm(at("authors")) || null,
      cid: norm(at("cid")) || null,
      listPrice: Math.round(listPrice),
      storeRatePct: numOf(at("storeRatePct")),
      downloads: Math.round(downloads),
      netAmount: numOf(at("netAmount")),
      royaltyInFile: numOf(at("royalty"))
    });
  }
  return { rows, note: footer ? `${footer} 行は合計・備考として読み飛ばし` : null };
}

export function readWorkbookRows(workbook: Workbook): ReadResult {
  const out: ReadResult = { rows: [], sheets: [] };
  // 年次の集計ファイルは、全体のシートと支払先ごとのシートに同じ行が載る。
  // シートをまたいで同じ行（月・書店・題名・価格・DL数・金額）は 1 回だけ数える。
  const seen = new Set<string>();
  for (const sheet of workbook.sheets) {
    const r = rowsOfSheet(sheet.name, sheet.rows);
    let repeated = 0;
    for (const row of r.rows) {
      const key = [row.month, row.storeCompany, row.store, row.title, row.cid, row.listPrice, row.downloads, row.netAmount].join("|");
      if (seen.has(key)) { repeated += 1; continue; }
      seen.add(key);
      out.rows.push(row);
    }
    const notes = [r.note, repeated ? `${repeated} 行は他のシートと同じ行として読み飛ばし` : null].filter(Boolean);
    out.sheets.push({ name: sheet.name, rows: r.rows.length - repeated, note: notes.length ? notes.join("・") : null });
  }
  if (!out.rows.length) throw new DomainError("VALIDATION", "売上の行がありません（販売月・タイトル・販売価格・DL数 の列があるシートが要ります）");
  return out;
}

/** ファイル（XLSX か CSV）を行に直す。 */
export function readRows(data: Buffer, options: { filename?: string | null } = {}): ReadResult {
  if (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b) return readWorkbookRows(readWorkbook(data));
  let text = data.toString("utf-8");
  if (text.includes("�")) {
    try { text = new TextDecoder("shift_jis").decode(data); } catch { /* UTF-8 のまま */ }
  }
  const csv = parseCsv(text, { maxRows: 20000 });
  const cells: CellValue[][] = [csv.headers, ...csv.rows.map((r) => csv.headers.map((h) => r[h] ?? null))];
  const name = options.filename ?? "CSV";
  const r = rowsOfSheet(name, cells);
  if (!r.rows.length) throw new DomainError("VALIDATION", r.note ?? "売上の行がありません");
  return { rows: r.rows, sheets: [{ name, rows: r.rows.length, note: r.note }] };
}

// ---------------------------------------------------------------------
// 突合と登録
// ---------------------------------------------------------------------

export type GroupStatus =
  | "ok"            // 登録できる
  | "duplicate"     // もう登録してある（条件 × 期間 × 販売価格）
  | "no_royalty"    // 作品はあるが電子出版の料率条件が無い（買い切り・社内制作など）
  | "no_condition"  // 作品はあるが条件が 1 本も無い（登録漏れの疑い）
  | "unresolved"    // 作品が分からない（CID もタイトルも当たらない）
  | "zero"          // DL 0 または価格 0
  | "out_of_range"; // 販売月が指定の範囲の外（支払済みの月・まだ先の月）。登録しない

/** 登録する販売月の範囲（YYYY-MM。両端を含む）。空なら全部。 */
export interface MonthRange { fromMonth?: string | null; toMonth?: string | null }
const inRange = (month: string, range: MonthRange) =>
  (!range.fromMonth || month >= range.fromMonth) && (!range.toMonth || month <= range.toMonth);

export interface SalesGroup {
  key: string;
  cid: string | null;
  title: string;
  /** 巻数。作品は作品名 × 巻数で 1 件。 */
  volume: string | null;
  authors: string | null;
  /** 期間の月＝販売月（A 列）。発生日はこの月の末日、期間は「YYYY年M月分」。 */
  month: string;
  /** 報告月（シート名）。シート名が月でなければ null。備考に書き、登録済みの検査に使う。 */
  reportMonth: string | null;
  /** 互換：まとめた行の販売月（いまは month の 1 つだけ）。 */
  salesMonths: string[];
  /** 書店（Excel の行の単位）。 */
  store: string | null;
  listPrice: number;
  downloads: number;
  /** 配信価格 × DL数。 */
  gross: number;
  stores: string[];
  lines: number;
  status: GroupStatus;
  message: string | null;
  /** via … cid: 覚えた CID、title: 題名の完全一致、partial: 題名の部分一致（登録の作品名が報告の題名を含む）。 */
  work: { id: number; title: string; workCode: string | null; via: "cid" | "title" | "partial" } | null;
  condition: { id: number; conditionNo: string | null; ratePpm: number | null;
               counterparty: string | null; shares: string[] } | null;
  /** 実績を付ける回（時限式の締め）。報告月の末日を集計期間に含む回。無ければ浮いた実績になる。 */
  round: { id: number; label: string | null } | null;
  /** 配信価格 × DL数 × 料率（四捨五入）。登録できる行だけ。 */
  royalty: number | null;
  /** Excel が出していた印税の合計。突合の参考。 */
  royaltyInFile: number | null;
  /** 候補の作品（タイトルが部分一致）。作品が分からないときの当て先。 */
  candidates: Array<{ id: number; title: string; workCode: string | null }>;
}

export interface SalesPreview {
  groups: SalesGroup[];
  counts: Record<GroupStatus, number>;
  months: string[];
}

export interface EventWriter {
  add(conditionId: number, input: {
    eventType: "sales"; occurredOn: string; period: string | null; quantity: number;
    grossAmount: number; amount: number; note: string | null; unitAmount: number; workId: number;
    /** 付ける回（年 1 回の締め）。無ければ予定の外の実績。 */
    scheduleId?: number | null;
  }, actor: string): Promise<{ id: number }>;
}

/** 題名の突合の鍵。空白（全角含む）を落として小文字に。SQL 側（regexp_replace）と同じ規則。 */
export const normalizeTitle = (t: string) => t.replace(/[\s　]+/g, "").toLowerCase();

/** 巻数つきの作品名の候補（「タイトル 3」「タイトル 第3巻」「タイトル（3）」「タイトル vol.3」）。巻数が無ければ空。 */
export function volumeTitles(title: string, volume: string | null): string[] {
  const v = String(volume ?? "").trim();
  if (!v) return [];
  return [`${title} ${v}`, `${title} 第${v}巻`, `${title}（${v}）`, `${title} vol.${v}`];
}

/** 取込の備考「電子書籍売上取込 2026-03｜BOOKWALKER（PC）｜…」から書店名。古い形（書店なし）は null。 */
export function storeOfNote(note: string | null | undefined): string | null {
  const m = String(note ?? "").match(/^電子書籍売上取込 [^｜\s]+｜([^｜]*)/);
  return m ? m[1].trim() : null;
}

/** 取込の備考「…｜書店｜報告月 2026-03」から報告月。古い形（報告月なし）は null。 */
export function reportOfNote(note: string | null | undefined): string | null {
  const m = String(note ?? "").match(/｜報告月 (\d{4}-\d{2})/);
  return m ? m[1] : null;
}

/** 巻数が無いか 1 巻（1 冊だけの本も巻数 1 で来る）。 */
const isFirstOrNoVolume = (volume: string | null) => !volume || volume === "1";

/**
 * 登録の作品名（正規化済み）が報告の題名（正規化済み）を含み、巻数も合うか。
 * 題名の後ろに残る部分の末尾の数字を巻数と見る（「… 3」「… 第3巻」「…（3）」「… vol.3」）。
 * 残りに数字が無ければ巻なし＝1 巻。報告に巻数が無いか 1 なら、巻なしか 1 巻の作品だけ。
 */
export function titleContains(workTitle: string, key: string, volume: string | null): boolean {
  if (!key) return false;
  const at = workTitle.indexOf(key);
  if (at < 0) return false;
  const rest = workTitle.slice(at + key.length);
  const m = rest.match(/(?:第|（|vol\.)?(\d+)(?:巻|）)?$/);
  const vol = m ? String(Number(m[1])) : null;
  const want = isFirstOrNoVolume(volume) ? "1" : String(Number(volume));
  return (vol ?? "1") === want;
}

export class EbookSalesImportService {
  constructor(private readonly database: Transactable, private readonly events: EventWriter) {}

  /** 行をまとめて突合する。書かない。 */
  async preview(rows: EbookSalesRow[], range: MonthRange = {}): Promise<SalesPreview> {
    try { return await this.resolve(this.database, rows, range); }
    catch (error) { throw translate(error); }
  }

  /** 登録できる行を実績にする。突合はここでもう一度行う。 */
  async commit(rows: EbookSalesRow[], actor: string, options: { onlyKeys?: string[] } & MonthRange = {}) {
    try {
      const preview = await this.resolve(this.database, rows, options);
      const picked = new Set(options.onlyKeys ?? []);
      const results: Array<{ key: string; eventId: number | null; status: GroupStatus | "error"; message: string | null }> = [];
      let written = 0;
      for (const g of preview.groups) {
        if (g.status !== "ok" || (picked.size && !picked.has(g.key))) {
          results.push({ key: g.key, eventId: null, status: g.status, message: g.message });
          continue;
        }
        try {
          // 台帳の「報告を追加」と同じ形。総額＝実額＝報告売上（配信価格 × DL数）。
          // 料率は計算書を出すときに条件から掛かる（取り分もそこで割る）。
          const r = await this.events.add(g.condition!.id, {
            eventType: "sales", occurredOn: monthEnd(g.month), period: monthLabel(g.month),
            quantity: g.downloads, grossAmount: g.gross, amount: g.gross,
            // 「電子書籍売上取込 販売月｜書店｜報告月 YYYY-MM」。書店と報告月は登録済みの検査（同じ行を
            // 二度入れない。遅れて報告された同じ販売月の行は別の報告）と計算書の但し書きが読む。
            note: `電子書籍売上取込 ${g.month}｜${g.store ?? ""}${g.reportMonth ? `｜報告月 ${g.reportMonth}` : ""}`,
            unitAmount: g.listPrice, workId: g.work!.id,
            // 年 1 回の締め（回）に付ける。支払文書処理の「まとめて締める」がこの回を拾う。
            scheduleId: g.round?.id ?? null
          }, actor);
          written += 1;
          results.push({ key: g.key, eventId: r.id, status: "ok", message: null });
          // CID をタイトルで当てたなら、次からは CID で当たるように覚える。
          if (g.cid && g.work && g.work.via !== "cid") {
            await this.rememberCode(this.database, g.cid, g.work.id, g.title, actor);
          }
        } catch (error) {
          const e = error instanceof DomainError ? error.message : String(error);
          results.push({ key: g.key, eventId: null, status: "error", message: e });
        }
      }
      await recordAudit(this.database, {
        actor, action: "ebook_sales.import", targetType: "import", targetId: 0,
        detail: { rows: rows.length, groups: preview.groups.length, written, months: preview.months }
      });
      return { written, results, preview };
    } catch (error) { throw translate(error); }
  }

  /** CID → 作品 を決める（覚える）。 */
  async mapCode(cid: string, workId: number, title: string | null, actor: string) {
    try {
      const code = String(cid ?? "").trim();
      if (!code) throw new DomainError("VALIDATION", "CID が空です");
      const w = await this.database.query("SELECT id, title FROM works WHERE id = $1", [workId]);
      if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
      await this.rememberCode(this.database, code, workId, title, actor);
      return { cid: code, workId, workTitle: String((w.rows[0] as { title: string }).title) };
    } catch (error) { throw translate(error); }
  }

  /** 作品に付いている CID。作品の画面に出す。 */
  async codesOf(workId: number) {
    try {
      const r = await this.database.query(
        `SELECT cid, title, created_by, created_at FROM ebook_work_codes WHERE work_id = $1 ORDER BY created_at, cid`, [workId]);
      return (r.rows as Array<Record<string, any>>).map((x) => ({
        cid: String(x.cid), title: str(x.title), createdBy: str(x.created_by),
        createdAt: x.created_at ? new Date(String(x.created_at)).toISOString() : null
      }));
    } catch (error) { throw translate(error); }
  }

  /** CID → 作品 を外す。 */
  async unmapCode(cid: string, actor: string) {
    try {
      const r = await this.database.query("DELETE FROM ebook_work_codes WHERE cid = $1 RETURNING work_id", [cid]);
      const row = r.rows[0] as { work_id: number } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `CID ${cid} は登録されていません`);
      await recordAudit(this.database, {
        actor, action: "ebook_sales.unmap_code", targetType: "work", targetId: Number(row.work_id), detail: { cid }
      });
      return { cid, workId: Number(row.work_id) };
    } catch (error) { throw translate(error); }
  }

  private async rememberCode(client: Queryable, cid: string, workId: number, title: string | null, actor: string) {
    await client.query(
      `INSERT INTO ebook_work_codes (cid, work_id, title, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (cid) DO UPDATE SET work_id = EXCLUDED.work_id, title = EXCLUDED.title, created_by = EXCLUDED.created_by`,
      [cid, workId, title, actor]);
    await recordAudit(client, {
      actor, action: "ebook_sales.map_code", targetType: "work", targetId: workId, detail: { cid, title }
    });
  }

  private async resolve(client: Queryable, rows: EbookSalesRow[], range: MonthRange = {}): Promise<SalesPreview> {
    // まとめる：CID（無ければタイトル × 巻数）× 販売月 × 報告月（シート名）× 書店 × 販売価格。
    // Excel の行と同じ単位（印税は行ごとに切り捨てなので、行をまたいで足すと 1 円ずれる）。
    // 期間は販売月。報告月も鍵に入れるのは、遅れて報告された同じ販売月の行（別のシート）を
    // 同じ実績に混ぜず、あとの取込で「登録済み」と誤って落とさないため。
    const groups = new Map<string, SalesGroup>();
    for (const r of rows) {
      const id = r.cid ? `cid:${r.cid}` : `title:${normalizeTitle(r.title)}|${r.volume ?? ""}`;
      const month = r.month;
      const reportMonth = r.reportMonth ?? null;
      const store = r.store ?? r.storeCompany ?? null;
      const key = `${id}|${month}|${reportMonth ?? ""}|${store ?? ""}|${r.listPrice}`;
      const g = groups.get(key) ?? {
        key, cid: r.cid, title: r.title, volume: r.volume, authors: r.authors, month, reportMonth, salesMonths: [], store,
        listPrice: r.listPrice,
        downloads: 0, gross: 0, stores: [], lines: 0, status: "unresolved" as GroupStatus, message: null,
        work: null, condition: null, round: null, royalty: null, royaltyInFile: null, candidates: []
      };
      if (!g.salesMonths.includes(r.month)) g.salesMonths.push(r.month);
      g.downloads += r.downloads;
      g.gross += r.listPrice * r.downloads;
      g.lines += 1;
      if (r.store && !g.stores.includes(r.store)) g.stores.push(r.store);
      if (r.royaltyInFile !== null) g.royaltyInFile = (g.royaltyInFile ?? 0) + r.royaltyInFile;
      groups.set(key, g);
    }
    const list = [...groups.values()];

    // CID → 作品（覚えたもの）。
    const cids = [...new Set(list.map((g) => g.cid).filter((c): c is string => Boolean(c)))];
    const codeRows = cids.length ? (await client.query(
      `SELECT c.cid, w.id, w.title, w.work_code FROM ebook_work_codes c JOIN works w ON w.id = c.work_id
        WHERE c.cid = ANY($1::text[])`, [cids])).rows as Array<Record<string, any>> : [];
    const byCid = new Map(codeRows.map((r) => [String(r.cid), { id: Number(r.id), title: String(r.title), workCode: str(r.work_code) }]));

    // タイトル → 作品（完全一致。空白と全角半角の違いは無視）。作品は作品名 × 巻数で 1 件なので、
    // 巻数があれば「タイトル 3」「タイトル 第3巻」「タイトル（3）」を先に探す。
    const unresolvedGroups = list.filter((g) => !(g.cid && byCid.has(g.cid)));
    const titleKeys = [...new Set(unresolvedGroups.flatMap((g) => [...volumeTitles(g.title, g.volume), g.title].map(normalizeTitle)))];
    const titleRows = titleKeys.length ? (await client.query(
      `SELECT id, title, work_code FROM works
        WHERE status <> 'archived' AND regexp_replace(lower(title), '[[:space:]　]', '', 'g') = ANY($1::text[])`,
      [titleKeys])).rows as Array<Record<string, any>> : [];
    const byTitle = new Map<string, Array<{ id: number; title: string; workCode: string | null }>>();
    for (const r of titleRows) {
      const k = normalizeTitle(String(r.title));
      byTitle.set(k, [...(byTitle.get(k) ?? []), { id: Number(r.id), title: String(r.title), workCode: str(r.work_code) }]);
    }

    for (const g of list) {
      if (g.cid && byCid.has(g.cid)) { g.work = { ...byCid.get(g.cid)!, via: "cid" }; continue; }
      const withVolume = volumeTitles(g.title, g.volume).flatMap((t) => byTitle.get(normalizeTitle(t)) ?? []);
      const plain = byTitle.get(normalizeTitle(g.title)) ?? [];
      // 巻数つきの作品が見つかればそれ。無ければ、巻数が無いか 1 のときだけタイトルそのもの
      // （2 巻以上はシリーズ名の作品に黙って載せない。巻ごとの作品を作ってから当てる）。
      const hits = withVolume.length ? withVolume : (isFirstOrNoVolume(g.volume) ? plain : []);
      if (hits.length === 1) g.work = { ...hits[0], via: "title" };
      else if (hits.length > 1) { g.message = `同じ題名の作品が ${hits.length} 件あります。CID の当て先を選んでください`; g.candidates = hits; }
      else if (plain.length && !isFirstOrNoVolume(g.volume)) {
        g.message = `「${g.title} ${g.volume}」の作品がありません（「${g.title}」はあります）。巻ごとの作品を作ってから当ててください`;
        g.candidates = plain;
      }
    }

    // 題名の部分一致。事業部の報告は題名を省くことがある（「ソング・オブ・ホープ」→ 登録は
    // 「ブレイド・オブ・アルカナ ―聖痕英雄譚RPG― サプリメント ソング・オブ・ホープ」）。
    // 完全一致で決まらず候補も無い行だけ。登録の作品名が報告の題名を含み、巻数も合う作品が
    // 1 件ならそれに当てる（登録時に CID を覚えるので次からは CID で当たる）。2 件以上は候補。
    const partialGroups = list.filter((g) => !g.work && !g.message && normalizeTitle(g.title).length >= 2);
    const partialKeys = [...new Set(partialGroups.map((g) => normalizeTitle(g.title)))];
    const partialRows = partialKeys.length ? (await client.query(
      `SELECT id, title, work_code FROM works
        WHERE status <> 'archived'
          AND EXISTS (SELECT 1 FROM unnest($1::text[]) k
                       WHERE strpos(regexp_replace(lower(title), '[[:space:]　]', '', 'g'), k) > 0)`,
      [partialKeys])).rows as Array<Record<string, any>> : [];
    const partialWorks = partialRows.map((r) => ({ id: Number(r.id), title: String(r.title), workCode: str(r.work_code) }));
    for (const g of partialGroups) {
      const key = normalizeTitle(g.title);
      const hits = partialWorks.filter((w) => titleContains(normalizeTitle(w.title), key, g.volume));
      if (hits.length === 1) g.work = { ...hits[0], via: "partial" };
      else if (hits.length > 1) { g.message = `題名を含む作品が ${hits.length} 件あります。当て先を選んでください`; g.candidates = hits; }
    }

    // 作品 → 条件。電子出版（pub_digital）の料率条件が本命。他の IN 条件は「印税なし」の判定に使う。
    const workIds = [...new Set(list.map((g) => g.work?.id).filter((x): x is number => Boolean(x)))];
    const condRows = workIds.length ? (await client.query(
      `SELECT c.id, c.condition_no, c.work_id, c.usage_type, c.pricing_model, c.rate_ppm, c.status, c.effective_from,
              p.name AS party_name,
              (SELECT string_agg(sp.name || ' ' || (s.share_ppm / 10000.0)::text || '%', '・' ORDER BY s.sort_order)
                 FROM condition_shares s JOIN parties sp ON sp.id = s.party_id WHERE s.condition_id = c.id) AS shares
         FROM conditions c LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE c.work_id = ANY($1::bigint[]) AND c.direction = 'in' AND c.kind = 'license'
          AND c.status IN ('active', 'scheduled')
        ORDER BY c.work_id, c.effective_from NULLS FIRST, c.id`, [workIds])).rows as Array<Record<string, any>> : [];

    // 登録済みの検査：条件 × 期間 × 書店 × 販売価格（改訂の全版）。書店は備考から読む。
    // 書店の無い古い備考（書店をまたいで 1 件にしていた頃）は、どの書店とも同じ扱い。
    const condIds = [...new Set(condRows.map((c) => Number(c.id)))];
    const existing = condIds.length ? (await client.query(
      `SELECT c.id AS condition_id, e.period, e.unit_amount, e.note
         FROM condition_events e
         JOIN conditions c ON COALESCE(c.series_id, c.id) = (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = e.condition_id)
        WHERE e.status = 'active' AND e.event_type = 'sales' AND c.id = ANY($1::bigint[])
          AND e.condition_id IN (SELECT x.id FROM conditions x WHERE COALESCE(x.series_id, x.id) IN
                                   (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = ANY($1::bigint[])))`,
      [condIds])).rows as Array<Record<string, any>> : [];
    // 書店・報告月の無い古い備考は、どの書店・報告月とも同じ扱い（*）。
    const existingKeys = new Set(existing.map((e) => {
      const store = storeOfNote(str(e.note));
      return `${Number(e.condition_id)}|${String(e.period ?? "")}|${int(e.unit_amount) ?? 0}|${store ?? "*"}|${store === null ? "*" : reportOfNote(str(e.note)) ?? "*"}`;
    }));

    // 回（時限式の締め）。販売月の末日を集計期間（service_from〜service_to）に含む回に付ける。
    // 期間の無い回は締め日（due_on）以前の最初の回。
    const scheduleRows = condIds.length ? (await client.query(
      `SELECT id, condition_id, label, due_on, service_from, service_to
         FROM condition_schedules WHERE condition_id = ANY($1::bigint[]) ORDER BY condition_id, seq`, [condIds])).rows as Array<Record<string, any>> : [];
    const roundFor = (conditionId: number, day: string): { id: number; label: string | null } | null => {
      const mine = scheduleRows.filter((s) => Number(s.condition_id) === conditionId);
      const inRange = mine.find((s) => {
        const from = dateStr(s.service_from), to = dateStr(s.service_to) ?? dateStr(s.due_on);
        return from && to && from <= day && day <= to;
      });
      const next = inRange ?? mine
        .filter((s) => !dateStr(s.service_from) && (dateStr(s.due_on) ?? "") >= day)
        .sort((a, b) => String(dateStr(a.due_on)).localeCompare(String(dateStr(b.due_on))))[0];
      return next ? { id: Number(next.id), label: str(next.label) } : null;
    };

    for (const g of list) {
      // 販売月の範囲の外は登録しない（支払済みの月を二重に払わない）。行は画面に出して数える。
      if (!inRange(g.month, range)) {
        g.status = "out_of_range";
        g.message = `販売月 ${g.month} は登録する範囲（${range.fromMonth ?? "最初"}〜${range.toMonth ?? "最後"}）の外です`;
        continue;
      }
      if (!g.work) {
        g.status = "unresolved";
        g.message ??= g.cid ? "この CID の作品がまだ決まっていません"
          : `同じ題名の作品がありません（CID も無い）${isFirstOrNoVolume(g.volume) ? "" : `。巻ごとの作品「${g.title} ${g.volume}」が要ります`}`;
        continue;
      }
      if (!(g.downloads > 0) || !(g.listPrice > 0)) { g.status = "zero"; g.message = "DL 数か販売価格が 0"; continue; }
      const mine = condRows.filter((c) => Number(c.work_id) === g.work!.id);
      const digital = mine.filter((c) => c.usage_type === "pub_digital" && c.pricing_model === "revenue_rate" && c.status === "active");
      if (!digital.length) {
        g.status = mine.length ? "no_royalty" : "no_condition";
        g.message = mine.length
          ? "電子出版の料率条件が無い（買い切り・社内制作など）ので印税なし"
          : "この作品に条件が 1 本もありません（登録漏れなら条件を作ってから）";
        continue;
      }
      if (digital.length > 1) {
        g.status = "no_condition";
        g.message = `電子出版の料率条件が ${digital.length} 本あり、どれに載せるか決められません（${digital.map((c) => c.condition_no ?? `#${c.id}`).join("・")}）`;
        continue;
      }
      const c = digital[0];
      g.condition = { id: Number(c.id), conditionNo: str(c.condition_no), ratePpm: int(c.rate_ppm),
                      counterparty: str(c.party_name), shares: c.shares ? String(c.shares).split("・") : [] };
      g.round = roundFor(Number(c.id), monthEnd(g.month));
      // 行ごとに切り捨て（Excel の ROUNDDOWN と同じ）。
      g.royalty = floorRoyalty((g.gross * (int(c.rate_ppm) ?? 0)) / 1_000_000);
      const dupBase = `${Number(c.id)}|${monthLabel(g.month)}|${g.listPrice}`;
      const report = g.reportMonth ?? "";
      if ([`${dupBase}|${g.store ?? ""}|${report}`, `${dupBase}|${g.store ?? ""}|*`, `${dupBase}|*|*`].some((k) => existingKeys.has(k))) {
        g.status = "duplicate"; g.message = "同じ販売月・同じ報告月・同じ書店・同じ販売価格の実績がもうあります"; continue;
      }
      if (!(g.royalty > 0)) { g.status = "zero"; g.message = "料率を掛けると 0 円"; continue; }
      g.status = "ok"; g.message = null;
    }

    const counts: Record<GroupStatus, number> = { ok: 0, duplicate: 0, no_royalty: 0, no_condition: 0, unresolved: 0, zero: 0, out_of_range: 0 };
    for (const g of list) counts[g.status] += 1;
    list.sort((a, b) => a.month.localeCompare(b.month) || (a.reportMonth ?? "").localeCompare(b.reportMonth ?? "")
      || a.title.localeCompare(b.title, "ja")
      || (a.store ?? "").localeCompare(b.store ?? "", "ja") || a.listPrice - b.listPrice);
    return { groups: list, counts, months: [...new Set(list.map((g) => g.month))].sort() };
  }
}
