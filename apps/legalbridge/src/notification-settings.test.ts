import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_DEFINITIONS, NOTIFICATION_SETTING_KEYS, matchesChannelQuery,
  notificationIdForLedgerKind, parseEnabled, resolveNotification
} from "./notification-settings.js";

// ── ON/OFF の読み取り ────────────────────────────────────────────────
// 未保存（空）は「既定どおり配信する」。ここを false 側に倒すと、設定画面を
// 一度も触っていない環境で通知が全部止まる。
test("未設定・空欄は配信する", () => {
  assert.equal(parseEnabled(undefined), true);
  assert.equal(parseEnabled(null), true);
  assert.equal(parseEnabled(""), true);
  assert.equal(parseEnabled("   "), true);
});

test("false と読める値だけ停止する", () => {
  for (const off of ["false", "FALSE", " off ", "0", "no"]) assert.equal(parseEnabled(off), false, off);
  for (const on of ["true", "TRUE", "on", "1", "yes"]) assert.equal(parseEnabled(on), true, on);
});

// ── 宛先の解決 ──────────────────────────────────────────────────────
test("宛先が空欄なら法務相談チャンネルへ落とす", () => {
  const resolved = resolveNotification({}, "delivery_alert", "C0LEGAL0001");
  assert.deepEqual(resolved, { enabled: true, channelId: "C0LEGAL0001" });
});

test("通知ごとに別のチャンネルを指定できる", () => {
  const values = {
    NOTIFY_DELIVERY_ALERT_CHANNEL: "C0DELIVERY1",
    NOTIFY_INSPECTION_DIGEST_CHANNEL: "C0INSPECT1"
  };
  assert.equal(resolveNotification(values, "delivery_alert", "C0LEGAL0001").channelId, "C0DELIVERY1");
  assert.equal(resolveNotification(values, "inspection_digest", "C0LEGAL0001").channelId, "C0INSPECT1");
  // 指定していないものは既定のまま。
  assert.equal(resolveNotification(values, "contract_alert", "C0LEGAL0001").channelId, "C0LEGAL0001");
});

test("法務相談チャンネルも未設定なら宛先は空（＝投稿しない）", () => {
  assert.equal(resolveNotification({}, "contract_alert", "").channelId, "");
});

test("前後の空白は落とす（貼り付け事故で投稿先を失わない）", () => {
  assert.equal(resolveNotification({ NOTIFY_CONTRACT_ALERT_CHANNEL: " C0ABCDEFG1 " }, "contract_alert", "").channelId,
    "C0ABCDEFG1");
});

test("OFF は宛先が入っていても enabled=false", () => {
  const resolved = resolveNotification(
    { NOTIFY_DELIVERY_ALERT_ENABLED: "false", NOTIFY_DELIVERY_ALERT_CHANNEL: "C0DELIVERY1" },
    "delivery_alert", "C0LEGAL0001");
  assert.deepEqual(resolved, { enabled: false, channelId: "C0DELIVERY1" });
});

// ── 台帳 kind → 通知種別 ────────────────────────────────────────────
// daily-checks は 1 回の実行で 2 種類の通知を出す。振り分けを間違えると
// 「納期アラートを止めたのに契約アラートまで止まる」ことになる。
test("納期系の kind は納期アラートに寄せる", () => {
  for (const kind of ["delivery_7d", "delivery_3d", "delivery_1d", "delivery_overdue"]) {
    assert.equal(notificationIdForLedgerKind(kind), "delivery_alert", kind);
  }
});

test("契約更新は契約アラート、未知の kind は null", () => {
  assert.equal(notificationIdForLedgerKind("contract_renewal"), "contract_alert");
  assert.equal(notificationIdForLedgerKind("something_else"), null);
});

// ── 定義そのもの ────────────────────────────────────────────────────
test("設定キーは通知ごとに ON/OFF と宛先の2本", () => {
  assert.equal(NOTIFICATION_SETTING_KEYS.length, NOTIFICATION_DEFINITIONS.length * 2);
  assert.equal(new Set(NOTIFICATION_SETTING_KEYS).size, NOTIFICATION_SETTING_KEYS.length);
});

test("V2 で実際に配信している3種類だけを扱う", () => {
  assert.deepEqual(NOTIFICATION_DEFINITIONS.map((d) => d.id),
    ["delivery_alert", "contract_alert", "inspection_digest"]);
});

// ── チャンネルの絞り込み ────────────────────────────────────────────
test("チャンネル名の部分一致で引ける", () => {
  const legal = { id: "C0LEGAL0001", name: "legal-consult" };
  assert.equal(matchesChannelQuery(legal, "consult"), true);
  assert.equal(matchesChannelQuery(legal, "LEGAL"), true);
  assert.equal(matchesChannelQuery(legal, "#legal"), true);   // # を付けて打っても外さない
  assert.equal(matchesChannelQuery(legal, "C0LEGAL"), true);  // ID でも引ける
  assert.equal(matchesChannelQuery(legal, "sales"), false);
  assert.equal(matchesChannelQuery(legal, "   "), true);      // 空は全件
});
