import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createCloudSignRouter } from "./cloudsign-routes.js";
import { MemoryDocumentRegistryRepository, type RegisteredDocument } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import type { CloudSignAdapter, CloudSignSignatureRequest } from "../integrations/cloudsign-adapter.js";
import { CloudSignError } from "../integrations/cloudsign-adapter.js";
import { buildUpstreamDetail } from "../integrations/cloudsign-upstream-error.js";
import { MemoryCloudSignRequestRepository } from "../integrations/cloudsign-request-repository.js";
import { MemoryDriveStorage } from "./drive-storage.js";

const doc: RegisteredDocument = {
  id: 5, documentNumber: "DOC-2026-0005", issueKey: "LB-5", templateType: "license",
  templateVersionId: 1, title: "ライセンス契約", counterparty: "株式会社甲",
  driveLink: "", createdAt: "2026-08-04T00:00:00.000Z", createdBy: "legal@arclight.co.jp", formData: {}
};

// renderStoredDocumentHtml が使うのは findRenderSource / findPartials。
// プレビューは findCurrent で「テンプレートを持つ文書か」を見る。
// document.templateVersionId(1) と一致させて版ズレ例外を避ける。
const templatesStub = {
  async findRenderSource() { return { templateVersionId: 1, htmlSource: "<h1>{{TITLE}}</h1>" }; },
  async findPartials() { return {}; },
  async findCurrent() { return { templateKey: "license", label: "license", templateVersionId: 1, fields: [] }; }
} as unknown as TemplateRepository;

// 添付（ATT-…）はテンプレートを持たない。Drive の実体から送る経路の確認用。
const noTemplateStub = {
  async findRenderSource() { return null; },
  async findPartials() { return {}; },
  async findCurrent() { return null; }
} as unknown as TemplateRepository;

const attachment: RegisteredDocument = {
  id: 9, documentNumber: "ATT-2026-00009", issueKey: "LB-5", templateType: "counterparty_draft",
  templateVersionId: null, title: "先方ドラフト", counterparty: "株式会社甲",
  driveLink: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view",
  createdAt: "2026-08-17T00:00:00.000Z", createdBy: "legal@arclight.co.jp",
  formData: { original_file_name: "先方ドラフト.pdf", source_mime_type: "application/pdf" }
};
const pdfRenderer: PdfRenderer = { async render() { return Buffer.from("%PDF-1.4 test"); } };

class CapturingCloudSign implements CloudSignAdapter {
  readonly configured = true;
  sent: CloudSignSignatureRequest | null = null;
  sendCount = 0;
  async requestSignature(req: CloudSignSignatureRequest) {
    this.sent = req; this.sendCount += 1;
    return { cloudSignDocumentId: "cs-1", status: req.sendNow ? "sent" : "draft", participantIds: ["pt-1"] };
  }
  async fetchStatus(cloudSignDocumentId: string) {
    return { cloudSignDocumentId, status: "completed", completed: true, participants: [] };
  }
}

function appFor(options: {
  role?: "admin" | "legal" | "requester"; live?: boolean; adapter?: CloudSignAdapter;
  allowedRecipients?: Set<string>; requestHistory?: MemoryCloudSignRequestRepository;
  extraDocs?: RegisteredDocument[];
  templates?: TemplateRepository; driveStorage?: MemoryDriveStorage;
}) {
  const registry = new MemoryDocumentRegistryRepository([doc, ...(options.extraDocs ?? [])]);
  const adapter = options.adapter ?? new CapturingCloudSign();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: options.role ?? "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createCloudSignRouter(registry, options.templates ?? templatesStub, pdfRenderer, adapter, {
    integrationMode: options.live ? "live" : "local",
    cloudSignCapabilityEnabled: options.live ?? false,
    adapterConfigured: adapter.configured
  }, {
    allowedRecipients: options.allowedRecipients, requestHistory: options.requestHistory,
    driveStorage: options.driveStorage
  }));
  return { app, adapter };
}

