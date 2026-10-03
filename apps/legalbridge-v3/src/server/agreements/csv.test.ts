import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ImportService } from "../imports/service.js";
import { PartyAgreementMapService } from "./party-map.js";
import { agreementCsvPatch, agreementCsvValues } from "./csv.js";

const noParent = async () => { throw new Error("呼ばれない"); };

test("CSV の1行：空欄は触らない。書いた列だけ読む", async () => {
  assert.deepEqual(await agreementCsvPatch({ 契約ID: "1", 件名: "", 締結日: "" }, noParent), {});
  const p = await agreementCsvPatch({
    件名: "利用許諾基本契約", 種類: "基本契約", 種別: "ライセンス", 方向: "OUT",
    締結日: "2024/4/1", 有効開始日: "2024-04-01", 終了日: "なし", 自動更新: "する", 相手方番号: "K-001"
  }, noParent);
  assert.deepEqual(p, {
    title: "利用許諾基本契約", kind: "master", domain: "license", direction: "out",
    executedOn: "2024-04-01", effectiveOn: "2024-04-01", expiresOn: null, autoRenewal: true,
    counterpartyRefNo: "K-001"
  });
});

test("CSV の1行：親契約は番号から引き、「なし」で外す。画面ごとの呼び方も読む", async () => {
  const p = await agreementCsvPatch({ 種類: "覚書", 親契約番号: "ARC-LIC-2024-0012" }, async (no) => {
    assert.equal(no, "ARC-LIC-2024-0012");
    return 12;
  });
  assert.deepEqual(p, { kind: "supplement", parentId: 12 });
  assert.deepEqual(await agreementCsvPatch({ 親契約番号: "なし" }, noParent), { parentId: null });
});

test("CSV の1行：読めない値は断る（黙って読み飛ばさない）", async () => {
  await assert.rejects(agreementCsvPatch({ 種類: "基本" }, noParent), /種類は/);
  await assert.rejects(agreementCsvPatch({ 種別: "出版" }, noParent), /種別は/);
  await assert.rejects(agreementCsvPatch({ 方向: "両方" }, noParent), /方向は/);
  await assert.rejects(agreementCsvPatch({ 締結日: "R6.4.1" }, noParent), /締結日は/);
  await assert.rejects(agreementCsvPatch({ 自動更新: "たぶん" }, noParent), /自動更新は/);
});

test("書き出しの1行は、そのまま取り込み直せる形（ラベルで出す）", () => {
  const v = agreementCsvValues({
    id: 12, agreementNo: "ARC-LIC-2024-0012", partyName: "株式会社サンプル", partyCode: "V-1",
    title: "利用許諾基本契約", kind: "master", domain: "license", direction: "out", parentNo: null,
    executedOn: "2024-04-01", effectiveOn: "2024-04-01", expiresOn: null, autoRenewal: true,
    counterpartyRefNo: null, status: "executed", primary: true, issues: []
  });
  assert.equal(v.種類, "基本契約");
  assert.equal(v.種別, "ライセンス");
  assert.equal(v.方向, "OUT");
  assert.equal(v.自動更新, "する");
  assert.equal(v.状態, "締結済み");
  assert.equal(v.既定, "既定");
});

const current = {
  id: 30, kind: "supplement", domain: "license", direction: "out", parent_id: null, counterparty_id: 5,
  resolved_id: 5, child_count: 0, status: "executed", executed_on: "2025-01-15", title: "覚書",
  effective_on: null, expires_on: null, auto_renewal: false, counterparty_ref_no: null
};

const db = () => new FakeDatabase((t, params) => {
  if (t.includes("SELECT id, agreement_no, title FROM agreements WHERE id = $1")) {
    return Number(params[0]) === 30 ? [{ id: 30, agreement_no: "C-0100", title: "覚書" }] : [];
  }
  if (t.includes("SELECT id FROM agreements WHERE lower(btrim(agreement_no))")) {
    return String(params[0]) === "ARC-LIC-2024-0012" ? [{ id: 12 }] : [];
  }
  if (t.includes("SELECT id FROM agreements WHERE id = $1")) return [{ id: Number(params[0]) }];
  if (t.includes("FOR UPDATE OF a")) return [current];
  if (t.includes("SELECT a.id, a.kind, r.resolved_id")) {
    return Number(params[0]) === 12 ? [{ id: 12, kind: "master", resolved_id: 5 }]
                                    : [{ id: Number(params[0]), kind: "master", resolved_id: 8 }];
  }
  return [];
});

test("取込：試算は画面の編集と同じ検査を通し、書かずに巻き戻す", async () => {
  const d = db();
  const r = await new ImportService(d).run({
    kind: "agreements", dryRun: true, actor: "who",
    csv: "契約ID,契約番号,取引先,種類,親契約番号,状態\n" +
         "30,C-0100,株式会社サンプル,補助文書,ARC-LIC-2024-0012,締結済み\n" +
         "30,C-0100,株式会社サンプル,,,\n" +
         "999,,,,,\n" +
         "30,X-1,,,,"
  });
  assert.equal(r.mode, "update", "基本契約は指定が無くても既存に当てる");
  assert.deepEqual(r.rows.map((x) => x.status), ["ok", "skip", "error", "error"]);
  assert.match(r.rows[0].message!, /親契約 を更新します/);
  assert.match(r.rows[2].message!, /契約ID 999/);
  assert.match(r.rows[3].message!, /契約番号は C-0100/);
  assert.ok(!d.texts.includes("COMMIT"), "試算は書き込みを確定しない");
});

test("取込：親が別の取引先の契約なら断る（画面と同じ）", async () => {
  const r = await new ImportService(db()).run({
    kind: "agreements", dryRun: true, actor: "who",
    csv: "契約ID,親契約番号\n30,#77"
  });
  assert.equal(r.rows[0].status, "error");
  assert.match(r.rows[0].message!, /相手先が違います/);
});

test("取込：契約IDも契約番号も無い CSV は断る", async () => {
  await assert.rejects(new ImportService(db()).run({ kind: "agreements", dryRun: true, actor: "who", csv: "件名\nx" }),
                       /契約ID」か「契約番号/);
});

test("書き出し：ずれと既定を画面と同じ判定で付ける", async () => {
  const d = new FakeDatabase((t) => t.includes("FROM agreements a") ? [
    { id: 1, agreement_no: "A-1", title: "基本", kind: "master", domain: null, direction: "out", status: "executed",
      executed_on: "2024-04-01", counterparty_id: 5, resolved_id: 5, resolved_name: "株式会社サンプル", resolved_code: "V-1" },
    { id: 2, agreement_no: "A-1-S01", title: "覚書", kind: "supplement", domain: null, direction: "out", status: "executed",
      parent_id: 1, parent_no: "A-1", parent_resolved_id: 5, parent_kind: "master",
      counterparty_id: 5, resolved_id: 5, resolved_name: "株式会社サンプル", resolved_code: "V-1" }
  ] : []);
  const rows = await new PartyAgreementMapService(d).exportRows();
  assert.equal(rows[0].primary, true);
  assert.match(rows[0].issues[0], /種別/);
  assert.equal(rows[1].parentNo, "A-1");
  assert.equal(rows[1].partyCode, "V-1");
});
