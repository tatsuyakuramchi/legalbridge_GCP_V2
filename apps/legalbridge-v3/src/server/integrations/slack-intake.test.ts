import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import {
  buildAcknowledgement, buildIntakeModal, INTAKE_CALLBACK_ID, parseSubmission
} from "./slack-intake.js";
import { IntakeService } from "./intake-service.js";

const view = (over: Record<string, any> = {}) => ({
  callback_id: INTAKE_CALLBACK_ID,
  state: {
    values: {
      kind: { value: { selected_option: { value: "outsourcing" } } },
      title: { value: { value: "イラスト制作を依頼したい" } },
      counterparty: { value: { value: "株式会社甲" } },
      due: { value: { selected_date: "2026-10-31" } },
      detail: { value: { value: "A4・カラー・3点" } },
      ...over
    }
  }
});
const payload = (over: Record<string, any> = {}) =>
  ({ view: view(), user: { id: "U123", name: "kuramochi" }, ...over });

test("フォームは依頼の種類と件名を必須にする", () => {
  const modal = buildIntakeModal();
  const required = modal.blocks.filter((b: any) => b.type === "input" && !b.optional)
    .map((b: any) => b.block_id);
  assert.deepEqual(required, ["kind", "title"]);
});

test("種類は案件のフロー種別に1対1で対応する", () => {
  const modal = buildIntakeModal();
  const kind = modal.blocks.find((b: any) => b.block_id === "kind") as any;
  assert.deepEqual(kind.element.options.map((o: any) => o.value),
    ["outsourcing", "work", "single"]);
});

test("送信内容を読み取る", () => {
  const s = parseSubmission(payload());
  assert.equal(s.kind, "outsourcing");
  assert.equal(s.title, "イラスト制作を依頼したい");
  assert.equal(s.counterpartyName, "株式会社甲");
  assert.equal(s.dueOn, "2026-10-31");
  assert.equal(s.requesterSlackId, "U123");
});

test("空欄は null にする。空文字を業務データに入れない", () => {
  const s = parseSubmission(payload({
    view: { ...view(), state: { values: { ...view().state.values,
      counterparty: { value: { value: "   " } }, due: { value: {} }, detail: { value: { value: "" } } } } }
  }));
  assert.equal(s.counterpartyName, null);
  assert.equal(s.dueOn, null);
  assert.equal(s.detail, null);
});

test("種類も件名も無ければ受け付けない", () => {
  const noKind = { ...view(), state: { values: { ...view().state.values, kind: { value: {} } } } };
  assert.throws(() => parseSubmission({ ...payload(), view: noKind }), /種類を選んでください/);
  const noTitle = { ...view(), state: { values: { ...view().state.values, title: { value: { value: "" } } } } };
  assert.throws(() => parseSubmission({ ...payload(), view: noTitle }), /件名を書いてください/);
});

test("別のフォームの送信は受け付けない", () => {
  assert.throws(
    () => parseSubmission({ ...payload(), view: { ...view(), callback_id: "other" } }),
    /この受付フォームの送信ではありません/);
});

// ---- 案件にする ----

const build = (parties: any[]) => new FakeDatabase((t) => {
  if (t.includes("FROM parties p\n               JOIN v_party_resolved")) return parties;
  if (t.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
  if (t.includes("UPDATE document_sequences")) return [{ current_value: 220 }];
  if (t.includes("FROM matters WHERE matter_no")) return [];
  if (t.includes("INSERT INTO matters")) return [{ id: 42, matter_no: "MTR-2026-00220" }];
  return undefined;
});

test("相手先が1件に決まれば紐づける", async () => {
  const db = build([{ id: 5, name: "株式会社甲" }]);
  const r = await new IntakeService(db).accept(parseSubmission(payload()));
  assert.equal(r.counterpartyId, 5);
  assert.equal(r.counterpartyResolved, "株式会社甲");
  assert.match(r.message, /MTR-2026-00220/);
});

test("候補が複数なら紐づけない。取り違えるより未設定のほうがまし", async () => {
  const db = build([{ id: 5, name: "株式会社甲" }, { id: 9, name: "株式会社甲" }]);
  const r = await new IntakeService(db).accept(parseSubmission(payload()));
  assert.equal(r.counterpartyId, null);
});

test("未登録の相手先で新しい取引先を作らない", async () => {
  const db = build([]);
  await new IntakeService(db).accept(parseSubmission(payload()));
  assert.ok(!db.queries.some((q) => q.text.includes("INSERT INTO parties")),
    "Slack から打ち込まれた表記ゆれをマスタに増やさない");
});

test("紐づかなかったことを課題として残す。放置されないように", async () => {
  const db = build([]);
  await new IntakeService(db).accept(parseSubmission(payload()));
  const issue = db.find("INSERT INTO data_quality_issues")!;
  assert.equal(issue.params[0], 42);
  assert.match(String(issue.params[1]), /株式会社甲/);
});

test("相手先を書かなければ課題も立てない", async () => {
  const db = build([]);
  const s = parseSubmission(payload());
  await new IntakeService(db).accept({ ...s, counterpartyName: null });
  assert.equal(db.find("INSERT INTO data_quality_issues"), undefined);
});

test("返す文面に案件番号を必ず入れる", () => {
  const msg = buildAcknowledgement({
    matterNo: "MTR-2026-00220", matterId: 42,
    submission: parseSubmission(payload()), counterpartyResolved: null
  });
  assert.match(msg, /MTR-2026-00220/);
  assert.match(msg, /未登録のため、法務側で登録します/);
});
