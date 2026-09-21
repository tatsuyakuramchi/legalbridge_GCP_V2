import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { SettledExportService, firstEditionLine, inspectedQtyOf, itemsOf, payStateOf } from "./settled-export.js";
import { SETTLED_COLUMNS } from "./settled-batch.js";

const cond = (over: Record<string, unknown> = {}) => ({
  id: 7, condition_no: "CL-2026-00001", name: "挿絵 制作委託", kind: "service",
  unit_amount: 35000, flat_amount: null, quantity: 1,
  payment_terms: "月末締め翌月末払い", contract_form: "請負",
  deliverable_ownership: "orderer",
  party_code: "VD-00317", party_name: "受託者名",
  work_code: "WRK-10013", work_title: "星降る夜のミュゼ",
  agreement_no: "AG-2026-0001", ...over
});

const db = (over: Record<string, any[]> = {}) => new FakeDatabase((t) => {
  for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
  if (t.includes("FROM matters WHERE id")) {
    return [{ id: 1, matter_no: "MTR-2026-00001", title: "挿絵 追加発注" }];
  }
  if (t.includes("FROM conditions c")) return [cond()];
  return [];
});

test("紙の明細から1行ずつ書き出す", async () => {
  const made = await new SettledExportService(db({
    "'items'": [{ id: 50, document_no: "ARC-PO-2026-0115", issued_at: "2026-06-01T00:00:00Z",
                  values: { items: [
                    { item_name: "第4巻 表紙", spec: "カラー1点", quantity: 1,
                      unit_price: 150000, payment_terms: "請負" },
                    { item_name: "第1巻 挿絵", spec: "モノクロ12点", quantity: 12,
                      unit_price: 8000, payment_terms: "請負" }
                  ] } }],
    "FROM condition_events e\n        WHERE": [
      { id: 90, occurred_on: "2026-07-20", quantity: 1, amount: 150000,
        deliverable: null, note: null, document_id: 60 },
      { id: 91, occurred_on: "2026-07-31", quantity: 11, amount: 88000,
        deliverable: null, note: "納品点数が11点になったため減額", document_id: 60 }
    ],
    "e.document_id = d.id": [{ id: 60, document_no: "ARC-INS-2026-0059",
      issued_at: "2026-08-05T00:00:00Z",
      values: { delivery_line_items: [
        { inspected_quantity: 1 },
        { inspected_quantity: 11, changeNote: "納品点数が11点になったため減額" }
      ] } }],
    "FROM payments y": [{ status: "planned", due_on: "2026-09-30", paid_on: null }]
  })).forMatter(1);

  assert.equal(made.rows.length, 2);
  const [a, b] = made.rows;
  assert.equal(a?.item_name, "第4巻 表紙");
  assert.equal(a?.unit_price, "150000");
  assert.equal(a?.orderedOn, "2026-06-01");
  assert.equal(a?.inspectedOn, "2026-08-05");
  assert.equal(a?.deliveredOn, "2026-07-20");
  // 数量どおりに納まった行は検収数量を空にする（取り込みが数量に揃える）。
  assert.equal(a?.inspectedQuantity, "");
  // 減った行だけ検収数量と理由を書く。
  assert.equal(b?.inspectedQuantity, "11");
  assert.equal(b?.varianceNote, "納品点数が11点になったため減額");
  assert.equal(b?.quantity, "12");
  assert.equal(a?.paymentState, "未払");
  assert.equal(a?.dueOn, "2026-09-30");
  assert.equal(a?.partyCode, "VD-00317");
  assert.equal(a?.workCode, "WRK-10013");
  assert.equal(a?.deliverable_ownership, "発注者");
  assert.equal(a?.contract_form, "請負");
  // 条件名は必ず入れる。空だと取り込みが人ごとの条件を1本にまとめてしまう。
  assert.equal(a?.conditionName, "挿絵 制作委託");
});

test("単価が無ければ金額から割り戻す（0では割らない）", async () => {
  const made = await new SettledExportService(db({
    "'items'": [{ id: 50, document_no: "PO", issued_at: "2026-06-01T00:00:00Z",
                  values: { items: [
                    { item_name: "挿絵", quantity: 4, amount_ex_tax: 40000 },
                    { item_name: "監修", quantity: 0, amount_ex_tax: 50000 }
                  ] } }]
  })).forMatter(1);
  assert.equal(made.rows[0]?.unit_price, "10000");
  // 0 で割らない。空で出して人に入れてもらう（条件の単価に落ちる）。
  assert.equal(made.rows[1]?.unit_price, "35000");
});