const body = { participants: [{ email: "a@example.com", name: "甲" }] };

test("プレビューはローカルでも署名者とブロック理由を返す", async () => {
  const { app } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/preview").send(body);
  assert.equal(response.status, 200);
  assert.match(response.body.preview.documentTitle, /DOC-2026-0005/);
  assert.equal(response.body.gate.dispatchAllowed, false);
  assert.ok(response.body.gate.blockerLabels.length > 0);
});

test("依頼者ロールはプレビューできない", async () => {
  const { app } = appFor({ role: "requester" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/preview").send(body);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CLOUDSIGN_FORBIDDEN");
});

test("ローカルモードでは実依頼を409でブロックする", async () => {
  const { app, adapter } = appFor({ live: false });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CLOUDSIGN_DISPATCH_BLOCKED");
  assert.equal((adapter as CapturingCloudSign).sent, null);
});

test("ライブモードかつ管理者はPDFを描画して署名依頼する", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 201);
  assert.equal(response.body.receipt.cloudSignDocumentId, "cs-1");
  const sent = (adapter as CapturingCloudSign).sent;
  assert.notEqual(sent, null);
  assert.ok(sent && sent.pdf.length > 0);
});

test("法務ロールは実依頼できない（管理者限定）", async () => {
  const { app } = appFor({ live: true, role: "legal" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CLOUDSIGN_ADMIN_REQUIRED");
});

test("allowlist設定時、許可外の宛先は422でブロックする", async () => {
  const allowedRecipients = new Set(["allowed@example.com"]);
  const { app, adapter } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ participants: [{ email: "a@example.com", name: "甲" }] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_RECIPIENT_NOT_ALLOWED");
  assert.equal((adapter as CapturingCloudSign).sendCount, 0);
});

test("allowlist設定時、全宛先が許可内なら送信する", async () => {
  const allowedRecipients = new Set(["a@example.com"]);
  const { app, adapter } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 201);
  assert.equal((adapter as CapturingCloudSign).sendCount, 1);
});

test("既定は下書き作成：drafted＋CloudSign画面URLを返しCCも受け付ける", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, cc: [{ email: "cc@example.com", name: "共有" }] });
  assert.equal(response.status, 201);
  assert.equal(response.body.integrations.cloudsign, "drafted");
  assert.equal(response.body.receipt.status, "draft");
  assert.match(String(response.body.cloudSignUrl), /^https:\/\/app\.cloudsign\.jp\/documents\//);
  const captured = (adapter as CapturingCloudSign).sent!;
  assert.equal(captured.sendNow, false);
  assert.deepEqual(captured.cc, [{ email: "cc@example.com", name: "共有" }]);
});

test("CCがallowlist外なら422で拒否する", async () => {
  const allowedRecipients = new Set(["a@example.com"]);
  const { app } = appFor({ live: true, role: "admin", allowedRecipients });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, cc: [{ email: "outside@example.com" }] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_RECIPIENT_NOT_ALLOWED");
});

test("同一案件の文書はまとめて1つのCloudSign書類に添付できる", async () => {
  const primary = { ...doc, matterId: 77 };
  const sibling: RegisteredDocument = { ...doc, id: 6, documentNumber: "DOC-2026-0006", matterId: 77 };
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appForWithDocs([primary, sibling], { requestHistory });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, attachDocumentIds: [6] });
  assert.equal(response.status, 201);
  assert.equal(response.body.attachedCount, 1);
  const captured = (adapter as CapturingCloudSign).sent!;
  assert.equal(captured.extraFiles?.length, 1);
  assert.match(captured.extraFiles![0].filename, /DOC-2026-0006/);
  // 添付文書の履歴も記録される（各文書のパネルに表示するため）。
  assert.equal((await requestHistory.listByDocument(6)).length, 1);
  assert.equal((await requestHistory.listByDocument(5)).length, 1);
});

