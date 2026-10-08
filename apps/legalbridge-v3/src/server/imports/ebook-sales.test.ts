import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DomainError } from "../core/errors.js";
import {
  EbookSalesImportService, monthEnd, monthLabel, monthOf, normalizeTitle, readRows, readWorkbookRows, rowsOfSheet, titleContains, volumeOf, volumeTitles,
  type EbookSalesRow
} from "./ebook-sales.js";

const HEADER = ["販売月", "書店会社名", "書店名", "巻数", "コンテンツ名称", "著者名", "CID", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", null, "印税"];

test("見出しの名前で列を当て、合計の行は読み飛ばす", () => {
  const r = rowsOfSheet("2026年3月", [
    HEADER,
    [46023, "ドワンゴ", "BOOKWALKER（PC）", 1, "キズナバレット 1 猟犬たちのネガイ", "からすば晴┴N.G.P.", "BT0001", 1900, 55, 1045, 11, 11495, null, 3135],
    [46023, "アマゾンジャパン", "Kindle（wholesale）", 1, "キズナバレット 1 猟犬たちのネガイ", "からすば晴┴N.G.P.", "BT0001", 1900, 50, 950, 3, 2850, null, 855],
    [null, null, null, null, null, null, null, null, "新紀元社売上合計", null, 14, 14345, "印税合計", 3990],
    [null, null, null, null, null, null, null, null, "アークライト売上合計", null, null, 268136.55]
  ]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].month, "2026-01");
  assert.equal(r.rows[0].cid, "BT0001");
  assert.equal(r.rows[0].listPrice, 1900);
  assert.equal(r.rows[1].downloads, 3);
  assert.equal(r.rows[1].royaltyInFile, 855);
  assert.match(r.note ?? "", /2 行は合計/);
});

test("タイトル名称しか無い古い形も読める。見出しの無いシートは飛ばす", () => {
  const r = rowsOfSheet("2025年9月", [
    ["販売月", "書店会社名", "書店名", "タイトル名称", "巻数", "著者名", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", null, "印税"],
    ["2025/08", "ドワンゴ", "BOOKWALKER（PC）", "ケダモノオペラ", 1, "池梟リョーマ", 3000, 55, 1650, 2, 3300, null, 900]
  ]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].title, "ケダモノオペラ");
  assert.equal(r.rows[0].month, "2025-08");
  assert.equal(r.rows[0].cid, null);
  const none = rowsOfSheet("印税計上額", [[null, 46113, 46143], ["印税計上額(税抜)", 89693, 207105]]);
  assert.equal(none.rows.length, 0);
  assert.match(none.note ?? "", /売上の表ではありません/);
});

