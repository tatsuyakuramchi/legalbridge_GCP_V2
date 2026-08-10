import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createSlackIntakeRouter } from "../internal/slack-intake-routes.js";
import { createSlackIntakeHandler, buildIssueDescription } from "./handler.js";
import { MemorySlackIntakeRepository } from "./intake-repository.js";
import { parseLegalRequestSubmission, buildLegalRequestModal, LEGAL_REQUEST_CALLBACK_ID } from "./modal.js";
import type { SlackWebApiClient, SlackWebApiMethod } from "../integrations/slack-web-api-adapter.js";
import type { BacklogWriteClient } from "../integrations/backlog-web-api.js";

const SECRET = "sig-secret";
function sign(ts: string, body: string): string {
  return `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
}
function signedPost(app: express.Express, path: string, form: Record<string, string>) {
  const body = new URLSearchParams(form).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app).post(path)
    .set("content-type", "application/x-www-form-urlencoded")
    .set("x-slack-request-timestamp", ts)
    .set("x-slack-signature", sign(ts, body))
    .send(body);
}

class FakeSlack implements SlackWebApiClient {
  readonly calls: Array<{ method: SlackWebApiMethod; body: Record<string, unknown> }> = [];
  async post(method: SlackWebApiMethod, body: Record<string, unknown>) {
    this.calls.push({ method, body });
    if (method === "conversations.open") return { ok: true, channel: { id: "D123" } };
    return { ok: true };
  }
}
class FakeBacklog implements BacklogWriteClient {
  readonly created: Array<{ summary: string; description: string; issueTypeName: string }> = [];
  async addComment() { return { id: 1 }; }
  async createIssue(input: { summary: string; description: string; issueTypeName: string }) {
    this.created.push(input);
    return { issueKey: "LEGAL-101" };
  }
}

function submissionState(overrides: Record<string, unknown> = {}) {
  return {
    request_type_block: { request_type_input: { selected_option: { value: "nda" } } },
    summary_block: { summary_input: { value: "A社とのNDA" } },
    deadline_block: { deadline_input: { selected_date: "2026-08-20" } },
    details_block: { details_input: { value: "新規取引のため" } },
    counterparty_block: { counterparty_input: { value: "A社" } },
    ...overrides
  };
}
function viewSubmissionForm(state: Record<string, unknown>): Record<string, string> {
  return {
    payload: JSON.stringify({
      type: "view_submission", user: { id: "U001" },
      view: { callback_id: LEGAL_REQUEST_CALLBACK_ID, state: { values: state } }
    })
  };
}

function appFor(opts: { backlog?: FakeBacklog | null; forbidden?: boolean } = {}) {
  const repository = new MemorySlackIntakeRepository(
    new Map([["U001", { email: "u@arclight.co.jp", department: "DOM" }]]),
    new Map([["DOM", "C0DOM"]]),
    opts.forbidden ?? false
  );
  const slack = new FakeSlack();
  const handler = createSlackIntakeHandler({
    repository, slack,
    backlog: opts.backlog === undefined ? new FakeBacklog() : opts.backlog,
    backlogHost: "example.backlog.jp", log: () => undefined
  });
  const app = express();
  app.use(express.json());   // 本体と同じ順序（Slack の form-encoded は素通りする）
  app.use(createSlackIntakeRouter({
    signingSecret: SECRET, onCommand: handler.handleCommand, onInteractivity: handler.handleInteractivity
  }));
  return { app, repository, slack };
}

test("intake: 署名が無い/不正なら401", async () => {
  const { app } = appFor();
  const res = await request(app).post("/internal/slack/commands")
    .set("content-type", "application/x-www-form-urlencoded").send("command=%2F法務依頼");
  assert.equal(res.status, 401);
});

test("intake: 未設定（secret/handlerなし）は404", async () => {
  const app = express();
  app.use(createSlackIntakeRouter({}));
  const res = await request(app).post("/internal/slack/commands").send("");
  assert.equal(res.status, 404);
});

test("intake: /法務依頼 で views.open が呼ばれる", async () => {
  const { app, slack } = appFor();
  const res = await signedPost(app, "/internal/slack/commands", { command: "/法務依頼", trigger_id: "trg1" });
  assert.equal(res.status, 200);
  const open = slack.calls.find((c) => c.method === "views.open");
  assert.ok(open);
  assert.equal(open!.body.trigger_id, "trg1");
});

test("intake: 未対応コマンドは ephemeral 応答", async () => {
  const { app } = appFor();
  const res = await signedPost(app, "/internal/slack/commands", { command: "/unknown", trigger_id: "t" });
  assert.equal(res.status, 200);
  assert.equal(res.body.response_type, "ephemeral");
});

test("intake: 提出→Backlog起票＋依頼記録＋台帳＋完了ビュー", async () => {
  const backlog = new FakeBacklog();
  const { app, repository } = appFor({ backlog });
  const res = await signedPost(app, "/internal/slack/interactivity", viewSubmissionForm(submissionState()));
  assert.equal(res.status, 200);
  assert.equal(res.body.response_action, "update");
  assert.equal(backlog.created.length, 1);
  assert.match(backlog.created[0].summary, /【NDA（秘密保持契約）】A社とのNDA/);
  assert.equal(backlog.created[0].issueTypeName, "NDA");
  assert.equal(repository.requests.length, 1);
  assert.equal(repository.requests[0].backlogIssueKey, "LEGAL-101");
  assert.equal(repository.requests[0].requestType, "nda");
  assert.equal(repository.requests[0].counterparty, "A社");
  assert.equal(repository.ledgerRows.length, 1);
  assert.equal(repository.ledgerRows[0].mode, "live");
});

test("intake: 必須欠落は response_action:errors", async () => {
  const { app, repository } = appFor();
  const state = submissionState({ summary_block: { summary_input: { value: "" } } });
  const res = await signedPost(app, "/internal/slack/interactivity", viewSubmissionForm(state));
  assert.equal(res.status, 200);
  assert.equal(res.body.response_action, "errors");
  assert.ok(res.body.errors.summary_block);
  assert.equal(repository.requests.length, 0);
});

test("intake: Backlog未接続は dry-run（台帳のみ・共有表に書かない）", async () => {
  const { app, repository } = appFor({ backlog: null });
  const res = await signedPost(app, "/internal/slack/interactivity", viewSubmissionForm(submissionState()));
  assert.equal(res.status, 200);
  assert.equal(res.body.response_action, "update");
  assert.equal(repository.requests.length, 0);
  assert.equal(repository.ledgerRows.length, 1);
  assert.equal(repository.ledgerRows[0].mode, "dry-run");
});

test("intake: 書込権限未整備(42501)はエラービュー（500にしない）", async () => {
  const { app } = appFor({ forbidden: true });
  const res = await signedPost(app, "/internal/slack/interactivity", viewSubmissionForm(submissionState()));
  assert.equal(res.status, 200);
  assert.equal(res.body.response_action, "update");
  assert.match(JSON.stringify(res.body.view), /書込権限が未設定/);
});

test("modal: 必須4項目のバリデーションとパース", () => {
  const { submission, errors } = parseLegalRequestSubmission(submissionState());
  assert.deepEqual(errors, {});
  assert.equal(submission.deadline, "2026-08-20");
  const bad = parseLegalRequestSubmission({});
  assert.ok(bad.errors.request_type_block && bad.errors.summary_block && bad.errors.deadline_block && bad.errors.details_block);
});

test("modal: モーダル定義に必須ブロックが揃う", () => {
  const view = buildLegalRequestModal(new Date("2026-08-10T00:00:00Z")) as { blocks: Array<{ block_id: string }> };
  const ids = view.blocks.map((b) => b.block_id);
  for (const id of ["request_type_block", "summary_block", "deadline_block", "details_block", "counterparty_block"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("説明文: V1 準拠の項目が並ぶ", () => {
  const text = buildIssueDescription({
    requestType: "nda", summary: "A社とのNDA", deadline: "2026-08-20", details: "詳細",
    counterparty: "A社", entityType: "corporate", entityId: ""
  }, "u@arclight.co.jp");
  assert.match(text, /■ 依頼種別: NDA/);
  assert.match(text, /■ 希望納期: 2026-08-20/);
  assert.match(text, /■ 依頼者: u@arclight\.co\.jp/);
});

// ---- /法務検索（16-3b）----
import { MemoryContractCheckRepository } from "../contract-check/repository.js";
import { LEGAL_SEARCH_CALLBACK_ID, SEARCH_AGAIN_ACTION_ID } from "./search-modal.js";
import type { VendorDocumentRow } from "../contract-check/engine.js";

function searchAppFor(opts: { withCheck?: boolean } = {}) {
  const repository = new MemorySlackIntakeRepository();
  const slack = new FakeSlack();
  const masterDoc: VendorDocumentRow = {
    recordType: "master_contract", contractCategory: "service", contractTitle: "基本契約",
    documentNumber: "K-1", contractStatus: "executed", effectiveDate: "2024-01-01",
    expirationDate: null, autoRenewal: false, documentUrl: null, legalonUrl: null,
    cloudsignUrl: null, driveUrl: null, conditionNumber: null, originalWork: null,
    workName: null, productName: null, media: null, territory: null, language: null,
    scope: null, isPrimary: true, lifecycleStatus: "final"
  };
  const contractCheck = new MemoryContractCheckRepository(
    [{ id: 1, vendorCode: "V001", vendorName: "株式会社アークライト", entityType: "corporate", tradeName: null, penName: null }],
    new Map([[1, [masterDoc]]])
  );
  const handler = createSlackIntakeHandler({
    repository, slack, backlog: null,
    backlogHost: "example.backlog.jp", backlogProjectKey: "LEGAL",
    contractCheck: opts.withCheck === false ? null : contractCheck, log: () => undefined
  });
  const app = express();
  app.use(express.json());
  app.use(createSlackIntakeRouter({
    signingSecret: SECRET, onCommand: handler.handleCommand, onInteractivity: handler.handleInteractivity
  }));
  return { app, slack };
}

test("法務検索: コマンドで検索モーダルが開く（キーワード事前入力）", async () => {
  const { app, slack } = searchAppFor();
  await signedPost(app, "/internal/slack/commands", { command: "/法務検索", trigger_id: "t2", text: "アーク" }).expect(200);
  const open = slack.calls.find((c) => c.method === "views.open");
  assert.ok(open);
  assert.equal((open!.body.view as { callback_id: string }).callback_id, LEGAL_SEARCH_CALLBACK_ID);
});

test("法務検索: 未注入なら利用不可の ephemeral", async () => {
  const { app } = searchAppFor({ withCheck: false });
  const res = await signedPost(app, "/internal/slack/commands", { command: "/法務検索", trigger_id: "t2" }).expect(200);
  assert.match(res.body.text, /利用できません/);
});

function searchSubmission(keyword: string) {
  return {
    payload: JSON.stringify({
      type: "view_submission", user: { id: "U001" },
      view: {
        callback_id: LEGAL_SEARCH_CALLBACK_ID,
        state: { values: { keyword_block: { keyword_input: { value: keyword } } } }
      }
    })
  };
}

test("法務検索: 単一ヒットで結果モーダル（ピル＋Backlogリンク）", async () => {
  const { app } = searchAppFor();
  const res = await signedPost(app, "/internal/slack/interactivity", searchSubmission("アークライト")).expect(200);
  assert.equal(res.body.response_action, "update");
  const text = JSON.stringify(res.body.view);
  assert.match(text, /業務委託 ✅締結済/);
  assert.match(text, /ライセンス —未締結/);
  assert.match(text, /simpleSearch=true/);
});

test("法務検索: 未検出・空キーワード", async () => {
  const { app } = searchAppFor();
  const miss = await signedPost(app, "/internal/slack/interactivity", searchSubmission("該当なし")).expect(200);
  assert.match(JSON.stringify(miss.body.view), /見つかりませんでした/);
  const empty = await signedPost(app, "/internal/slack/interactivity", searchSubmission("")).expect(200);
  assert.equal(empty.body.response_action, "errors");
  assert.ok(empty.body.errors.keyword_block);
});

test("法務検索: 検索し直す block_action で views.update", async () => {
  const { app, slack } = searchAppFor();
  const payload = {
    payload: JSON.stringify({
      type: "block_actions", user: { id: "U001" },
      view: { id: "V123", callback_id: LEGAL_SEARCH_CALLBACK_ID },
      actions: [{ action_id: SEARCH_AGAIN_ACTION_ID }]
    })
  };
  await signedPost(app, "/internal/slack/interactivity", payload).expect(200);
  const update = slack.calls.find((c) => c.method === "views.update");
  assert.ok(update);
  assert.equal(update!.body.view_id, "V123");
});
