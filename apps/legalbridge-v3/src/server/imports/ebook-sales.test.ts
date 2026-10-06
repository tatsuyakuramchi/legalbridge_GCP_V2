import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DomainError } from "../core/errors.js";
import {
  EbookSalesImportService, monthEnd, monthLabel, monthOf, normalizeTitle, readRows, readWorkbookRows, rowsOfSheet,
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
  title: "キズナバレット 1", authors: "からすば晴┴N.G.P.", cid: "BT0001", listPrice: 1900, storeRatePct: 55,
  downloads: 11, netAmount: 11495, royaltyInFile: 3135, ...over
});

interface Options {
  codes?: Array<{ cid: string; id: number; title: string }>;
  titles?: Array<{ id: number; title: string }>;
  conditions?: Array<Record<string, unknown>>;
  existing?: Array<{ condition_id: number; period: string; unit_amount: number }>;
}
const db = (o: Options = {}) => new FakeDatabase((text, params) => {
  if (text.includes("FROM ebook_work_codes c JOIN works w")) {
    return (o.codes ?? []).filter((c) => (params[0] as string[]).includes(c.cid)).map((c) => ({ cid: c.cid, id: c.id, title: c.title, work_code: null }));
  }
  if (text.includes("regexp_replace(lower(title)")) return (o.titles ?? []).map((t) => ({ ...t, work_code: null }));
  if (text.includes("FROM conditions c LEFT JOIN parties p")) return o.conditions ?? [];
  if (text.includes("e.event_type = 'sales' AND c.id = ANY")) return o.existing ?? [];
  if (text.includes("SELECT id, title FROM works WHERE id = $1")) return [{ id: params[0], title: "作品" }];
  return undefined;
});
const DIGITAL = { id: 50, condition_no: "CL-1", work_id: 7, usage_type: "pub_digital", pricing_model: "revenue_rate",
                  rate_ppm: 150000, status: "active", effective_from: null, party_name: "からすば晴", shares: null };

const writer = () => {
  const added: Array<{ conditionId: number; input: Record<string, unknown> }> = [];
  return { added, add: async (conditionId: number, input: Record<string, unknown>) => { added.push({ conditionId, input }); return { id: 900 + added.length }; } };
};

test("CID で作品に当たり、電子出版の料率条件にまとめて実績を立てる（配信価格 × DL数 × 料率）", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), w as any);
  const rows = [row({}), row({ store: "Kindle", downloads: 3, royaltyInFile: 855 }), row({ month: "2026-02", downloads: 2, royaltyInFile: 570 })];
  const p = await svc.preview(rows);
  assert.equal(p.groups.length, 2, "条件 × 月 × 価格 で 1 件");
  assert.equal(p.groups[0].downloads, 14);
  assert.equal(p.groups[0].gross, 26600);
  assert.equal(p.groups[0].royalty, 3990, "26,600 × 15% = 3,990（Excel の行ごとの切り捨ても 3,990）");
  assert.equal(p.groups[0].status, "ok");
  assert.equal(p.groups[0].work!.via, "cid");
  assert.deepEqual(p.counts.ok, 2);
  assert.deepEqual(p.months, ["2026-01", "2026-02"]);

  const done = await svc.commit(rows, "tester");
  assert.equal(done.written, 2);
  assert.equal(w.added[0].conditionId, 50);
  assert.equal(w.added[0].input.usageType, undefined, "出版の実績は利用形態なし（台帳の報告と同じ）");
  assert.equal(w.added[0].input.grossAmount, 26600, "総額＝報告売上");
  assert.equal(w.added[0].input.amount, 26600);
  assert.equal(w.added[0].input.occurredOn, "2026-01-31");
  assert.equal(w.added[0].input.period, "2026年1月分");
  assert.equal(w.added[0].input.unitAmount, 1900);
  assert.equal(w.added[0].input.quantity, 14);
  assert.equal(w.added[0].input.workId, 7);
});

test("期間はシート名の月（報告月）。遅れて報告された販売月の行も同じ報告月にまとめ、販売月は備考に書く", async () => {
  const w = writer();
  const svc = new EbookSalesImportService(db({ codes: [{ cid: "BT0001", id: 7, title: "キズナバレット 1" }], conditions: [DIGITAL] }), w as any);
  // シート「2026年3月」に 販売月 2026-01 と 2025-11 の行。
  const rows = [row({ sheet: "2026年3月", reportMonth: "2026-03", month: "2026-01" }),
                row({ sheet: "2026年3月", reportMonth: "2026-03", month: "2025-11", store: "Kindle", downloads: 2 })];
  const p = await svc.preview(rows);
  assert.equal(p.groups.length, 1, "報告月 × 価格 で 1 件");
  assert.equal(p.groups[0].month, "2026-03");
  assert.deepEqual(p.groups[0].salesMonths, ["2026-01", "2025-11"]);
  assert.deepEqual(p.months, ["2026-03"]);
  await svc.commit(rows, "tester");
  assert.equal(w.added[0].input.period, "2026年3月分", "計算書の製品名は「2026年3月 作品名」になる");
  assert.equal(w.added[0].input.occurredOn, "2026-03-31");
  assert.match(String(w.added[0].input.note), /販売月 2026-01・2025-11/);
  // シート名が月でなければ（CSV）販売月で持つ。
  const csv = await svc.preview([row({ sheet: "売上.csv", reportMonth: null, month: "2026-01" })]);
  assert.equal(csv.groups[0].month, "2026-01");
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
    existing: [{ condition_id: 50, period: "2026年1月分", unit_amount: 1900 }]
  }), writer() as any);
  const p = await svc.preview([
    row({}),                                        // 登録済み
    row({ month: "2026-02" }),                      // ok
    row({ cid: "BT0002", title: "買い切り" }),       // 印税なし
    row({ cid: "BT0003", title: "条件なし" }),       // 条件なし
    row({ cid: "BT0009", title: "知らない作品" }),   // 作品が分からない
    row({ month: "2026-03", downloads: 0 })         // 0
  ]);
  const by = Object.fromEntries(p.groups.map((g) => [`${g.cid}|${g.month}`, g.status]));
  assert.equal(by["BT0001|2026-01"], "duplicate");
  assert.equal(by["BT0001|2026-02"], "ok");
  assert.equal(by["BT0002|2026-01"], "no_royalty");
  assert.equal(by["BT0003|2026-01"], "no_condition");
  assert.equal(by["BT0009|2026-01"], "unresolved");
  assert.equal(by["BT0001|2026-03"], "zero");
  assert.equal(p.counts.ok, 1);
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
