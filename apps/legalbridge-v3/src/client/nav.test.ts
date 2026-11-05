import test from "node:test";
import assert from "node:assert/strict";
import { ALL_HUBS, NAV, NAV_VIEWS, activeHub, activeTab, visibleTabs } from "./nav.js";

test("メニューは ホーム／作業台／一括処理／監査・設定 の 4 項目（UI 再構築 手順 2）", () => {
  assert.deepEqual(ALL_HUBS.map((h) => h.label), ["ホーム", "作業台", "一括処理", "監査・設定"]);
  assert.deepEqual(NAV.map((s) => s.section), [null], "区分の見出しは出さない");
});

test("今ある画面はすべてどこかの項目から開ける（古い URL・ほかの画面からの飛び先が生きる。旧 回の一覧は App が支払文書へ転送）", () => {
  for (const v of ["home", "desk", "intake", "daily", "matters", "workbench", "paydocs", "deals", "agreements", "agreement-map",
                   "conditions", "works", "parties", "documents", "ringi", "rpt", "closing", "money", "drift", "flows", "ops", "condition-check"]) {
    assert.ok(NAV_VIEWS.has(v), v);
  }
  const opsTabs = ALL_HUBS.flatMap((h) => h.tabs).filter((t) => t.to.view === "ops").map((t) => t.to.sub).sort();
  assert.deepEqual(opsTabs, ["audit", "audit-report", "contracts", "deadlines", "exports", "fixes", "imports", "integrations",
                             "leftovers", "quality", "sending", "settings", "snippets", "statement-models"].sort(),
    "運用のタブはどれも 1 回だけ、どこかの項目に入る");
});

test("同じタブは 2 回並べない（まとめて締めるは一括処理だけ）", () => {
  const keys = ALL_HUBS.flatMap((h) => h.tabs).map((t) => `${t.to.view}:${t.to.sub ?? ""}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("光らせる項目：受付はホーム、台帳と日々の作業は作業台、運用はタブまで見る", () => {
  assert.equal(activeHub("intake", null, null)?.key, "home");
  assert.equal(activeHub("daily", null, null)?.key, "home");
  for (const v of ["desk", "matters", "parties", "works", "agreements", "agreement-map", "conditions", "documents", "ringi", "deals", "money"]) {
    assert.equal(activeHub(v, null, null)?.key, "desk", v);
  }
  assert.equal(activeHub("paydocs", null, null)?.key, "bulk");
  assert.equal(activeHub("closing", null, null)?.key, "bulk");
  assert.equal(activeHub("ops", "imports", null)?.key, "bulk");
  assert.equal(activeHub("ops", "deadlines", null)?.key, "audit");
  assert.equal(activeHub("ops", "snippets", null)?.key, "audit");
  assert.equal(activeHub("ops", null, null)?.key, "audit", "タブ未指定の運用はデータ品質");
  assert.equal(activeTab(activeHub("ops", null, null)!, "ops", null)?.label, "データ品質");
});

test("作業テーブル：一括（発注書 CSV・検収済みの遡及）は一括処理、それ以外は作業台", () => {
  assert.equal(activeHub("workbench", "orders", "desk")?.key, "bulk", "sub まで当たる項目が先");
  assert.equal(activeHub("workbench", null, "bulk")?.key, "desk");
  const hub = activeHub("workbench", "settled", null)!;
  assert.equal(hub.key, "bulk");
  assert.equal(activeTab(hub, "workbench", "settled")?.label, "過去分を入れる（検収済み）");
});

test("タブの小見出し：同じ group が続けて並ぶ", () => {
  for (const hub of ALL_HUBS) {
    const groups = hub.tabs.map((t) => t.group).filter((g): g is string => Boolean(g));
    const runs = groups.filter((g, i) => g !== groups[i - 1]);
    assert.equal(new Set(runs).size, runs.length, `${hub.label}：同じ小見出しが離れて 2 回出ない`);
  }
});

test("設定の『設定』タブは管理者だけ", () => {
  const audit = ALL_HUBS.find((h) => h.key === "audit")!;
  assert.ok(visibleTabs(audit, true).some((t) => t.to.sub === "settings"));
  assert.ok(!visibleTabs(audit, false).some((t) => t.to.sub === "settings"));
});