test("シートをまたいで同じ行は 1 回だけ数える（年次の集計ファイル）", () => {
  const line = [45839, "ドワンゴ", "BOOKWALKER（PC）", 1, "ケダモノオペラ", "池梟リョーマ", 3000, 55, 1650, 2, 3300, 900];
  const header = ["販売月", "書店会社名", "書店名", "巻数", "タイトル名称", "著者名", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", "印税"];
  const r = readWorkbookRows({ sheets: [
    { name: "集計", rows: [header, line, [...line.slice(0, 9), 1, 1650, 450]] },
    { name: "池梟リョーマ", rows: [header, line, [...line.slice(0, 9), 1, 1650, 450]] }
  ] });
  assert.equal(r.rows.length, 2, "同じ内容の行でも同じシートの中なら別の行");
  assert.equal(r.sheets[1].rows, 0);
  assert.match(r.sheets[1].note ?? "", /2 行は他のシートと同じ行/);
});

test("月のシート（その月の報告）は別々の報告。同じ内容の行が別の月や同じ月のシートにあっても全部数える", () => {
  const line = [45839, "ドワンゴ", "BOOKWALKER（PC）", 1, "ケダモノオペラ", "池梟リョーマ", 2500, 55, 1375, 5, 6875, 1875];
  const header = ["販売月", "書店会社名", "書店名", "巻数", "タイトル名称", "著者名", "販売価格", "料率", "支払い単価", "DL数", "税抜き金額", "印税"];
  const r = readWorkbookRows({ sheets: [
    { name: "2025年7月", rows: [header, line, line] },
    { name: "2025年8月", rows: [header, line] },
    // 月のシートのあとに支払先ごとのシートがあれば、そちらは前の行と同じなら飛ばす。
    { name: "池梟リョーマ", rows: [header, line] }
  ] });
  assert.equal(r.rows.length, 3, "Excel はどの行も払う");
  assert.deepEqual(r.rows.map((x) => x.reportMonth), ["2025-07", "2025-07", "2025-08"]);
  assert.equal(r.sheets[0].note, null);
  assert.equal(r.sheets[2].rows, 0);
});

test("CSV も同じ列の規則で読む", () => {
  const csv = "販売月,書店会社名,書店名,巻数,タイトル名称,著者名,販売価格,料率,支払い単価,DL数,税抜き金額,印税\n"
    + "2026-01-01,ドワンゴ,BOOKWALKER（PC）,1,ケダモノオペラ,池梟リョーマ,3000,55,1650,2,3300,900\n";
  const r = readRows(Buffer.from(csv, "utf-8"), { filename: "sales.csv" });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].month, "2026-01");
  assert.equal(r.sheets[0].name, "sales.csv");
  assert.throws(() => readRows(Buffer.from("a,b\n1,2\n", "utf-8")), (e: unknown) => e instanceof DomainError);
});

test("販売月の読み方と、実績の発生日・期間の名前", () => {
  assert.equal(monthOf(45839), "2025-07");
  assert.equal(monthOf("2026年1月"), "2026-01");
  assert.equal(monthOf("2026/1/1"), "2026-01");
  assert.equal(monthOf("x"), null);
  assert.equal(monthEnd("2026-02"), "2026-02-28");
  assert.equal(monthEnd("2024-02"), "2024-02-29");
  assert.equal(monthLabel("2026-01"), "2026年1月分");
  assert.equal(normalizeTitle("キズナバレット　1 猟犬たちのネガイ"), "キズナバレット1猟犬たちのネガイ");
});

// ---- 突合と登録 ----

const row = (over: Partial<EbookSalesRow>): EbookSalesRow => ({
  sheet: "2026年1月", line: 2, month: "2026-01", reportMonth: over.month ?? "2026-01", storeCompany: "ドワンゴ", store: "BOOKWALKER（PC）",
  title: "キズナバレット 1", volume: "1", authors: "からすば晴┴N.G.P.", cid: "BT0001", listPrice: 1900, storeRatePct: 55,
  downloads: 11, netAmount: 11495, royaltyInFile: 3135, ...over
});

interface Options {
  codes?: Array<{ cid: string; id: number; title: string }>;
  titles?: Array<{ id: number; title: string }>;
  /** 部分一致の候補（登録の作品名が報告の題名を含むもの）。SQL の絞りは真似ず、全部返して JS 側で選ばせる。 */
  partial?: Array<{ id: number; title: string }>;
  conditions?: Array<Record<string, unknown>>;
  existing?: Array<{ condition_id: number; period: string; unit_amount: number; note?: string | null }>;
  schedules?: Array<Record<string, unknown>>;
}
const db = (o: Options = {}) => new FakeDatabase((text, params) => {
  if (text.includes("FROM ebook_work_codes c JOIN works w")) {
    return (o.codes ?? []).filter((c) => (params[0] as string[]).includes(c.cid)).map((c) => ({ cid: c.cid, id: c.id, title: c.title, work_code: null }));
  }
  if (text.includes("strpos(regexp_replace(lower(title)")) return (o.partial ?? []).map((t) => ({ ...t, work_code: null }));
  if (text.includes("regexp_replace(lower(title)")) return (o.titles ?? []).map((t) => ({ ...t, work_code: null }));
  if (text.includes("FROM conditions c LEFT JOIN parties p")) return o.conditions ?? [];
  if (text.includes("e.event_type = 'sales' AND c.id = ANY")) return o.existing ?? [];
  if (text.includes("FROM condition_schedules WHERE condition_id = ANY")) return o.schedules ?? [];
  if (text.includes("SELECT id, title FROM works WHERE id = $1")) return [{ id: params[0], title: "作品" }];
  return undefined;
});
const DIGITAL = { id: 50, condition_no: "CL-1", work_id: 7, usage_type: "pub_digital", pricing_model: "revenue_rate",
                  rate_ppm: 150000, status: "active", effective_from: null, party_name: "からすば晴", shares: null };

