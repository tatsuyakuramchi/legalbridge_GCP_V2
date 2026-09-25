import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MailIntakeJob } from "./mail-intake.js";
import { MemoryMailSource } from "../integrations/mail-source.js";
import type { InboundMail } from "../integrations/email-intake.js";

const mail = (id: string, receivedAt: string, over: Partial<InboundMail> = {}): InboundMail => ({
  messageId: id, threadId: id, rfcMessageId: null,
  from: "tanaka@example.co.jp", fromName: null, to: ["legal@arch.co.jp"],
  subject: `${id} の件`, body: "本文", receivedAt, attachments: [], ...over
});

const db = (opts: { cursor?: string | null; failOn?: string } = {}) =>
  new FakeDatabase((t, params) => {
    if (t.includes("FROM settings WHERE key")) {
      return opts.cursor ? [{ since: opts.cursor }] : [];
    }
    if (opts.failOn && t.includes("INSERT INTO matters")
        && String(params[1]).includes(opts.failOn)) {
      throw new Error("わざと落とす");
    }
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO matters")) return [{ id: 1, matter_no: "MTR-2026-00001" }];
    return [];
  });

test("受信の設定が無ければ動かず、理由を返す", async () => {
  const report = await new MailIntakeJob(db(), null).run();
  assert.equal(report.ran, false);
  assert.match(String(report.reason), /設定がありません/);
});

test("栞から後を取り、取り込んだら栞を進める", async () => {
  const database = db({ cursor: "2026-09-01T00:00:00.000Z" });
  const source = new MemoryMailSource([
    mail("a", "2026-09-02T00:00:00.000Z"),
    mail("b", "2026-09-03T00:00:00.000Z")
  ]);
  const report = await new MailIntakeJob(database, source).run();

  assert.equal(report.ran, true);
  assert.equal(report.fetched, 2);
  assert.equal(report.counts.created, 2);
  assert.equal(report.cursorAfter, "2026-09-03T00:00:00.000Z");
  assert.equal(database.find("INSERT INTO settings")!.params[1],
    JSON.stringify({ since: "2026-09-03T00:00:00.000Z" }));
});

test("1通落ちても残りは取り込む", async () => {
  const source = new MemoryMailSource([
    mail("a", "2026-09-02T00:00:00.000Z"),
    mail("b", "2026-09-03T00:00:00.000Z"),
    mail("c", "2026-09-04T00:00:00.000Z")
  ]);
  const report = await new MailIntakeJob(db({ failOn: "b の件" }), source).run();

  assert.equal(report.counts.created, 2);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.failures[0].messageId, "b");
});

test("栞は失敗した所より先へ進めない（落ちたメールを取り残さない）", async () => {
  const database = db({ failOn: "b の件" });
  const source = new MemoryMailSource([
    mail("a", "2026-09-02T00:00:00.000Z"),
    mail("b", "2026-09-03T00:00:00.000Z"),
    mail("c", "2026-09-04T00:00:00.000Z")
  ]);
  const report = await new MailIntakeJob(database, source).run();

  assert.equal(report.cursorAfter, "2026-09-02T00:00:00.000Z",
    "c まで進めると b が二度と読まれない");
});

test("進める先が無ければ栞を書き換えない", async () => {
  const database = db({ cursor: "2026-09-05T00:00:00.000Z" });
  const report = await new MailIntakeJob(database, new MemoryMailSource([])).run();
  assert.equal(report.fetched, 0);
  assert.equal(database.find("INSERT INTO settings"), undefined);
});