test("紙が無ければ実績から組み、確かめるよう書き添える", async () => {
  const made = await new SettledExportService(db({
    "FROM condition_events e\n        WHERE": [
      { id: 90, occurred_on: "2026-07-20", quantity: 2, amount: 70000,
        deliverable: "挿絵2点", note: null, document_id: null }
    ]
  })).forMatter(1);
  assert.equal(made.rows.length, 1);
  assert.equal(made.rows[0]?.item_name, "挿絵2点");
  assert.equal(made.rows[0]?.unit_price, "35000");
  assert.equal(made.rows[0]?.deliveredOn, "2026-07-20");
  assert.ok(made.notes.some((n) => /実績から組みました/.test(n.note)));
  assert.ok(made.notes.some((n) => /発注書が見つかりません/.test(n.note)));
});

test("紙も実績も無ければ条件そのものを1行にする", async () => {
  const made = await new SettledExportService(db()).forMatter(1);
  assert.equal(made.rows.length, 1);
  assert.equal(made.rows[0]?.item_name, "挿絵 制作委託");
  assert.equal(made.rows[0]?.paymentState, "なし");
  assert.ok(made.notes.some((n) => /紙も実績もありません/.test(n.note)));
});

test("基本契約が無ければ「なし」と書く（空だと自動で当てにいく）", async () => {
  const made = await new SettledExportService(
    db({ "FROM conditions c": [cond({ agreement_no: null })] })).forMatter(1);
  assert.equal(made.rows[0]?.agreementNo, "なし");
});

test("発注書が複数あれば、どれを使ったかを書き添える", async () => {
  const made = await new SettledExportService(db({
    "'items'": [
      { id: 51, document_no: "ARC-PO-2026-0115-R2", issued_at: "2026-06-10T00:00:00Z",
        values: { items: [{ item_name: "挿絵", quantity: 1, unit_price: 35000 }] } },
      { id: 50, document_no: "ARC-PO-2026-0115", issued_at: "2026-06-01T00:00:00Z",
        values: { items: [{ item_name: "挿絵", quantity: 1, unit_price: 30000 }] } }
    ]
  })).forMatter(1);
  assert.equal(made.rows[0]?.unit_price, "35000");
  assert.ok(made.notes.some((n) => /ARC-PO-2026-0115-R2/.test(n.note)));
});

test("支払の状態は CSV の言葉で出す", () => {
  assert.equal(payStateOf(null), "なし");
  assert.equal(payStateOf({ status: "planned" }), "未払");
  assert.equal(payStateOf({ status: "approved" }), "未払");
  assert.equal(payStateOf({ status: "paid" }), "支払済み");
});

test("明細でない rendered_values は空として扱う", () => {
  assert.deepEqual(itemsOf(null), []);
  assert.deepEqual(itemsOf("文字列"), []);
  assert.deepEqual(itemsOf({ items: "配列ではない" }), []);
  assert.deepEqual(itemsOf({ items: [null, 1, { a: 1 }] }), [{ a: 1 }]);
});

test("書き出した CSV は取り込みの見出しと同じ並び（そのまま入れ直せる）", async () => {
  const made = await new SettledExportService(db()).forMatter(1);
  // 先頭の BOM は Excel が文字コードを取り違えないための印。取り込み側も同じ。
  assert.ok(made.csv.startsWith("\uFEFF"), "BOM が無い");
  assert.equal(made.csv.slice(1).split(/\r?\n/)[0],
    SETTLED_COLUMNS.map((c) => c.label).join(","));
});

test("無い案件は NOT_FOUND", async () => {
  const empty = new FakeDatabase(() => []);
  await assert.rejects(() => new SettledExportService(empty).forMatter(9), /見つかりません/);
});

// ---------------------------------------------------------------------------

test("減額が金額にしか残っていなければ、単価で割り戻して検収数量にする", () => {
  const said: string[] = [];
  const at = (over: Record<string, unknown> = {}) => inspectedQtyOf({
    quantity: 12, unitPrice: 8000, del: null, ev: { amount: 88000 },
    name: "挿絵", say: (n) => said.push(n), ...over
  });
  // 96,000 の発注に対して実績 88,000 → 11点
  assert.equal(at(), 11);
  // 発注どおりなら空（取り込みが数量に揃える）
  assert.equal(at({ ev: { amount: 96000 } }), null);
  // 書いてあればそれを使う
  assert.equal(at({ del: { inspected_quantity: 10 } }), 10);
  assert.equal(at({ del: { inspected_quantity: 12 } }), null);
  assert.equal(said.length, 0);
});