const writer = () => {
  const added: Array<{ conditionId: number; input: Record<string, unknown> }> = [];
  return { added, add: async (conditionId: number, input: Record<string, unknown>) => { added.push({ conditionId, input }); return { id: 900 + added.length }; } };
};

test("CID で作品に当たり、電子出版の料率条件に Excel の行（販売月 × 報告月 × 書店 × 価格）ごとに実績を立てる", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), w as any);
  const rows = [row({}), row({ store: "Kindle", downloads: 3, royaltyInFile: 855 }), row({ month: "2026-02", downloads: 2, royaltyInFile: 570 }),
                row({ downloads: 4, royaltyInFile: 1140 })];   // 同じ書店・同じ月・同じ価格 → 1 件に足す
  const p = await svc.preview(rows);
  assert.equal(p.groups.length, 3, "条件 × 販売月 × 報告月 × 書店 × 価格 で 1 件");
  const bw = p.groups.find((g) => g.month === "2026-01" && g.store === "BOOKWALKER（PC）")!;
  assert.equal(bw.downloads, 15);
  assert.equal(bw.gross, 28500);
  assert.equal(bw.royalty, 4275, "28,500 × 15% = 4,275");
  assert.equal(bw.status, "ok");
  assert.equal(bw.work!.via, "cid");
  const kindle = p.groups.find((g) => g.month === "2026-01" && g.store === "Kindle")!;
  assert.equal(kindle.gross, 5700);
  assert.deepEqual(p.counts.ok, 3);
  assert.deepEqual(p.months, ["2026-01", "2026-02"]);

  const done = await svc.commit(rows, "tester");
  assert.equal(done.written, 3);
  const first = w.added.find((a) => a.input.quantity === 15)!;
  assert.equal(first.conditionId, 50);
  assert.equal(first.input.usageType, undefined, "出版の実績は利用形態なし（台帳の報告と同じ）");
  assert.equal(first.input.grossAmount, 28500, "総額＝報告売上");
  assert.equal(first.input.amount, 28500);
  assert.equal(first.input.occurredOn, "2026-01-31");
  assert.equal(first.input.period, "2026年1月分");
  assert.equal(first.input.unitAmount, 1900);
  assert.equal(first.input.workId, 7);
  assert.equal(first.input.note, "電子書籍売上取込 2026-01｜BOOKWALKER（PC）｜報告月 2026-01");
});

test("印税の見込みは Excel と同じ行ごとの切り捨て（1,818 × 1 × 15% = 272.7 → 272）", async () => {
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), writer() as any);
  const p = await svc.preview([row({ store: "Apple Books", listPrice: 1818, downloads: 1, royaltyInFile: 272 })]);
  assert.equal(p.groups[0].royalty, 272);
  assert.equal(p.groups[0].royaltyInFile, 272);
});

