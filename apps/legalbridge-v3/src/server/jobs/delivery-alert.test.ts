import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DeliveryAlertJob, alertKindFor, recipientsFor, alertBody, tokyoToday, type DeliveryItem } from "./delivery-alert.js";
import {
  DEFAULT_DELIVERY_ALERT, parseDeliveryAlertSettings, readDeliveryAlertSettings, type DeliveryAlertSettings
} from "../ops/delivery-alert-settings.js";

const item = (over: Partial<DeliveryItem> = {}): DeliveryItem => ({
  conditionId: 10, scheduleId: null, due: "2026-10-05", daysUntil: 7, item: "挿絵 第4巻 制作委託",
  party: "合同会社アトリエ蒼", matterId: 1, matterNo: "MTR-2026-00217", matterTitle: "挿絵 追加発注",
  requesterSlackId: "U_REQ", requesterDepartment: "制作部", ownerSlackId: "U_LEGAL",
  purchaseOrderNo: "ARC-PO-2026-1001", ...over
});
const settings = (over: Partial<DeliveryAlertSettings> = {}) => ({ ...DEFAULT_DELIVERY_ALERT, ...over });

// ---- 設定 ----

test("設定が無ければ既定値（7・3・1 日前、超過は平日 30 日まで、依頼者に DM）", () => {
  const s = readDeliveryAlertSettings(undefined);
  assert.deepEqual(s.daysBefore, [7, 3, 1]);
  assert.equal(s.overdueUntilDays, 30);
  assert.equal(s.notifyRequester, true);
});