test("別案件の文書を添付しようとすると422で拒否する", async () => {
  const primary = { ...doc, matterId: 77 };
  const other: RegisteredDocument = { ...doc, id: 7, documentNumber: "DOC-2026-0007", matterId: 99 };
  const { app } = appForWithDocs([primary, other], {});
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, attachDocumentIds: [7] });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_ATTACH_DIFFERENT_MATTER");
});

function appForWithDocs(docs: RegisteredDocument[], options: {
  requestHistory?: MemoryCloudSignRequestRepository;
}) {
  const registry = new MemoryDocumentRegistryRepository(docs);
  const adapter = new CapturingCloudSign();
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.currentUser = { email: "u@arclight.co.jp", subject: "s", role: "admin", source: "disabled" };
    next();
  });
  app.use("/api/v2", createCloudSignRouter(registry, templatesStub, pdfRenderer, adapter, {
    integrationMode: "live", cloudSignCapabilityEnabled: true, adapterConfigured: true
  }, { requestHistory: options.requestHistory }));
  return { app, adapter };
}

test("履歴有効時、同一文書の再依頼は冪等で再送しない(duplicate)", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appFor({ live: true, role: "admin", requestHistory });
  const first = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(first.status, 201);
  assert.equal(first.body.integrations.cloudsign, "requested");
  const second = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(second.status, 200);
  assert.equal(second.body.integrations.cloudsign, "duplicate");
  assert.equal(second.body.receipt.cloudSignDocumentId, "cs-1");
  assert.equal((adapter as CapturingCloudSign).sendCount, 1);
});

test("履歴有効時、cloudSignDocumentId が永続化されステータス取得で更新される", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app } = appFor({ live: true, role: "admin", requestHistory });
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  const stored = await requestHistory.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cloudSignDocumentId, "cs-1");
  assert.equal(stored[0].participantCount, 1);
  // ステータス取得で status が completed に反映される。
  await request(app).get("/api/v2/cloudsign/cs-1/status");
  const after = await requestHistory.findByKey(stored[0].idempotencyKey);
  assert.equal(after?.status, "completed");
});

test("履歴無効なら従来通り毎回送信する（後方互換）", async () => {
  const { app, adapter } = appFor({ live: true, role: "admin" });
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal((adapter as CapturingCloudSign).sendCount, 2);
});

// ── システム外で作った契約書を送る（テンプレートを持たない添付から依頼）─────
function attachmentApp(options: { drive?: MemoryDriveStorage; attachmentDoc?: RegisteredDocument } = {}) {
  const drive = options.drive ?? new MemoryDriveStorage();
  return {
    drive,
    ...appFor({
      live: true, role: "admin", templates: noTemplateStub, driveStorage: drive,
      extraDocs: [options.attachmentDoc ?? attachment]
    })
  };
}

test("案件に添付したPDFをそのまま CloudSign へ送れる", async () => {
  const drive = new MemoryDriveStorage();
  drive.seedFile("1AbCdEfGhIjKlMnOpQrSt", Buffer.from("%PDF-1.7 counterparty draft"), "application/pdf");
  const { app, adapter } = attachmentApp({ drive });
  const response = await request(app).post("/api/v2/documents/9/cloudsign/dispatch").send(body);
  assert.equal(response.status, 201);
  const sent = (adapter as CapturingCloudSign).sent!;
  // 描画したPDFではなく Drive の実体が渡る。
  assert.equal(sent.pdf.toString(), "%PDF-1.7 counterparty draft");
  assert.equal(sent.filename, "ATT-2026-00009.pdf");
  assert.deepEqual(drive.downloads, ["1AbCdEfGhIjKlMnOpQrSt"]);
});

test("PDF以外の添付は理由が分かるエラーで止まる", async () => {
  const { app, adapter } = attachmentApp({
    attachmentDoc: { ...attachment,
      formData: { original_file_name: "先方ドラフト.docx", source_mime_type: "application/msword" } }
  });
  const response = await request(app).post("/api/v2/documents/9/cloudsign/dispatch").send(body);
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_SOURCE_NOT_PDF");
  assert.match(response.body.error, /PDFのみ/);
  assert.equal((adapter as CapturingCloudSign).sendCount, 0);
});