test("期間は A 列の販売月。遅れて報告された販売月の行は、その販売月の実績（報告月は備考と鍵に残す）", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), w as any);
  // シート「2026年3月」に 販売月 2026-01 と 2025-11 の行。シート「2026年1月」にも販売月 2026-01 の同じ書店・価格の行。
  const rows = [row({ sheet: "2026年3月", reportMonth: "2026-03", month: "2026-01" }),
                row({ sheet: "2026年3月", reportMonth: "2026-03", month: "2025-11", store: "Kindle", downloads: 2 }),
                row({ sheet: "2026年1月", reportMonth: "2026-01", month: "2026-01", downloads: 4 })];
  const p = await svc.preview(rows);
  assert.equal(p.groups.length, 3, "同じ販売月・書店・価格でも報告月（シート）が違えば別の実績（Excel の行と同じ単位）");
  assert.deepEqual(p.groups.map((g) => [g.month, g.reportMonth]), [["2025-11", "2026-03"], ["2026-01", "2026-01"], ["2026-01", "2026-03"]]);
  assert.deepEqual(p.months, ["2025-11", "2026-01"]);
  await svc.commit(rows, "tester");
  assert.equal(w.added[0].input.period, "2025年11月分", "計算書の製品名は「2025年11月 作品名」になる");
  assert.equal(w.added[0].input.occurredOn, "2025-11-30");
  assert.equal(w.added[0].input.note, "電子書籍売上取込 2025-11｜Kindle｜報告月 2026-03");
  assert.equal(w.added[2].input.note, "電子書籍売上取込 2026-01｜BOOKWALKER（PC）｜報告月 2026-03");
  // シート名が月でなければ（CSV）報告月は無し。
  const csv = await svc.preview([row({ sheet: "売上.csv", reportMonth: null, month: "2026-01" })]);
  assert.equal(csv.groups[0].month, "2026-01");
  assert.equal(csv.groups[0].reportMonth, null);
});

test("登録済みの検査は販売月 × 報告月 × 書店 × 価格。遅れて報告された同じ販売月の行は落とさない", async () => {
  const existing = [{ condition_id: 50, period: "2026年1月分", unit_amount: 1900, note: "電子書籍売上取込 2026-01｜BOOKWALKER（PC）｜報告月 2026-01" }];
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL], existing }), writer() as any);
  const p = await svc.preview([row({ sheet: "2026年1月", reportMonth: "2026-01", month: "2026-01" }),
                               row({ sheet: "2026年4月", reportMonth: "2026-04", month: "2026-01" })]);
  assert.deepEqual(p.groups.map((g) => [g.reportMonth, g.status]), [["2026-01", "duplicate"], ["2026-04", "ok"]]);
});

test("CID が無ければ題名で当てる。登録したら CID を覚える", async () => {
  const w = writer();
  const fake = db({ titles: [{ id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] });
  const svc = new EbookSalesImportService(fake, w as any);
  const p = await svc.preview([row({})]);
  assert.equal(p.groups[0].work!.via, "title");
  await svc.commit([row({})], "tester");
  const remember = fake.find("INSERT INTO ebook_work_codes");
  assert.ok(remember, "次からは CID で当たるように覚える");
  assert.deepEqual(remember!.params.slice(0, 2), ["BT0001", 7]);
});

test("作品が分からない・条件が無い・印税なし・登録済み・0 を見分ける", async () => {
  const fixed = { id: 51, condition_no: "CL-2", work_id: 8, usage_type: "pub_digital", pricing_model: "fixed",
                  rate_ppm: null, status: "active", effective_from: null, party_name: "編集部", shares: null };
  const svc = new EbookSalesImportService(db({
    codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }, { cid: "BT0002", id: 8, title: "買い切り" }, { cid: "BT0003", id: 9, title: "条件なし" }],
    conditions: [DIGITAL, fixed],
    existing: [{ condition_id: 50, period: "2026年1月分", unit_amount: 1900, note: "電子書籍売上取込 2026-01｜BOOKWALKER（PC）" },
               { condition_id: 50, period: "2026年4月分", unit_amount: 1900, note: "電子書籍売上取込 2026-04（BOOKWALKER（PC））" }]
  }), writer() as any);
  const p = await svc.preview([
    row({}),                                        // 登録済み（同じ書店）
    row({ store: "Kindle" }),                       // ok（書店が違う）
    row({ month: "2026-04", store: "Kindle" }),     // 登録済み（書店の無い古い備考は、どの書店とも同じ扱い）
    row({ month: "2026-02" }),                      // ok
    row({ cid: "BT0002", title: "買い切り" }),       // 印税なし
    row({ cid: "BT0003", title: "条件なし" }),       // 条件なし
    row({ cid: "BT0009", title: "知らない作品" }),   // 作品が分からない
    row({ month: "2026-03", downloads: 0 })         // 0
  ]);
  const by = Object.fromEntries(p.groups.map((g) => [`${g.cid}|${g.month}|${g.store}`, g.status]));
  assert.equal(by["BT0001|2026-01|BOOKWALKER（PC）"], "duplicate");
  assert.equal(by["BT0001|2026-01|Kindle"], "ok");
  assert.equal(by["BT0001|2026-04|Kindle"], "duplicate");
  assert.equal(by["BT0001|2026-02|BOOKWALKER（PC）"], "ok");
  assert.equal(by["BT0002|2026-01|BOOKWALKER（PC）"], "no_royalty");
  assert.equal(by["BT0003|2026-01|BOOKWALKER（PC）"], "no_condition");
  assert.equal(by["BT0009|2026-01|BOOKWALKER（PC）"], "unresolved");
  assert.equal(by["BT0001|2026-03|BOOKWALKER（PC）"], "zero");
  assert.equal(p.counts.ok, 2);
});