test("チャンネル名を ID の欄に入れたら保存させない（毎朝どこにも届かないのを防ぐ）", () => {
  const r = parseDeliveryAlertSettings({ ...DEFAULT_DELIVERY_ALERT, channels: [{ id: "#legal", label: "" }] });
  assert.match(r.errors.join(), /チャンネル ID「#legal」の形が違います/);
});

test("文面の知らない差込は保存させない。何日前は重ねず大きい順に", () => {
  const r = parseDeliveryAlertSettings({ ...DEFAULT_DELIVERY_ALERT, daysBefore: [1, 7, 7, 3],
    templates: { before: "あと {のこり} 日", overdue: "超過" } });
  assert.match(r.errors.join(), /\{のこり\} は差し込めません/);
  assert.deepEqual(r.value.daysBefore, [7, 3, 1]);
  assert.match(parseDeliveryAlertSettings({ ...DEFAULT_DELIVERY_ALERT, daysBefore: [0] }).errors.join(), /1〜90/);
});

// ---- 判定 ----

test("何日前はその日ちょうどだけ。当日は知らせない", () => {
  const s = settings();
  assert.equal(alertKindFor(item({ daysUntil: 7 }), s, "2026-09-28"), "before");
  assert.equal(alertKindFor(item({ daysUntil: 6 }), s, "2026-09-28"), null);
  assert.equal(alertKindFor(item({ daysUntil: 0 }), s, "2026-09-28"), null);
});

test("超過は平日だけ、設定した日数まで", () => {
  const s = settings();
  assert.equal(alertKindFor(item({ daysUntil: -2 }), s, "2026-09-28"), "overdue");        // 月曜
  assert.equal(alertKindFor(item({ daysUntil: -2 }), s, "2026-09-27"), null);             // 日曜
  assert.equal(alertKindFor(item({ daysUntil: -31 }), s, "2026-09-28"), null);            // 30 日を超えた
  assert.equal(alertKindFor(item({ daysUntil: -300 }), settings({ overdueUntilDays: 0 }), "2026-09-28"), "overdue");
  assert.equal(alertKindFor(item({ daysUntil: -2 }), settings({ overdue: false }), "2026-09-28"), null);
});

test("送り先：依頼者・担当・チャンネル・依頼者の部署のチャンネル。重なりは1つに", () => {
  const s = settings({
    notifyOwner: true,
    channels: [{ id: "C_ALL", label: "" }],
    departmentChannels: [{ department: "制作部", id: "C_SEISAKU" }, { department: "営業部", id: "C_EIGYO" },
                         { department: "制作部", id: "C_ALL" }]
  });
  assert.deepEqual(recipientsFor(item(), s).map((r) => r.to), ["U_REQ", "U_LEGAL", "C_ALL", "C_SEISAKU"]);
  assert.deepEqual(recipientsFor(item(), settings({ notifyRequester: false })).map((r) => r.to), []);
});

test("文面は設定のものに差し込む", () => {
  const s = settings({ templates: { before: "{依頼者} {案件番号} あと{残り日数}日 {納期} {発注書番号}", overdue: "{超過日数}日超過" } });
  assert.equal(alertBody("before", item({ daysUntil: 3 }), s), "<@U_REQ> MTR-2026-00217 あと3日 2026年10月5日 ARC-PO-2026-1001");
  assert.equal(alertBody("overdue", item({ daysUntil: -4 }), s), "4日超過");
});

test("東京の今日で切る（UTC ではまだ前日の朝 8 時）", () => {
  assert.equal(tokyoToday(new Date("2026-09-27T23:30:00Z")), "2026-09-28");
});

// ---- ジョブ ----

const row = (over: Record<string, unknown> = {}) => ({
  condition_id: 10, schedule_id: null, due: "2026-10-05", item: "挿絵 第4巻 制作委託", days_until: 7,
  party: "合同会社アトリエ蒼", matter_id: 1, matter_no: "MTR-2026-00217", matter_title: "挿絵 追加発注",
  requester_slack_id: "U_REQ", owner_slack_id: "U_LEGAL", requester_department: "制作部", po_no: "ARC-PO-2026-1001",
  ...over
});
const db = (o: { setting?: unknown; rows?: any[]; sent?: string[] } = {}) => new FakeDatabase((t) => {
  if (t.includes("FROM settings WHERE key")) return o.setting === undefined ? [] : [{ value: o.setting }];
  if (t.includes("WITH base AS")) return o.rows ?? [];
  if (t.includes("action = 'delivery.alert'")) return (o.sent ?? []).map((k) => ({ idempotency_key: k }));
  return undefined;
});
const job = (d: FakeDatabase) => {
  const sent: Array<[string, string]> = [];
  const j = new DeliveryAlertJob({
    database: d, today: () => "2026-09-28",
    send: async (_c, to, body) => { sent.push([to, body]); return true; }
  });
  return { j, sent };
};

test("知らせる日の項目だけ、送り先ごとに送って、冪等キーで記録する", async () => {
  const d = db({ rows: [row(), row({ condition_id: 11, days_until: 5 })],
                 setting: { ...DEFAULT_DELIVERY_ALERT, channels: [{ id: "C_ALL", label: "" }] } });
  const { j, sent } = job(d);
  const r = await j.run();
  assert.equal(r.pending, 2);
  assert.equal(r.alerts.length, 1, "5 日前は知らせる日ではない");
  assert.deepEqual(sent.map(([to]) => to), ["U_REQ", "C_ALL"]);
  assert.match(sent[0][1], /納期まであと 7 日です/);
  const keys = d.all("INSERT INTO audit_events").map((q) => q.params[4]);
  assert.ok(keys.includes("delivery-alert:10:-:2026-09-28"));
});

test("同じ日に二度流しても二度は送らない", async () => {
  const { j, sent } = job(db({ rows: [row()], sent: ["delivery-alert:10:-:2026-09-28"] }));
  const r = await j.run();
  assert.equal(r.alreadySent, 1);
  assert.equal(sent.length, 0);
});

test("送り先が無ければ送らずに数える（画面で気づけるように）", async () => {
  const { j, sent } = job(db({ rows: [row({ requester_slack_id: null })] }));
  const r = await j.run();
  assert.equal(r.noRecipient.length, 1);
  assert.equal(sent.length, 0);
});

test("止めてあれば送らない。プレビューは止めていても見られて、送りも記録もしない", async () => {
  const off = { ...DEFAULT_DELIVERY_ALERT, enabled: false };
  assert.equal((await job(db({ rows: [row()], setting: off })).j.run()).ran, false);

  const d = db({ rows: [row()], setting: off });
  const { j, sent } = job(d);
  const r = await j.run({ preview: true });
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].body!, /MTR-2026-00217/);
  assert.equal(sent.length, 0);
  assert.equal(d.all("INSERT INTO audit_events").length, 0);
});