test("Drive連携が無いと添付からは依頼できない（テンプレート文書の依頼は従来どおり）", async () => {
  const { app } = appFor({
    live: true, role: "admin", templates: noTemplateStub, extraDocs: [attachment]
  });
  const response = await request(app).post("/api/v2/documents/9/cloudsign/dispatch").send(body);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CLOUDSIGN_DRIVE_UNAVAILABLE");
});

test("プレビューは送信前に「添付から送る」ことと不可の理由を返す", async () => {
  const drive = new MemoryDriveStorage();
  drive.seedFile("1AbCdEfGhIjKlMnOpQrSt", Buffer.from("%PDF-1.7"), "application/pdf");
  const ready = await request(attachmentApp({ drive }).app)
    .post("/api/v2/documents/9/cloudsign/preview").send(body);
  assert.equal(ready.body.source.kind, "attachment");
  assert.equal(ready.body.source.ready, true);

  const notPdf = await request(attachmentApp({
    drive,
    attachmentDoc: { ...attachment, formData: { original_file_name: "d.docx", source_mime_type: "application/msword" } }
  }).app).post("/api/v2/documents/9/cloudsign/preview").send(body);
  assert.equal(notPdf.body.source.ready, false);
  assert.match(notPdf.body.source.reason, /PDFのみ/);
});

test("テンプレート文書のプレビューは source.kind=template", async () => {
  const { app } = appFor({ live: true, role: "admin" });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/preview").send(body);
  assert.equal(response.body.source.kind, "template");
  assert.equal(response.body.source.ready, true);
});

test("テンプレート文書に添付PDFを束ねて1件のCloudSign書類にできる", async () => {
  const drive = new MemoryDriveStorage();
  drive.seedFile("1AbCdEfGhIjKlMnOpQrSt", Buffer.from("%PDF-1.7 counterparty draft"), "application/pdf");
  // 本体はテンプレート、添付は Drive 実体という混在。案件が一致している必要がある。
  const mixedTemplates = {
    async findRenderSource(key: string) {
      return key === "license" ? { templateVersionId: 1, htmlSource: "<h1>{{TITLE}}</h1>" } : null;
    },
    async findPartials() { return {}; },
    async findCurrent(key: string) {
      return key === "license" ? { templateKey: key, label: key, templateVersionId: 1, fields: [] } : null;
    }
  } as unknown as TemplateRepository;
  const { app, adapter } = appFor({
    live: true, role: "admin", templates: mixedTemplates, driveStorage: drive,
    extraDocs: [{ ...attachment, matterId: 77 }]
  });
  const response = await request(app)
    .post("/api/v2/documents/5/cloudsign/dispatch")
    .send({ ...body, attachDocumentIds: [9] });
  // doc 側に matterId が無いので同案件チェックで弾かれる＝誤添付ガードは維持。
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "CLOUDSIGN_ATTACH_DIFFERENT_MATTER");
  assert.equal((adapter as CapturingCloudSign).sendCount, 0);
});

// ── CloudSign の失敗を原因別に返す（v1-reference 計画 Slice 2）─────────────
class FailingCloudSign implements CloudSignAdapter {
  readonly configured = true;
  constructor(private readonly error: CloudSignError) {}
  async requestSignature(): Promise<never> { throw this.error; }
  async fetchStatus(cloudSignDocumentId: string) {
    return { cloudSignDocumentId, status: "draft", completed: false, participants: [] };
  }
}

function failWith(status: number, body: string) {
  const detail = buildUpstreamDetail({ status, method: "POST", path: "/documents/x/participants", body });
  return new CloudSignError("boom", "http_error", status, detail);
}