test("割り切れない減額は空のままにして、はっきり書き添える", () => {
  const said: string[] = [];
  const got = inspectedQtyOf({
    quantity: 12, unitPrice: 8000, del: null, ev: { amount: 90000 },
    name: "挿絵", say: (n) => said.push(n)
  });
  // 推測で数量を書かない。紙の合計と単価×数量が合わない行ができる。
  assert.equal(got, null);
  assert.match(said[0] ?? "", /割り切れません/);
  // 空のままだと高い額で作り直される、という危なさを書いておく。
  assert.match(said[0] ?? "", /発注どおりの額で作り直されます/);
});

test("単価が無ければ割り戻さない（0では割らない）", () => {
  const said: string[] = [];
  const say = (n: string) => said.push(n);
  assert.equal(inspectedQtyOf({ quantity: 1, unitPrice: null, del: null,
    ev: { amount: 88000 }, name: "x", say }), null);
  assert.equal(inspectedQtyOf({ quantity: 1, unitPrice: 0, del: null,
    ev: { amount: 88000 }, name: "x", say }), null);
  assert.equal(said.length, 0);
});

test("金額でしか減額が残っていない紙を、減った額のまま書き出す", async () => {
  const made = await new SettledExportService(db({
    "'items'": [{ id: 50, document_no: "ARC-PO-2026-0059", issued_at: "2026-06-01T00:00:00Z",
      values: { items: [
        { item_name: "表紙イラスト", quantity: 1, unit_price: 150000 },
        { item_name: "挿絵", quantity: 12, unit_price: 8000 }
      ] } }],
    // 実績は額だけ下がっていて、数量は空（手元の写しの ARC-IN-2026-0005 と同じ形）。
    "FROM condition_events e\n        WHERE": [
      { id: 96, occurred_on: "2026-07-20", quantity: null, amount: 150000,
        deliverable: null, note: null, document_id: 60 },
      { id: 97, occurred_on: "2026-07-22", quantity: null, amount: 88000,
        deliverable: null, note: null, document_id: 60 }
    ],
    "e.document_id = d.id": [{ id: 60, document_no: "ARC-IN-2026-0005",
      issued_at: "2026-07-25T00:00:00Z",
      values: { delivery_line_items: [
        { inspected_quantity: null }, { inspected_quantity: null, changeNote: "1点取りやめ" }
      ] } }]
  })).forMatter(1);
  assert.equal(made.rows[0]?.inspectedQuantity, "");
  assert.equal(made.rows[1]?.inspectedQuantity, "11");
  assert.equal(made.rows[1]?.varianceNote, "1点取りやめ");
  // 12 × 8,000 のまま入れ直すと 96,000 になってしまう。そこを外さない。
  assert.equal(made.rows[1]?.quantity, "12");
  assert.equal(made.rows[1]?.unit_price, "8000");
});

test("取り込みが弾く行を、書き出した時点で言う", async () => {
  const made = await new SettledExportService(db({
    "'items'": [{ id: 50, document_no: "PO", issued_at: "2026-06-01T00:00:00Z",
      values: { items: [{ item_name: "挿絵", quantity: 12, unit_price: 8000 }] } }],
    // 減額は金額にしか残っていない。理由の文は紙のどこにも無い。
    "FROM condition_events e\n        WHERE": [
      { id: 97, occurred_on: "2026-07-22", quantity: null, amount: 88000,
        deliverable: null, note: null, document_id: 60 }
    ],
    "e.document_id = d.id": [{ id: 60, document_no: "INS", issued_at: "2026-07-25T00:00:00Z",
      values: { delivery_line_items: [{ inspected_quantity: null, changeNote: "" }] } }]
  })).forMatter(1);
  assert.equal(made.rows[0]?.inspectedQuantity, "11");
  assert.equal(made.rows[0]?.varianceNote, "");
  // 上げ直してから「飛ばす」と言われるのでは遅い。
  const said = made.notes.map((n) => n.note).join("\n");
  assert.match(said, /このままでは取り込みに弾かれます/);
  assert.match(said, /変更理由/);
});

