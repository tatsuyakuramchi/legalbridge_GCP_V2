import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { BacklogService, issueDescription, issueSummary } from "./backlog-service.js";
import type { DispatchOutcome } from "./dispatch-service.js";

const matter = (over: Record<string, unknown> = {}) => ({
  id: 8, matter_no: "MTR-2026-00219", title: "イラスト制作の発注",
  kind: "outsourcing", status: "open", due_on: "2026-10-31", remarks: "急ぎ",
  party_name: "合同会社アトリエ蒼", owner_name: "法務 太郎", ...over
});

const gate = (mode: any = "live", blockers: any[] = []) => ({
  channel: "backlog" as const, mode, allowed: !blockers.length,
  previewable: blockers.every((b) => b === "dry_run"), blockers, reasons: blockers
});

const stub = (outcome: Partial<DispatchOutcome>) => ({
  dispatch: async (input: any) => {
    calls.push(input);
    return { channel: "backlog", sent: false, gate: gate(), ...outcome } as DispatchOutcome;
  }
}) as any;

let calls: any[] = [];
const db = (linked: any[] = [], head = [matter()], heldByOther: any[] = []) => {
  calls = [];
  return new FakeDatabase((t) => {
    if (t.includes("SELECT target_ref FROM matter_links")) return linked;
    if (t.includes("l.matter_id <> $2")) return heldByOther;
    if (t.includes("FROM matters m")) return head;
    if (t.includes("SELECT id, matter_no FROM matters")) return head;
    return [];
  });
};

const service = (database: FakeDatabase, outcome: Partial<DispatchOutcome>) =>
  new BacklogService(database, stub(outcome), { host: "arch.backlog.jp", issueTypeId: "77" });

test("件名は案件番号を頭に置く（Backlog 側で検索できるように）", () => {
  assert.equal(issueSummary(matter() as any), "[MTR-2026-00219] イラスト制作の発注");
  assert.equal(issueSummary({ matter_no: null, title: "無番" } as any), "無番");
});

test("本文は Backlog だけ見ている人が状況を掴めるだけ入れる", () => {
  const text = issueDescription(matter());
  for (const expected of ["MTR-2026-00219", "業務委託・発注", "合同会社アトリエ蒼", "2026-10-31", "法務 太郎"]) {
    assert.ok(text.includes(expected), `${expected} が本文に無い`);
  }
  assert.ok(text.includes("状態は Backlog で進めてください"));
});

test("相手先も期日も未設定なら、空欄ではなく未特定と書く", () => {
  const text = issueDescription(matter({ party_name: null, due_on: null, owner_name: null }));
  assert.ok(text.includes("相手先：（未特定）"));
  assert.ok(text.includes("期日：（未設定）"));
});

test("課題が立ったら紐づけを作る（受信が案件を辿れるようにする）", async () => {
  const database = db();
  const r = await service(database, { sent: true, externalId: "LEGAL-12" })
    .createIssue(8, "legal@arch.co.jp");

  assert.equal(r.created, true);
  assert.equal(r.issueKey, "LEGAL-12");
  assert.equal(r.url, "https://arch.backlog.jp/view/LEGAL-12");
  const link = database.find("INSERT INTO matter_links")!;
  assert.match(link.text, /'backlog_issue'/);
  assert.deepEqual(link.params.slice(0, 2), [8, "LEGAL-12"]);
});

test("課題種別IDを宛先として渡す", async () => {
  await service(db(), { sent: true, externalId: "LEGAL-12" }).createIssue(8, "a");
  assert.equal(calls[0].request.recipient, "77");
  assert.equal(calls[0].targetType, "matter");
  assert.equal(calls[0].targetId, 8);
});

test("二度押しても課題は増やさない", async () => {
  const database = db([{ target_ref: "LEGAL-12" }]);
  const r = await service(database, { sent: true, externalId: "LEGAL-99" })
    .createIssue(8, "a");

  assert.equal(r.created, false);
  assert.equal(r.issueKey, "LEGAL-12");
  assert.equal(calls.length, 0, "送信そのものを試さない");
  assert.equal(database.find("INSERT INTO matter_links"), undefined);
});