test("CID → 作品 を決めて覚える", async () => {
  const fake = db();
  const svc = new EbookSalesImportService(fake, writer() as any);
  const r = await svc.mapCode("BT0009", 12, "知らない作品", "tester");
  assert.equal(r.workId, 12);
  assert.ok(fake.find("INSERT INTO ebook_work_codes"));
  await assert.rejects(() => svc.mapCode("  ", 12, null, "tester"), (e: unknown) => e instanceof DomainError);
});

test("作品に付いている CID を読む・外す", async () => {
  const fake = new FakeDatabase((text, params) => {
    if (text.includes("FROM ebook_work_codes WHERE work_id = $1")) {
      return [{ cid: "BT0001", title: "キズナバレット 1", created_by: "tester", created_at: "2026-10-06T00:00:00Z" }];
    }
    if (text.includes("DELETE FROM ebook_work_codes WHERE cid = $1")) return params[0] === "BT0001" ? [{ work_id: 7 }] : [];
    return undefined;
  });
  const svc = new EbookSalesImportService(fake, writer() as any);
  const codes = await svc.codesOf(7);
  assert.deepEqual(codes.map((c) => c.cid), ["BT0001"]);
  assert.deepEqual(await svc.unmapCode("BT0001", "tester"), { cid: "BT0001", workId: 7 });
  await assert.rejects(() => svc.unmapCode("BT9999", "tester"), (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND");
});

test("巻数：作品は作品名 × 巻数で 1 件。CID が無い行は「タイトル 巻数」の作品に当て、無ければシリーズ名の作品に載せない", async () => {
  assert.equal(volumeOf(3), "3"); assert.equal(volumeOf("第３巻"), "3"); assert.equal(volumeOf(""), null); assert.equal(volumeOf(1), "1");
  assert.deepEqual(volumeTitles("スピタのコピタの！", "3"), ["スピタのコピタの！ 3", "スピタのコピタの！ 第3巻", "スピタのコピタの！（3）", "スピタのコピタの！ vol.3"]);
  assert.deepEqual(volumeTitles("スピタのコピタの！", null), []);

  const titles = [{ id: 30, title: "スピタのコピタの！" }, { id: 33, title: "スピタのコピタの！ 3" }];
  const svc = new EbookSalesImportService(db({ titles, conditions: [{ ...DIGITAL, id: 60, work_id: 33 }] }), writer() as any);
  const p = await svc.preview([
    row({ cid: null, title: "スピタのコピタの！", volume: "3" }),   // 「スピタのコピタの！ 3」に当たる
    row({ cid: null, title: "スピタのコピタの！", volume: "5" }),   // 巻ごとの作品が無い → 当てない
    row({ cid: null, title: "スピタのコピタの！", volume: "1" })    // 1 巻はタイトルそのものでも可
  ]);
  assert.equal(p.groups.length, 3, "巻ごとに別のまとまり");
  const by = Object.fromEntries(p.groups.map((g) => [g.volume, g]));
  assert.equal(by["3"].work!.id, 33);
  assert.equal(by["3"].status, "ok");
  assert.equal(by["5"].status, "unresolved");
  assert.match(by["5"].message ?? "", /「スピタのコピタの！ 5」の作品がありません/);
  assert.deepEqual(by["5"].candidates.map((c: { id: number }) => c.id), [30], "候補にシリーズ名の作品は出す（人が選ぶ）");
  assert.equal(by["1"].work!.id, 30);
});

test("題名の部分一致：報告が題名を省いていても、登録の作品名が報告の題名を含み巻数も合う作品が 1 件ならそれに当てる", async () => {
  const n = normalizeTitle;
  assert.ok(titleContains(n("ブレイド・オブ・アルカナ ―聖痕英雄譚RPG― サプリメント　ソング・オブ・ホープ"), n("ソング・オブ・ホープ"), null));
  assert.ok(titleContains(n("サプリメント ソング・オブ・ホープ 第2巻"), n("ソング・オブ・ホープ"), "2"));
  assert.ok(titleContains(n("サプリメント ソング・オブ・ホープ（2）"), n("ソング・オブ・ホープ"), "2"));
  assert.ok(!titleContains(n("サプリメント ソング・オブ・ホープ 2"), n("ソング・オブ・ホープ"), null), "報告に巻が無ければ 2 巻には当てない");
  assert.ok(!titleContains(n("サプリメント ソング・オブ・ホープ"), n("ソング・オブ・ホープ"), "2"), "巻なしの作品に 2 巻は載せない");
  assert.ok(!titleContains(n("サプリメント ソング・オブ・ホープ 12"), n("ソング・オブ・ホープ"), "2"), "12 巻を 2 巻と読まない");
  assert.ok(titleContains(n("ソング・オブ・ホープ 設定資料集"), n("ソング・オブ・ホープ"), null), "後ろに別の語が続いても含めば候補");
  assert.ok(!titleContains(n("ソング・オブ・ホープ"), "", null));

  const partial = [
    { id: 70, title: "ブレイド・オブ・アルカナ ―聖痕英雄譚RPG― サプリメント　ソング・オブ・ホープ" },
    { id: 71, title: "ブレイド・オブ・アルカナ ―聖痕英雄譚RPG― サプリメント　ソング・オブ・ホープ 2" },
    { id: 80, title: "ガンドッグ 基本ルールブック" }, { id: 81, title: "ガンドッグゼロ" }
  ];
  const w = writer();
  const fake = db({ partial, conditions: [{ ...DIGITAL, id: 61, work_id: 70 }, { ...DIGITAL, id: 62, work_id: 71 }] });
  const svc = new EbookSalesImportService(fake, w as any);
  const p = await svc.preview([
    row({ cid: "SOH001", title: "ソング・オブ・ホープ", volume: null }),    // 70 に当たる
    row({ cid: "SOH002", title: "ソング・オブ・ホープ", volume: "2" }),     // 71 に当たる
    row({ cid: "GD0001", title: "ガンドッグ", volume: null }),             // 2 件 → 候補
    row({ cid: "XX0001", title: "知らない", volume: null })                // 当たらない
  ]);
  const by = Object.fromEntries(p.groups.map((g) => [g.cid, g]));
  assert.equal(by["SOH001"].work!.id, 70); assert.equal(by["SOH001"].work!.via, "partial"); assert.equal(by["SOH001"].status, "ok");
  assert.equal(by["SOH002"].work!.id, 71); assert.equal(by["SOH002"].status, "ok");
  assert.equal(by["GD0001"].status, "unresolved");
  assert.match(by["GD0001"].message ?? "", /題名を含む作品が 2 件/);
  assert.deepEqual(by["GD0001"].candidates.map((c: { id: number }) => c.id), [80, 81]);
  assert.equal(by["XX0001"].status, "unresolved");

  // 登録すると CID を覚えるので、次からは CID で当たる。
  await svc.commit([row({ cid: "SOH001", title: "ソング・オブ・ホープ", volume: null })], "tester");
  const remember = fake.all("INSERT INTO ebook_work_codes");
  assert.deepEqual(remember.map((q) => q.params.slice(0, 2)), [["SOH001", 70]]);
});

test("回（年 1 回の締め）があれば、販売月の末日を集計期間に含む回に実績を付ける。無ければ浮いた実績", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({
    codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL],
    schedules: [{ id: 90, condition_id: 50, label: "2025年7月〜2026年6月", due_on: "2026-06-30", service_from: "2025-07-01", service_to: "2026-06-30" },
                { id: 91, condition_id: 50, label: "2026年7月〜2027年6月", due_on: "2027-06-30", service_from: "2026-07-01", service_to: "2027-06-30" }]
  }), w as any);
  const rows = [row({ sheet: "2026年3月", reportMonth: "2026-03", month: "2026-01" }),
                row({ sheet: "2026年8月", reportMonth: "2026-08", month: "2026-07", store: "Kindle" })];
  const p = await svc.preview(rows);
  assert.deepEqual(p.groups.map((g) => g.round?.label), ["2025年7月〜2026年6月", "2026年7月〜2027年6月"]);
  await svc.commit(rows, "tester");
  assert.deepEqual(w.added.map((a) => a.input.scheduleId), [90, 91]);
  assert.equal(w.added[0].input.period, "2026年1月分", "期間は販売月のまま（回の名前で上書きしない）");

  const none = await new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), writer() as any)
    .preview([row({})]);
  assert.equal(none.groups[0].round, null);
  assert.equal(none.groups[0].status, "ok", "回が無くても登録はできる（浮いた実績）");
});