test("不備のない行では何も言わない", async () => {
  const made = await new SettledExportService(db({
    "'items'": [{ id: 50, document_no: "PO", issued_at: "2026-06-01T00:00:00Z",
      values: { items: [{ item_name: "表紙", quantity: 1, unit_price: 150000 }] } }],
    "FROM condition_events e\n        WHERE": [
      { id: 96, occurred_on: "2026-07-20", quantity: 1, amount: 150000,
        deliverable: null, note: null, document_id: 60 }
    ],
    "e.document_id = d.id": [{ id: 60, document_no: "INS", issued_at: "2026-07-25T00:00:00Z",
      values: { delivery_line_items: [{ inspected_quantity: 1 }] } }]
  })).forMatter(1);
  assert.equal(made.notes.filter((n) => /弾かれます/.test(n.note)).length, 0);
});

// ---------------------------------------------------------------------------
// 初版として出す（検収まで終わっているのを、いま文書化する）
// ---------------------------------------------------------------------------

test("初版は実際に検収した数で1本にする（起きていない減額を刷らない）", () => {
  const said: string[] = [];
  const at = (over: Record<string, unknown> = {}) => firstEditionLine({
    mode: "first_edition", quantity: 12, unitPrice: 8000, inspected: 11,
    amount: 88000, name: "挿絵", say: (n) => said.push(n), ...over
  });
  assert.deepEqual(at(), { quantity: 11, unitPrice: 8000, inspected: null });
  // 発注どおりなら（検収数量なし）そのまま。
  assert.deepEqual(at({ inspected: null, amount: 96000 }),
    { quantity: 12, unitPrice: 8000, inspected: null });
  assert.equal(said.length, 0);
});

test("現物どおりのときは触らない", () => {
  assert.deepEqual(firstEditionLine({
    mode: "as_is", quantity: 12, unitPrice: 8000, inspected: 11,
    amount: 88000, name: "挿絵", say: () => {}
  }), { quantity: 12, unitPrice: 8000, inspected: 11 });
});

test("数量で表せない額は1式にして、刻みが消えたことを言う", () => {
  const said: string[] = [];
  const got = firstEditionLine({
    mode: "first_edition", quantity: 12, unitPrice: 8000, inspected: null,
    amount: 90000, name: "挿絵", say: (n) => said.push(n)
  });
  assert.deepEqual(got, { quantity: 1, unitPrice: 90000, inspected: null });
  assert.match(said[0] ?? "", /1式として単価に置きました/);
});

test("初版で書き出すと、取り込みに弾かれる行が消える", async () => {
  const fixture = {
    "'items'": [{ id: 50, document_no: "PO", issued_at: "2026-06-01T00:00:00Z",
      values: { items: [{ item_name: "挿絵", quantity: 12, unit_price: 8000 }] } }],
    "FROM condition_events e\n        WHERE": [
      { id: 97, occurred_on: "2026-07-22", quantity: null, amount: 88000,
        deliverable: null, note: null, document_id: 60 }
    ],
    "e.document_id = d.id": [{ id: 60, document_no: "INS", issued_at: "2026-07-25T00:00:00Z",
      values: { delivery_line_items: [{ inspected_quantity: null, changeNote: "" }] } }]
  };
  const asIs = await new SettledExportService(db(fixture)).forMatter(1);
  assert.match(asIs.notes.map((n) => n.note).join("\n"), /弾かれます/);

  const first = await new SettledExportService(db(fixture)).forMatter(1, "first_edition");
  assert.equal(first.rows[0]?.quantity, "11");
  assert.equal(first.rows[0]?.unit_price, "8000");
  assert.equal(first.rows[0]?.inspectedQuantity, "");
  assert.equal(first.rows[0]?.varianceNote, "");
  // 発注書と検収書が同じ数を言うので、紙に「変更内容の確認」は出ない。
  assert.equal(first.notes.filter((n) => /弾かれます/.test(n.note)).length, 0);
  // 額は変わらない。11 × 8,000 = 88,000。
  assert.equal(Number(first.rows[0]?.quantity) * Number(first.rows[0]?.unit_price), 88000);
});


test("書き出しは条件番号を入れる（名前だけだと同名の条件を取り違える）", async () => {
  const made = await new SettledExportService(db()).forMatter(1);
  assert.equal(made.rows[0]?.conditionNo, "CL-2026-00001");
  assert.equal(made.rows[0]?.conditionName, "挿絵 制作委託");
});