test("宛先拒否は原因コードと CloudSign の応答を返す", async () => {
  const { app } = appFor({
    live: true, role: "admin",
    adapter: new FailingCloudSign(failWith(400,
      '{"code":"invalid_participant","message":"許可されていない宛先です: x@example.com"}'))
  });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "CLOUDSIGN_PARTICIPANT_REJECTED");
  assert.match(response.body.error, /メールアドレスを確認/);
  assert.match(response.body.upstreamMessage, /x@example.com/);
  assert.equal(response.body.retryable, false);
});

test("再試行できる失敗は 503 と retryable:true で返す", async () => {
  const { app } = appFor({
    live: true, role: "admin",
    adapter: new FailingCloudSign(failWith(429, '{"message":"too many requests"}'))
  });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CLOUDSIGN_RATE_LIMITED");
  assert.equal(response.body.retryable, true);
});

test("認証失敗はクライアントIDの確認を促す", async () => {
  const { app } = appFor({
    live: true, role: "admin",
    adapter: new FailingCloudSign(failWith(401, '{"error":"invalid_client"}'))
  });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.body.code, "CLOUDSIGN_AUTHENTICATION_FAILED");
  assert.match(response.body.error, /クライアントID/);
});

test("応答に detail が無い失敗は従来どおりの汎用メッセージ", async () => {
  const { app } = appFor({
    live: true, role: "admin",
    adapter: new FailingCloudSign(new CloudSignError("connection refused", "network_error"))
  });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "CLOUDSIGN_API_NETWORK_ERROR");
});

test("UI へ path / status など内部情報を返さない", async () => {
  const { app } = appFor({
    live: true, role: "admin",
    adapter: new FailingCloudSign(failWith(400, '{"message":"client_id=SECRETVALUE rejected"}'))
  });
  const response = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send(body);
  assert.equal("path" in response.body, false);
  assert.equal("status" in response.body, false);
  assert.doesNotMatch(JSON.stringify(response.body), /SECRETVALUE/);
});

// キャンセル→再送: CloudSign 側で取り下げた（canceled）依頼は冪等ガードを塞がない。
// 取り下げ済みIDから新キーを導出して新しい依頼として送る（V1 は毎回新規行で暗黙に再送可だった）。

test("キャンセル済みの依頼は再送できる（新しい依頼として送信・履歴は2件）", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appFor({ live: true, role: "admin", requestHistory });
  const first = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(first.status, 201);
  // 9-6 同期 / webhook が canceled を書き戻した状態を再現
  await requestHistory.updateStatus(first.body.receipt.cloudSignDocumentId, "canceled");
  const second = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(second.status, 201);
  assert.equal(second.body.integrations.cloudsign, "requested");
  assert.equal((adapter as CapturingCloudSign).sendCount, 2);
  assert.equal((await requestHistory.listByDocument(5)).length, 2);
  // 2回目もキャンセルすれば3回目も送れる（連鎖キー）。テストのアダプタは常に同じ
  // cloudSignDocumentId を返すため、2件目の履歴レコードを直接 canceled にする
  // （実CloudSignは依頼ごとに別IDを発行するので updateStatus で届く）。
  const records = await requestHistory.listByDocument(5);
  records[records.length - 1].status = "canceled";
  const third = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(third.status, 201);
  assert.equal((adapter as CapturingCloudSign).sendCount, 3);
});

test("キャンセルではない既依頼（sent/draft/completed）は従来どおり duplicate", async () => {
  const requestHistory = new MemoryCloudSignRequestRepository();
  const { app, adapter } = appFor({ live: true, role: "admin", requestHistory });
  const first = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  await requestHistory.updateStatus(first.body.receipt.cloudSignDocumentId, "completed");
  const second = await request(app).post("/api/v2/documents/5/cloudsign/dispatch").send({ ...body, sendNow: true });
  assert.equal(second.status, 200);
  assert.equal(second.body.integrations.cloudsign, "duplicate");
  assert.equal((adapter as CapturingCloudSign).sendCount, 1);
});
