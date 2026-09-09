import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentBatchService, groupRows, ownershipOfRows, readRows, templateCsv } from "./batch-service.js";

const CSV = `取引先コード,取引先名,品目・業務名,仕様・成果物,数量,単価（税抜）,納期,支払日,成果物の帰属先,支払方法,備考
VD-00317,合同会社アトリエ蒼,第4巻 表紙イラスト,カラー1点,1,150000,2026-10-31,2026-11-30,発注者,固定額,
VD-00317,合同会社アトリエ蒼,第4巻 挿絵,モノクロ12点,12,"8,000",2026/10/31,2026-11-30,発注者（譲渡型）,,
,ヨシザワ アツオ,第4巻 地図イラスト,見開き1点,1,60000,2026-10-15,2026-11-30,発注者,固定額,
VD-00120,株式会社ヒナタ翻訳,英訳,全章,1,200000,2026-12-20,2027-01-31,発注者,業績連動,`;

test("雛形の見出しは列の定義から出す（BOM 付き）", () => {
  const csv = templateCsv();
  assert.ok(csv.startsWith("﻿取引先コード,取引先名,品目・業務名"));
  assert.ok(csv.includes("成果物の帰属先,支払方法,備考"));
});

test("行を明細として読む。桁区切り・スラッシュの日付・帰属先の表記ゆれを吸収する", () => {
  const rows = readRows(CSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].item.unit_price, 8000);
  assert.equal(rows[1].item.quantity, 12);
  assert.equal(rows[1].item.amount_ex_tax, 96000);
  assert.equal(rows[1].item.delivery_date, "2026-10-31");
  assert.equal(rows[1].item.deliverable_ownership, "発注者");
  assert.equal(rows[1].item.calc_method, "FIXED", "空なら固定額");
  assert.deepEqual(rows[1].issues, []);
  assert.match(rows[3].issues[0], /固定額 だけ/);
});

test("見出しが雛形と違えば止める", () => {
  assert.throws(() => readRows("a,b,c\\n1,2,3"), /見出しが雛形と合いません/);
});

test("同じ取引先の行は1束（1枚の発注書）にまとまる。鍵はコード、無ければ名前", () => {
  const groups = groupRows(readRows(CSV));
  assert.equal(groups.length, 3);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].total, 246000);
  assert.equal(groups[1].key, "name:ヨシザワ アツオ");
});

/** 取引先の当たり方。コード → 名前 の順で、1件に決まるときだけ。 */
const parties = (t: string, params: unknown[]) => {
  if (t.includes("lower(btrim(party_code))")) {
    return params[0] === "VD-00317" ? [{ id: 2, name: "合同会社アトリエ蒼", party_code: "VD-00317" }]
      : params[0] === "VD-00120" ? [{ id: 5, name: "株式会社ヒナタ翻訳", party_code: "VD-00120" }] : [];
  }
  if (t.includes("btrim(name) = btrim($1)")) {
    return params[0] === "合同会社アトリエ蒼" ? [{ id: 2, name: "合同会社アトリエ蒼", party_code: "VD-00317" }]
      : params[0] === "株式会社ヒナタ翻訳" ? [{ id: 9, name: "株式会社ヒナタ翻訳", party_code: "VD-00388" }] : [];
  }
  return undefined;
};

const build = (extra: (t: string, p: unknown[]) => Array<Record<string, unknown>> | undefined = () => undefined) => {
  const db = new FakeDatabase((t, p) => extra(t, p) ?? parties(t, p) ?? (
    t.includes("FROM matters WHERE id") ? [{ id: 3, kind: "outsourcing", title: "第4巻 挿絵発注" }] : undefined));
  const svc = new DocumentBatchService(db, {} as any, {} as any, {} as any);
  return { db, svc };
};

test("突き合わせ：1件に決まれば作る、コードと名前が別を指せば選ぶ、当たらなければ飛ばす", async () => {
  const { db, svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV });
  assert.deepEqual(r.groups.map((g) => g.action), ["create", "skip", "choose"]);
  assert.equal(r.groups[0].party?.id, 2);
  assert.equal(r.groups[0].condition.mode, "new");
  assert.deepEqual(r.groups[2].candidates.map((c) => c.id), [5, 9], "コードの当たりを先に出す");
  assert.equal(r.summary.creatable, 1);
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.choose, 1);
  assert.equal(db.find("INSERT INTO"), undefined, "突き合わせでは何も作らない");
});

test("突き合わせ：候補を選べば作れる側に移る。ただし行の不備（固定額以外）は飛ばす", async () => {
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV,
                                choices: { "code:vd-00120": 5 } });
  assert.equal(r.groups[2].resolution, "resolved");
  assert.equal(r.groups[2].action, "skip", "支払方法が業績連動の行があるので作れない");
  assert.match(r.groups[2].issues.join(" "), /固定額 だけ/);
});

test("突き合わせ：その取引先の定額・委託料の条件がこの案件にあれば「既存」に当てる", async () => {
  const { svc } = build((t) =>
    t.includes("c.pricing_model = 'fixed'") ? [{ id: 44, condition_no: "CL-2026-00044" }] : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV });
  assert.deepEqual(r.groups[0].condition, { mode: "existing", id: 44, conditionNo: "CL-2026-00044" });
});

test("発注書以外のひな形では一括を受けない", async () => {
  const { svc } = build();
  await assert.rejects(
    () => svc.preview({ templateKey: "license_master", matterId: 3, csv: CSV }), /発注書（国内・海外）だけ/);
});

test("束の帰属先は行が揃っているときだけ条件に持たせる", () => {
  const rows = readRows(CSV);
  assert.equal(ownershipOfRows(rows.slice(0, 2)), "orderer");
  const mixed = [rows[0], { ...rows[3], item: { ...rows[3].item, deliverable_ownership: "受注者" } }];
  assert.equal(ownershipOfRows(mixed), null, "発注者と受注者が混ざっている");
  assert.equal(ownershipOfRows([{ ...rows[0], item: { ...rows[0].item, deliverable_ownership: null } }]), null, "空なら決めない");
});