test("ゲートで止まったら紐づけを作らない（立っていない課題を指さない）", async () => {
  const database = db();
  const r = await service(database, {
    sent: false, gate: gate("off", ["channel_off"]) }).createIssue(8, "a");

  assert.equal(r.created, false);
  assert.equal(r.issueKey, null);
  assert.equal(database.find("INSERT INTO matter_links"), undefined);
  assert.match(String(r.reason), /channel_off/);
});

test("検証モードなら何が送られるかを返す", async () => {
  const r = await service(db(), {
    sent: false, gate: gate("dry_run", ["dry_run"]),
    preview: { recipient: "77", subject: "x", bodyPreview: "案件番号：MTR-2026-00219", attachment: null }
  }).createIssue(8, "a");

  assert.equal(r.created, false);
  assert.ok(r.preview!.bodyPreview.includes("MTR-2026-00219"));
});

test("送れたのに課題キーが返らなければ、紐づけずに理由を返す", async () => {
  const database = db();
  const r = await service(database, { sent: true, externalId: "" }).createIssue(8, "a");
  assert.equal(r.created, true);
  assert.equal(r.issueKey, null);
  assert.equal(database.find("INSERT INTO matter_links"), undefined);
  assert.match(String(r.reason), /課題キーを受け取れません/);
});

test("無い案件は立てられない", async () => {
  await assert.rejects(
    () => service(db([], []), { sent: true, externalId: "X" }).createIssue(99, "a"),
    /見つかりません/);
});

test("紐づけを外しても課題そのものは消さない", async () => {
  const database = new FakeDatabase(() => []);
  await new BacklogService(database, stub({}), { host: "h", issueTypeId: "1" })
    .unlink(8, "LEGAL-12", "a");
  const del = database.find("DELETE FROM matter_links")!;
  assert.match(del.text, /target_type = 'backlog_issue'/);
  assert.deepEqual(del.params, [8, "LEGAL-12"]);
});

test("外したあと同じ内容で押し直したら、その課題に繋ぎ直す", async () => {
  const database = db();
  const r = await service(database, { sent: false, duplicated: true, externalId: "LEGAL-12" })
    .createIssue(8, "a");

  assert.equal(r.created, false);
  assert.equal(r.issueKey, "LEGAL-12");
  assert.ok(database.find("INSERT INTO matter_links"), "行き止まりにしない");
  assert.match(String(r.reason), /繋ぎ直しました/);
});

test("すでに Backlog にある課題を繋げる", async () => {
  const database = db();
  const r = await new BacklogService(database, stub({}), { host: "arch.backlog.jp", issueTypeId: "77" })
    .link(8, "legal-12", "a");

  assert.equal(r.issueKey, "LEGAL-12", "大文字に揃える");
  assert.equal(r.url, "https://arch.backlog.jp/view/LEGAL-12");
  assert.equal(calls.length, 0, "繋ぐだけ。課題は立てない");
  assert.ok(database.find("INSERT INTO matter_links"));
});

test("課題キーの形が違えば繋がない", async () => {
  const s = new BacklogService(db(), stub({}), { host: "h", issueTypeId: "1" });
  await assert.rejects(() => s.link(8, "ただの文字列", "a"), /課題キーの形/);
  await assert.rejects(() => s.link(8, "LEGAL", "a"), /課題キーの形/);
});

test("同じ課題を2つの案件に繋がせない（受信でどちらか決まらなくなる）", async () => {
  const database = db([], [matter()], [{ matter_id: 3, matter_no: "MTR-2026-00003" }]);
  const s = new BacklogService(database, stub({}), { host: "h", issueTypeId: "1" });
  await assert.rejects(() => s.link(8, "LEGAL-12", "a"), /MTR-2026-00003/);
});

test("別の課題に繋がっている案件は、外すまで繋ぎ替えない", async () => {
  const database = db([{ target_ref: "LEGAL-99" }]);
  const s = new BacklogService(database, stub({}), { host: "h", issueTypeId: "1" });
  await assert.rejects(() => s.link(8, "LEGAL-12", "a"), /LEGAL-99/);
});
