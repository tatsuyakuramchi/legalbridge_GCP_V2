import test from "node:test";
import assert from "node:assert/strict";
import { agreementVersions, diffVersions, noteAgreementChange } from "./versions.js";

test("版の違い：変わった項目だけを、画面の言葉で（前 → 後）", () => {
  const prev = { id: 1, title: "利用許諾基本契約", status: "negotiating", executed_on: null, effective_on: null, auto_renewal: false, parent_id: null, kind: "standalone" };
  const next = { id: 1, title: "利用許諾基本契約", status: "executed", executed_on: "2026-12-01", effective_on: "2026-12-01", auto_renewal: true, parent_id: 7, kind: "supplement" };
  const changes = diffVersions(prev, next, { parties: new Map(), agreements: new Map([[7, "ATT-2026-00069"]]), documents: new Map() });
  assert.deepEqual(changes.map((c) => `${c.label}：${c.from}→${c.to}`), [
    "状態：交渉中→締結済み", "締結日：（なし）→2026-12-01", "有効期間の開始：（なし）→2026-12-01",
    "自動更新：なし→あり", "種類：単体契約→個別契約・覚書", "親の契約：（なし）→ATT-2026-00069"]);
  assert.deepEqual(diffVersions(prev, { ...prev }), [], "同じなら空");
});

test("版の一覧：新しい順。第 1 版は中身の要約、以降は前の版との違い。表が無ければ available=false", async () => {
  const rows = [
    { version_no: 1, change_kind: "baseline", changed_by: null, reason: "履歴を取り始めた時点の内容", changed_at: "2026-11-01T00:00:00Z",
      snapshot: { id: 5, agreement_no: "ARC-LIC-2026-0001", title: "基本契約", status: "negotiating", executed_on: null, counterparty_id: 9 } },
    { version_no: 2, change_kind: "changed", changed_by: "tester", reason: "契約のまき直し", changed_at: "2026-12-01T00:00:00Z",
      snapshot: { id: 5, agreement_no: "ARC-LIC-2026-0001", title: "基本契約", status: "executed", executed_on: "2026-12-01", counterparty_id: 9 } }
  ];
  const db = { query: async (sql: string) => ({ rows: /FROM agreement_versions/.test(sql) ? rows : /FROM parties/.test(sql) ? [{ id: 9, name: "山田 太郎" }] : [] }) };
  const out = await agreementVersions(db as any, 5);
  assert.equal(out.available, true);
  assert.deepEqual(out.versions.map((v) => v.versionNo), [2, 1]);
  assert.deepEqual(out.versions[0]!.changes.map((c) => c.label), ["状態", "締結日"]);
  assert.equal(out.versions[0]!.reason, "契約のまき直し");
  assert.deepEqual(out.versions[1]!.changes, []);
  assert.equal(out.versions[1]!.summary.agreementNo, "ARC-LIC-2026-0001");

  const missing = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  assert.deepEqual(await agreementVersions(missing as any, 5), { available: false, versions: [] });
});

test("変更の前に、だれが・なぜを渡す（トリガーが読む）", async () => {
  const calls: unknown[][] = [];
  await noteAgreementChange({ query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [] }; } } as any, "user@example.test", " まき直し ");
  assert.deepEqual(calls, [["user@example.test", "まき直し"]]);
});