test("備考から書店と報告月を読む。月の部分が区切り（｜）をまたがない", async () => {
  const { storeOfNote, reportOfNote } = await import("./ebook-sales.js");
  assert.equal(storeOfNote("電子書籍売上取込 2026-01｜BOOKWALKER（PC）｜報告月 2026-03"), "BOOKWALKER（PC）");
  assert.equal(storeOfNote("電子書籍売上取込 2026-03｜Kindle｜販売月 2026-01"), "Kindle", "古い形（販売月つき）も書店を読む");
  assert.equal(storeOfNote("電子書籍売上取込 2026-03（BOOKWALKER（PC））"), null, "書店の無いとても古い形");
  assert.equal(reportOfNote("電子書籍売上取込 2026-01｜Kindle｜報告月 2026-03"), "2026-03");
  assert.equal(reportOfNote("電子書籍売上取込 2026-03｜Kindle｜販売月 2026-01"), null);
});

test("販売月の範囲：外の行は「範囲外」で登録しない（支払済みの月を二重に払わない・先の月は次の取込で）", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), w as any);
  const rows = [row({ sheet: "2025年8月", reportMonth: "2025-08", month: "2025-06" }),    // 支払済み
                row({ sheet: "2025年8月", reportMonth: "2025-08", month: "2025-07" }),
                row({ sheet: "2026年8月", reportMonth: "2026-08", month: "2026-06" }),
                row({ sheet: "2026年8月", reportMonth: "2026-08", month: "2026-07" })];   // 次の期
  const range = { fromMonth: "2025-07", toMonth: "2026-06" };
  const p = await svc.preview(rows, range);
  assert.deepEqual(p.groups.map((g) => [g.month, g.status]),
    [["2025-06", "out_of_range"], ["2025-07", "ok"], ["2026-06", "ok"], ["2026-07", "out_of_range"]]);
  assert.equal(p.counts.out_of_range, 2);
  assert.match(p.groups[0].message ?? "", /2025-07〜2026-06/);
  // 画面が全部の鍵を渡しても、範囲の外は登録しない。
  const done = await svc.commit(rows, "tester", { ...range, onlyKeys: p.groups.map((g) => g.key) });
  assert.equal(done.written, 2);
  assert.deepEqual(w.added.map((a) => a.input.period), ["2025年7月分", "2026年6月分"]);
  // 範囲を指定しなければ全部。
  assert.equal((await svc.preview(rows)).counts.ok, 4);
});
