import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { CONDITION_EXPORT_HEADERS, ConditionExportService, SERVICE_CONDITION_EXPORT_HEADERS,
         csvCell, toCsv } from "./export.js";

const row = {
  condition_no: "CL-2026-00451", usage_type: "pub_print", rate_ppm: 110000,
  exclusivity: "non_exclusive", mg_amount: 100000, ag_amount: null,
  term_start: "2026-10-01", term_end: "2031-09-30", currency: "JPY",
  payment_terms: "刷部数確定の都度、翌月末", notes: "初版1,000部（見本・献本除く）", status: "active",
  work_code: "WRK-1", work_title: "星降る夜のはなし", party_code: "V-1", party_name: "著者名",
  agreement_no: "AGR-2026-0001", regions: "全世界", languages: "日本語"
};

test("書き出しは取込と同じ見出し。料率は % に戻す", async () => {
  const db = new FakeDatabase(() => [row]);
  const csv = await new ConditionExportService(db).run({});
  const lines = csv.split("\r\n");
  assert.equal(lines[0], CONDITION_EXPORT_HEADERS.join(","));
  const cells = lines[1].split(",");
  assert.equal(cells[0], "CL-2026-00451");
  assert.equal(cells[1], "WRK-1");
  assert.equal(cells[6], "紙出版", "取引モデルは条件名の規則と同じ呼び名");
  assert.equal(cells[7], "11", "110000ppm → 11%");
  assert.equal(cells[8], "非独占");
  // 読点（、）は CSV の区切りではないので囲まない。半角カンマだけ囲む。
  assert.match(csv, /"初版1,000部（見本・献本除く）"/, "半角カンマを含む値は囲む");
});

test("絞り込みはそのまま SQL へ。上限は 5000 まで", async () => {
  const db = new FakeDatabase(() => []);
  await new ConditionExportService(db).run({ keyword: "ito", direction: "in", workId: 9, limit: 99999 });
  const q = db.queries[0];
  assert.match(q.text, /c\.direction = \$/);
  assert.match(q.text, /c\.work_id = \$/);
  assert.equal(q.params.at(-1), 5000);
  assert.match(q.text, /LIMIT \$\d+/, "上限は SQL に効かせる（渡すだけだと全件返る）");
  assert.match(q.text, /c\.status NOT IN \('void', 'superseded'\)/, "直せない版は既定で出さない");
  const all = new FakeDatabase(() => []);
  await new ConditionExportService(all).run({ includeVoid: true });
  assert.doesNotMatch(all.queries[0].text, /status NOT IN/, "「無効化済みも」なら全部出す");
});

test("引用の規則：区切り・引用符・改行を含むときだけ囲む", () => {
  assert.equal(csvCell("ふつう"), "ふつう");
  assert.equal(csvCell('言"葉'), '"言""葉"');
  assert.equal(csvCell("1行目\n2行目"), '"1行目\n2行目"');
  assert.equal(toCsv(["A", "B"], [[1, null]]), "A,B\r\n1,");
});

/**
 * 種類別の書き出し。許諾と業務委託などは持っている項目が違うので、別の表で出す。
 * 混ぜると委託料の行は作品も料率も空で出て、何が入っているのか読めない。
 */
const serviceRow = {
  condition_no: "CL-2026-00751", kind: "service", name: "表紙イラスト制作", pricing_model: "fixed",
  flat_amount: 120000, unit_amount: null, quantity: null, unit_label: null, currency: "JPY",
  term_start: "2026-08-01", term_end: null, delivery_due: "2026-11-30",
  payment_terms: "月末締め翌月末払い", contract_form: "請負", tax_category: "taxable",
  deliverable_ownership: "orderer", order_no: "PO-0012", spec: "表紙イラスト 1点", notes: null, status: "active",
  party_code: "PTY-2026-00008", party_name: "株式会社ブエノデザイン", agreement_no: "AGR-2026-0100",
  work_code: null, work_title: null, usage_type: null, rate_ppm: null, regions: null, languages: null
};

test("業務委託などの群は、委託料の列（金額・納期・仕様・税区分）で出す", async () => {
  const db = new FakeDatabase(() => [serviceRow]);
  const csv = await new ConditionExportService(db).run({ group: "service" });
  const lines = csv.split("\r\n");
  assert.equal(lines[0], SERVICE_CONDITION_EXPORT_HEADERS.join(","));
  const cells = lines[1].split(",");
  const at = (h: string) => cells[SERVICE_CONDITION_EXPORT_HEADERS.indexOf(h as never)];
  assert.equal(at("条件番号"), "CL-2026-00751");
  assert.equal(at("種類"), "委託料", "種類は画面と同じ言い方");
  assert.equal(at("相手先"), "株式会社ブエノデザイン");
  assert.equal(at("条件名"), "表紙イラスト制作");
  assert.equal(at("計算方式"), "定額");
  assert.equal(at("金額"), "120000", "最小通貨単位のまま（画面の入力欄と同じ）");
  assert.equal(at("納期"), "2026-11-30");
  assert.equal(at("税区分"), "課税");
  assert.equal(at("成果物の帰属"), "発注者");
  assert.equal(at("発注番号"), "PO-0012");
  assert.equal(at("仕様・成果物"), "表紙イラスト 1点");
  assert.equal(at("状態"), "active");
  assert.match(db.queries[0].text, /c\.kind <> 'license'/, "許諾の行は混ぜない");
  assert.match(db.queries[0].text, /ORDER BY p\.name/, "相手先ごとに並ぶ");
});

test("許諾の群（既定）は kind = license の行だけを出す", async () => {
  const db = new FakeDatabase(() => []);
  await new ConditionExportService(db).run({});
  assert.match(db.queries[0].text, /c\.kind = 'license'/, "委託料の行が許諾の列で出て半分空になるのを防ぐ");
});
