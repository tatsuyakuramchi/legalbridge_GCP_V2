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
  addComment = async (_issueKey: string, _content: string) => ({ id: 1 });
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
  const view = buildLegalRequestModal({ now: new Date("2026-08-10T00:00:00Z") }) as { blocks: Array<{ block_id: string }> };
  const ids = view.blocks.map((b) => b.block_id);
  for (const id of ["request_type_block", "summary_block", "deadline_block", "details_block", "counterparty_block"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("modal: 法務相談は添付案内ブロックが出る（URL設定時はリンク付き・V1復元）", () => {
  type View = { blocks: Array<{ block_id?: string; elements?: Array<{ text?: string }> }> };
  const helpOf = (view: View) => view.blocks.find((b) => b.block_id === "review_upload_help_block");

  // 既定（legal_consult）・URLなし → DM返信での受け渡し案内
  const noUrl = buildLegalRequestModal({ now: new Date("2026-08-10T00:00:00Z") }) as View;
  const helpNoUrl = helpOf(noUrl);
  assert.ok(helpNoUrl, "legal_consult に添付案内ブロックが無い");
  assert.match(String(helpNoUrl?.elements?.[0]?.text), /DMへ、返信でファイルを添付/);

  // URL設定時 → アップロードページへのリンク（V1 の文言）
  const withUrl = buildLegalRequestModal({
    selectedType: "legal_consult", uploadPageUrl: "https://portal.example/upload?sig=x",
    now: new Date("2026-08-10T00:00:00Z")
  }) as View;
  const helpWithUrl = helpOf(withUrl);
  assert.match(String(helpWithUrl?.elements?.[0]?.text), /<https:\/\/portal\.example\/upload\?sig=x\|資料アップロードページ>/);

  // 他種別（nda）には出ない
  const nda = buildLegalRequestModal({ selectedType: "nda", uploadPageUrl: "https://portal.example/upload" }) as View;
  assert.equal(helpOf(nda), undefined);
});

test("modal: 取引先マスタ検索リンク（URL設定時のみ・相手方入力のある種別に表示）", () => {
  type View = { blocks: Array<{ block_id?: string; elements?: Array<{ text?: string }> }> };
  const searchOf = (view: View) => view.blocks.find((b) => b.block_id === "vendor_search_help_block");

  // URL設定時: 相手方入力のある種別（nda）に表示
  const withUrl = buildLegalRequestModal({
    selectedType: "nda", vendorSearchUrl: "https://legalbridge.example/search/vendor"
  }) as View;
  assert.match(String(searchOf(withUrl)?.elements?.[0]?.text),
    /<https:\/\/legalbridge\.example\/search\/vendor\|取引先マスタを検索>/);

  // URL未設定: 出ない
  const noUrl = buildLegalRequestModal({ selectedType: "nda" }) as View;
  assert.equal(searchOf(noUrl), undefined);

  // 相手方入力の無い種別（検収書＝契約番号で特定）には出ない
  const inspec = buildLegalRequestModal({
    selectedType: "delivery_inspec", vendorSearchUrl: "https://legalbridge.example/search/vendor"
  }) as View;
  assert.equal(searchOf(inspec), undefined);
});

test("説明文: V1 準拠の項目が並ぶ", () => {
  const text = buildIssueDescription({
    requestType: "nda", summary: "A社とのNDA", deadline: "2026-08-20", details: "詳細",
    counterparty: "A社", entityType: "corporate", entityId: "",
    lineItems: [], targetIssueKeySelect: "", targetDocNumber: "",
    targetIssueKey: "", newDeliveryDate: "", changeReason: ""
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

// ---- 16-3c: 動的モーダル（明細行・紐付け候補・納期変更） ----
import {
  DEADLINE_CHANGE_TYPE, NEW_ISSUE_VALUE, REQUEST_TYPE_ACTION_ID
} from "./modal.js";
import {
  LINE_ITEM_ADD_ACTION_ID, LINE_ITEM_MAX, formatLineItemsText, parseLineItems
} from "./line-items.js";
import { MemoryContractCheckRepository as CheckRepo } from "../contract-check/repository.js";

test("16-3c modal: 発注書は明細セクション＋増減ボタン付きで組める", () => {
  const view = buildLegalRequestModal({ selectedType: "purchase_order", liCount: 2 }) as {
    private_metadata: string; blocks: Array<{ block_id?: string; elements?: Array<{ action_id?: string }> }>;
  };
  assert.deepEqual(JSON.parse(view.private_metadata), { li_count: 2 });
  const ids = view.blocks.map((b) => b.block_id);
  assert.ok(ids.includes("li_1_name_block"));
  assert.ok(ids.includes("li_2_name_block"));
  assert.ok(!ids.includes("li_3_name_block"));
  const actions = view.blocks.find((b) => b.block_id === "li_actions_block");
  assert.ok(actions?.elements?.some((e) => e.action_id === "li_add"));
  assert.ok(actions?.elements?.some((e) => e.action_id === "li_remove"));
});

test("16-3c modal: 5件で追加ボタンが消える", () => {
  const view = buildLegalRequestModal({ selectedType: "purchase_order", liCount: LINE_ITEM_MAX }) as {
    blocks: Array<{ block_id?: string; elements?: Array<{ action_id?: string }> }>;
  };
  const actions = view.blocks.find((b) => b.block_id === "li_actions_block");
  assert.ok(!actions?.elements?.some((e) => e.action_id === "li_add"));
  assert.ok(actions?.elements?.some((e) => e.action_id === "li_remove"));
});

test("16-3c modal: 納期変更依頼は別フォーム（候補セレクタ＋日付＋理由）", () => {
  const view = buildLegalRequestModal({
    selectedType: DEADLINE_CHANGE_TYPE,
    candidates: [{ issueKey: "LEGAL-9", summary: "既存依頼", counterparty: "A社" }]
  }) as { blocks: Array<{ block_id?: string; optional?: boolean }> };
  const ids = view.blocks.map((b) => b.block_id);
  assert.ok(ids.includes("target_issue_key_select_block"));
  assert.ok(ids.includes("target_issue_key_block"));
  assert.ok(ids.includes("new_delivery_date_block"));
  assert.ok(ids.includes("change_reason_block"));
  assert.ok(!ids.includes("summary_block"));
  // 候補があるときは自由入力が optional
  assert.equal(view.blocks.find((b) => b.block_id === "target_issue_key_block")?.optional, true);
});

test("16-3c modal: 検収書は候補セレクタ（__NEW__先頭）と契約番号ブロック", () => {
  const view = buildLegalRequestModal({
    selectedType: "delivery_inspec",
    candidates: [{ issueKey: "LEGAL-7", summary: "納品", counterparty: null }]
  }) as { blocks: Array<{ block_id?: string; element?: { options?: Array<{ value: string }> } }> };
  const ids = view.blocks.map((b) => b.block_id);
  assert.ok(ids.includes("target_issue_key_select_block"));
  assert.ok(ids.includes("target_doc_number_block"));
  assert.ok(!ids.includes("counterparty_block"));
  const select = view.blocks.find((b) => b.block_id === "target_issue_key_select_block");
  assert.equal(select?.element?.options?.[0]?.value, NEW_ISSUE_VALUE);
});

test("16-3c 明細: パースと整形（空行スキップ・選択肢は表示名へ）", () => {
  const state = {
    li_1_name_block: { li_1_name_input: { value: "イラスト制作" } },
    li_1_ip_ownership_block: { li_1_ip_ownership_input: { selected_option: { value: "transfer" } } },
    li_1_work_deadline_block: { li_1_work_deadline_input: { selected_date: "2026-09-10" } },
    li_2_name_block: { li_2_name_input: { value: "" } }
  };
  const items = parseLineItems(state, "purchase_order", 2);
  assert.equal(items.length, 1);
  const text = formatLineItemsText("purchase_order", items);
  assert.match(text, /【発注明細】\(1 件\)/);
  assert.match(text, /IP帰属: 当社へ譲渡（譲渡型）/);
  assert.match(text, /業務納期: 2026-09-10/);
});

test("16-3c parse: 納期変更のバリデーション（キー形式・日付・理由）", () => {
  const base = {
    request_type_block: { request_type_input: { selected_option: { value: DEADLINE_CHANGE_TYPE } } },
    target_issue_key_block: { target_issue_key_input: { value: "legal-12" } },
    new_delivery_date_block: { new_delivery_date_input: { selected_date: "2026-09-01" } },
    change_reason_block: { change_reason_input: { value: "仕様変更" } }
  };
  const good = parseLegalRequestSubmission(base);
  assert.deepEqual(good.errors, {});
  assert.equal(good.submission.targetIssueKey, "LEGAL-12");   // 大文字化
  const badKey = parseLegalRequestSubmission({
    ...base, target_issue_key_block: { target_issue_key_input: { value: "不正" } }
  });
  assert.ok(badKey.errors.target_issue_key_block);
  const noReason = parseLegalRequestSubmission({
    ...base, change_reason_block: { change_reason_input: { value: "" } }
  });
  assert.ok(noReason.errors.change_reason_block);
  // 候補セレクタ選択はキー入力より優先
  const viaSelect = parseLegalRequestSubmission({
    ...base,
    target_issue_key_block: { target_issue_key_input: { value: "" } },
    target_issue_key_select_block: { target_issue_key_select_input: { selected_option: { value: "LEGAL-99" } } }
  });
  assert.deepEqual(viaSelect.errors, {});
  assert.equal(viaSelect.submission.targetIssueKey, "LEGAL-99");
});

function interactivityForm(payload: Record<string, unknown>): Record<string, string> {
  return { payload: JSON.stringify(payload) };
}

test("16-3c: 種別変更 block_action で views.update（候補付き）", async () => {
  const repository = new MemorySlackIntakeRepository(
    new Map([["U001", { email: "u@arclight.co.jp", department: "DOM" }]]));
  repository.candidates = [
    { slackUserId: "U001", requestType: "delivery_inspec", issueKey: "LEGAL-7", summary: "納品", counterparty: null }
  ];
  const slack = new FakeSlack();
  const handler = createSlackIntakeHandler({ repository, slack, backlog: new FakeBacklog(), log: () => undefined });
  const app = express();
  app.use(express.json());
  app.use(createSlackIntakeRouter({
    signingSecret: SECRET, onCommand: handler.handleCommand, onInteractivity: handler.handleInteractivity
  }));
  await signedPost(app, "/internal/slack/interactivity", interactivityForm({
    type: "block_actions", user: { id: "U001" },
    view: {
      id: "V9", hash: "h1", callback_id: LEGAL_REQUEST_CALLBACK_ID, private_metadata: "{\"li_count\":0}",
      state: { values: {} }
    },
    actions: [{ action_id: REQUEST_TYPE_ACTION_ID, selected_option: { value: "delivery_inspec" } }]
  })).expect(200);
  const update = slack.calls.find((c) => c.method === "views.update");
  assert.ok(update);
  assert.equal(update!.body.view_id, "V9");
  const text = JSON.stringify(update!.body.view);
  assert.match(text, /target_issue_key_select_block/);
  assert.match(text, /LEGAL-7/);
});

test("16-3c: 明細追加 block_action で li_count が増える", async () => {
  const { app, slack } = appFor();
  await signedPost(app, "/internal/slack/interactivity", interactivityForm({
    type: "block_actions", user: { id: "U001" },
    view: {
      id: "V9", callback_id: LEGAL_REQUEST_CALLBACK_ID, private_metadata: "{\"li_count\":1}",
      state: { values: { request_type_block: { request_type_input: { selected_option: { value: "purchase_order" } } } } }
    },
    actions: [{ action_id: LINE_ITEM_ADD_ACTION_ID }]
  })).expect(200);
  const update = slack.calls.find((c) => c.method === "views.update");
  assert.ok(update);
  const view = update!.body.view as { private_metadata: string };
  assert.deepEqual(JSON.parse(view.private_metadata), { li_count: 2 });
});

function deadlineSubmission(): Record<string, string> {
  return interactivityForm({
    type: "view_submission", user: { id: "U001" },
    view: {
      callback_id: LEGAL_REQUEST_CALLBACK_ID, private_metadata: "{\"li_count\":0}",
      state: { values: {
        request_type_block: { request_type_input: { selected_option: { value: DEADLINE_CHANGE_TYPE } } },
        target_issue_key_block: { target_issue_key_input: { value: "LEGAL-12" } },
        new_delivery_date_block: { new_delivery_date_input: { selected_date: "2026-09-01" } },
        change_reason_block: { change_reason_input: { value: "仕様変更のため" } }
      } }
    }
  });
}

test("16-3c: 納期変更の提出→承認用課題の起票＋記録（新規作業課題は作らない）", async () => {
  const backlog = new FakeBacklog();
  const { app, repository } = appFor({ backlog });
  const res = await signedPost(app, "/internal/slack/interactivity", deadlineSubmission()).expect(200);
  assert.equal(res.body.response_action, "update");
  assert.match(JSON.stringify(res.body.view), /納期変更依頼を受け付けました/);
  assert.equal(backlog.created.length, 1);
  assert.match(backlog.created[0].summary, /\[納期変更依頼\] LEGAL-12 → 2026-09-01/);
  assert.equal(repository.requests.length, 1);
  assert.equal(repository.requests[0].requestType, "deadline_change");
  const notes = JSON.parse(repository.requests[0].notes ?? "{}");
  assert.equal(notes.type, "deadline_change_request");
  assert.equal(notes.target_issue_key, "LEGAL-12");
  assert.equal(notes.executed, false);
});

test("16-3c: 納期変更 dry-run は台帳のみ", async () => {
  const { app, repository } = appFor({ backlog: null });
  const res = await signedPost(app, "/internal/slack/interactivity", deadlineSubmission()).expect(200);
  assert.equal(res.body.response_action, "update");
  assert.equal(repository.requests.length, 0);
  assert.equal(repository.ledgerRows.length, 1);
  assert.equal(repository.ledgerRows[0].mode, "dry-run");
  assert.equal(repository.ledgerRows[0].requestType, "deadline_change");
});

function licenseCalcLinkSubmission(select: string): Record<string, string> {
  return interactivityForm({
    type: "view_submission", user: { id: "U001" },
    view: {
      callback_id: LEGAL_REQUEST_CALLBACK_ID, private_metadata: "{\"li_count\":1}",
      state: { values: {
        request_type_block: { request_type_input: { selected_option: { value: "license_calc" } } },
        summary_block: { summary_input: { value: "売上報告" } },
        deadline_block: { deadline_input: { selected_date: "2026-08-31" } },
        details_block: { details_input: { value: "Q2分" } },
        target_issue_key_select_block: { target_issue_key_select_input: { selected_option: { value: select } } },
        li_1_product_name_block: { li_1_product_name_input: { value: "ボードゲーム「〇〇」" } }
      } }
    }
  });
}

test("16-3c: 既存課題への紐付け＝新規課題を作らずコメント記録", async () => {
  const backlog = new FakeBacklog();
  const comments: Array<{ issueKey: string; content: string }> = [];
  backlog.addComment = async (issueKey: string, content: string) => {
    comments.push({ issueKey, content });
    return { id: 1 };
  };
  const { app, repository } = appFor({ backlog });
  const res = await signedPost(app, "/internal/slack/interactivity", licenseCalcLinkSubmission("LEGAL-55")).expect(200);
  assert.equal(res.body.response_action, "update");
  assert.match(JSON.stringify(res.body.view), /既存課題に紐付けて受け付けました/);
  assert.equal(backlog.created.length, 0);           // 新規課題なし
  assert.equal(repository.requests.length, 0);        // legal_requests も作らない
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueKey, "LEGAL-55");
  assert.match(comments[0].content, /【計算明細】/);
  assert.equal(repository.ledgerRows.length, 1);
  assert.equal(repository.ledgerRows[0].backlogIssueKey, "LEGAL-55");
});

test("16-3c: __NEW__ 選択は通常の新規起票へ（明細テキストが説明文に載る）", async () => {
  const backlog = new FakeBacklog();
  const { app, repository } = appFor({ backlog });
  const res = await signedPost(app, "/internal/slack/interactivity", licenseCalcLinkSubmission(NEW_ISSUE_VALUE)).expect(200);
  assert.equal(res.body.response_action, "update");
  assert.equal(backlog.created.length, 1);
  assert.match(backlog.created[0].description, /【計算明細】\(1 件\)/);
  assert.match(backlog.created[0].description, /対象製品・作品: ボードゲーム「〇〇」/);
  assert.equal(repository.requests.length, 1);
  const notes = JSON.parse(repository.requests[0].notes ?? "{}");
  assert.equal(notes.lineItems.length, 1);
});

function deliveryInspecSubmission(docNumber: string): Record<string, string> {
  return interactivityForm({
    type: "view_submission", user: { id: "U001" },
    view: {
      callback_id: LEGAL_REQUEST_CALLBACK_ID, private_metadata: "{\"li_count\":1}",
      state: { values: {
        request_type_block: { request_type_input: { selected_option: { value: "delivery_inspec" } } },
        summary_block: { summary_input: { value: "検収書" } },
        deadline_block: { deadline_input: { selected_date: "2026-08-31" } },
        details_block: { details_input: { value: "第1回納品分" } },
        ...(docNumber ? { target_doc_number_block: { target_doc_number_input: { value: docNumber } } } : {}),
        li_1_item_name_block: { li_1_item_name_input: { value: "イラスト一式" } },
        li_1_delivery_no_block: { li_1_delivery_no_input: { value: "1" } }
      } }
    }
  });
}

function checkRepoWithContract() {
  return new CheckRepo(
    [{ id: 1, vendorCode: "V001", vendorName: "株式会社アークライト", entityType: "corporate", tradeName: null, penName: null }],
    new Map(), new Map([["ARC-PO-2026-0001", {
      document_number: "ARC-PO-2026-0001", record_type: "master_contract", contract_title: "発注書",
      contract_status: "executed", vendor_name: "株式会社アークライト", vendor_code: "V001",
      entity_type: "corporate", issue_key: ""
    }]])
  );
}

test("16-3c: 検収書は契約番号必須（未入力は errors）", async () => {
  const { app } = appFor();
  const res = await signedPost(app, "/internal/slack/interactivity", deliveryInspecSubmission("")).expect(200);
  assert.equal(res.body.response_action, "errors");
  assert.ok(res.body.errors.target_doc_number_block);
});

test("16-3c: 検収書の契約番号は実在チェック＋取引先補完（contract-check 注入時）", async () => {
  const repository = new MemorySlackIntakeRepository(
    new Map([["U001", { email: "u@arclight.co.jp", department: "DOM" }]]));
  const slack = new FakeSlack();
  const backlog = new FakeBacklog();
  const handler = createSlackIntakeHandler({
    repository, slack, backlog, contractCheck: checkRepoWithContract(), log: () => undefined
  });
  const app = express();
  app.use(express.json());
  app.use(createSlackIntakeRouter({
    signingSecret: SECRET, onCommand: handler.handleCommand, onInteractivity: handler.handleInteractivity
  }));
  // 実在しない番号 → errors
  const bad = await signedPost(app, "/internal/slack/interactivity", deliveryInspecSubmission("ARC-PO-9999-9999")).expect(200);
  assert.equal(bad.body.response_action, "errors");
  assert.match(bad.body.errors.target_doc_number_block, /見つかりません/);
  // 実在する番号 → 起票され取引先が補完される
  const ok = await signedPost(app, "/internal/slack/interactivity", deliveryInspecSubmission("ARC-PO-2026-0001")).expect(200);
  assert.equal(ok.body.response_action, "update");
  assert.equal(repository.requests.length, 1);
  assert.equal(repository.requests[0].counterparty, "株式会社アークライト");
});
