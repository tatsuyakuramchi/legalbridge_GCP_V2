import test from "node:test";
import assert from "node:assert/strict";
import { ALL_HUBS, NAV, NAV_VIEWS, activeHub, activeTab, visibleTabs } from "./nav.js";

test("メニューの区分は ホーム／格納情報／作業／一括処理／マネージメント／監査／設定 の順", () => {
  assert.deepEqual(NAV.map((s) => s.section), [null, "格納情報の登録・編集", "作業", "一括処理", "マネージメント", "監査", null]);
  assert.deepEqual(NAV[2].hubs.map((h) => h.label), ["受付", "取引開始作業", "支払処理作業"]);
});

test("今ある画面はすべてどこかの項目から開ける（古い URL・ほかの画面からの飛び先が生きる。旧 回の一覧は App が支払文書へ転送）", () => {
  for (const v of ["home", "intake", "daily", "matters", "workbench", "paydocs", "deals", "agreements", "agreement-map",
                   "conditions", "works", "parties", "documents", "ringi", "rpt", "closing", "money", "drift", "flows", "ops", "condition-check"]) {
    assert.ok(NAV_VIEWS.has(v), v);
  }
  const opsTabs = ALL_HUBS.flatMap((h) => h.tabs).filter((t) => t.to.view === "ops").map((t) => t.to.sub).sort();
  assert.deepEqual(opsTabs, ["audit", "audit-report", "contracts", "deadlines", "exports", "fixes", "imports", "integrations",
                             "leftovers", "quality", "sending", "settings", "snippets", "statement-models"].sort(),
    "運用のタブはどれも 1 回だけ、どこかの項目に入る");
});

test("光らせる項目：運用はタブまで見る。受付箱とデイリータスクは受付", () => {
  assert.equal(activeHub("ops", "imports", null)?.key, "bulk-register");
  assert.equal(activeHub("ops", "deadlines", null)?.key, "monitor");
  assert.equal(activeHub("ops", null, null)?.key, "check", "タブ未指定の運用はデータ品質");
  assert.equal(activeHub("intake", null, null)?.key, "reception");
  assert.equal(activeHub("daily", null, null)?.key, "reception");
  assert.equal(activeHub("agreement-map", null, null)?.key, "agreements");
});

test("同じ画面が 2 つの項目にあれば、最後に押した方。sub まで当たる項目が先", () => {
  assert.equal(activeHub("closing", null, null)?.key, "payment", "既定は先に並ぶ支払処理作業");
  assert.equal(activeHub("closing", null, "bulk-make")?.key, "bulk-make");
  // 作業テーブルを一括（発注書 CSV）で開いたら、取引開始作業を押したあとでも一括処理を光らせる。
  assert.equal(activeHub("workbench", "orders", "start")?.key, "bulk-make");
  assert.equal(activeHub("workbench", null, "bulk-make")?.key, "start", "一括でない作業テーブルは取引開始作業");
  const hub = activeHub("workbench", "settled", null)!;
  assert.equal(hub.key, "bulk-fix");
  assert.equal(activeTab(hub, "workbench", "settled")?.label, "過去分を入れる（検収済み）");
});

test("設定の『設定』タブは管理者だけ", () => {
  const settings = ALL_HUBS.find((h) => h.key === "settings")!;
  assert.ok(visibleTabs(settings, true).some((t) => t.to.sub === "settings"));
  assert.ok(!visibleTabs(settings, false).some((t) => t.to.sub === "settings"));
});
