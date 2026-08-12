import assert from "node:assert/strict";
import test from "node:test";
import { CloudSignApiAdapter, FetchCloudSignApiClient, type CloudSignApiClient } from "./cloudsign-api-adapter.js";

class FakeClient implements CloudSignApiClient {
  calls: string[] = [];
  async createDocument(input: { title: string }) { this.calls.push(`create:${input.title}`); return { id: "doc-1" }; }
  async addFile(documentId: string, filename: string) { this.calls.push(`file:${documentId}:${filename}`); return { id: "file-1" }; }
  async addParticipant(documentId: string, p: { email: string }) { this.calls.push(`participant:${p.email}`); return { id: `pt-${p.email}` }; }
  async addReportee(documentId: string, r: { email: string }) { this.calls.push(`cc:${r.email}`); return { id: `cc-${r.email}` }; }
  async send(documentId: string) { this.calls.push(`send:${documentId}`); return { status: "sent" }; }
  async getDocument(documentId: string) {
    this.calls.push(`get:${documentId}`);
    return { id: documentId, status: 2, participants: [{ email: "a@example.com", status: 2 }] };
  }
}

const baseRequest = {
  documentTitle: "契約書（DOC-1）", note: "案件：LB-1", filename: "doc.pdf",
  pdf: Buffer.from("%PDF-1.4"), idempotencyKey: "k",
  participants: [{ email: "a@example.com", name: "甲" }, { email: "b@example.com", name: "乙" }]
};

test("即時送信(sendNow)はcreate→file→participant→sendの順で発行する", async () => {
  const client = new FakeClient();
  const adapter = new CloudSignApiAdapter(client);
  const receipt = await adapter.requestSignature({ ...baseRequest, sendNow: true });
  assert.equal(receipt.cloudSignDocumentId, "doc-1");
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.participantIds, ["pt-a@example.com", "pt-b@example.com"]);
  assert.deepEqual(client.calls, [
    "create:契約書（DOC-1）", "file:doc-1:doc.pdf",
    "participant:a@example.com", "participant:b@example.com", "send:doc-1"
  ]);
});

test("既定は下書き作成（send を呼ばず status=draft・CC は reportees へ）", async () => {
  const client = new FakeClient();
  const adapter = new CloudSignApiAdapter(client);
  const receipt = await adapter.requestSignature({
    ...baseRequest, cc: [{ email: "cc@example.com", name: "共有" }]
  });
  assert.equal(receipt.status, "draft");
  assert.deepEqual(client.calls, [
    "create:契約書（DOC-1）", "file:doc-1:doc.pdf",
    "participant:a@example.com", "participant:b@example.com", "cc:cc@example.com"
  ]);
});

test("CCのメールが不正なら発行せず失敗する", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  await assert.rejects(
    () => adapter.requestSignature({ ...baseRequest, cc: [{ email: "bad" }] }),
    /valid cc email/);
});

test("署名者が空なら送信せず失敗する", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  await assert.rejects(() => adapter.requestSignature({ ...baseRequest, participants: [] }), /participant/);
});

test("署名者のメールが不正なら送信せず失敗する", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  await assert.rejects(
    () => adapter.requestSignature({ ...baseRequest, participants: [{ email: "bad", name: "甲" }] }),
    /valid participant email/);
});

test("ステータス取得はコードを正規化して完了判定を返す", async () => {
  const adapter = new CloudSignApiAdapter(new FakeClient());
  const status = await adapter.fetchStatus("doc-9");
  assert.equal(status.status, "completed");
  assert.equal(status.completed, true);
  assert.equal(status.participants[0].email, "a@example.com");
  assert.equal(status.participants[0].status, "completed");
});

// 実HTTPクライアントの契約テスト（V1 実仕様準拠）。fetch を差し替えて
// リクエストの URL / メソッド / Content-Type / body を記録する。
interface SeenRequest { url: string; method: string; contentType: string; body: string; }

function recordingFetch(seen: SeenRequest[], responder: (url: string) => { status?: number; json: any }): typeof fetch {
  return (async (input: any, init: any) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body = "";
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (init?.body) body = "[multipart]";
    seen.push({ url, method: String(init?.method ?? "GET"), contentType: headers["Content-Type"] ?? "", body });
    const { status = 200, json } = responder(url);
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as unknown as typeof fetch;
}

const okResponder = (url: string) => {
  if (url.endsWith("/token")) return { json: { access_token: "tok-1", expires_in: 600 } };
  return { json: { id: "x", status: 2, participants: [] } };
};

test("/token は client_id のみを form-urlencoded body で送る（client_secret 無し）", async () => {
  const seen: SeenRequest[] = [];
  const client = new FetchCloudSignApiClient("https://api.cloudsign.jp", "cid-1", { fetchImpl: recordingFetch(seen, okResponder) });
  await client.getDocument("doc-1");
  const tokenReq = seen.find((r) => r.url.endsWith("/token"))!;
  assert.equal(tokenReq.method, "POST");
  assert.equal(tokenReq.contentType, "application/x-www-form-urlencoded");
  assert.equal(tokenReq.body, "client_id=cid-1");
  assert.doesNotMatch(tokenReq.body, /client_secret/);
});

test("createDocument は form-urlencoded の title のみ、addParticipant も form-urlencoded", async () => {
  const seen: SeenRequest[] = [];
  const client = new FetchCloudSignApiClient("https://api.cloudsign.jp", "cid-1", { fetchImpl: recordingFetch(seen, okResponder) });
  await client.createDocument({ title: "契約書", note: "無視される" });
  await client.addParticipant("doc-1", { email: "a@example.com", name: "甲", organization: "会社" });
  const create = seen.find((r) => r.url.endsWith("/documents"))!;
  assert.equal(create.contentType, "application/x-www-form-urlencoded");
  assert.match(create.body, /title=/);
  assert.doesNotMatch(create.body, /note/);
  const part = seen.find((r) => r.url.includes("/participants"))!;
  assert.equal(part.contentType, "application/x-www-form-urlencoded");
  assert.match(part.body, /email=a%40example.com/);
  assert.match(part.body, /organization=/);
});

test("addFile は multipart で uploadfile 項目名を使う", async () => {
  const seen: SeenRequest[] = [];
  const client = new FetchCloudSignApiClient("https://api.cloudsign.jp", "cid-1", { fetchImpl: recordingFetch(seen, okResponder) });
  await client.addFile("doc-1", "c.pdf", Buffer.from("%PDF-1.4"));
  const fileReq = seen.find((r) => r.url.includes("/files"))!;
  assert.equal(fileReq.method, "POST");
  assert.equal(fileReq.body, "[multipart]");
  // multipart は Content-Type を明示しない（boundary を fetch に任せる）。
  assert.equal(fileReq.contentType, "");
});

test("トークンは expires_in の範囲で再利用し、/token を毎回は叩かない", async () => {
  const seen: SeenRequest[] = [];
  const client = new FetchCloudSignApiClient("https://api.cloudsign.jp", "cid-1", { fetchImpl: recordingFetch(seen, okResponder) });
  await client.getDocument("doc-1");
  await client.getDocument("doc-2");
  assert.equal(seen.filter((r) => r.url.endsWith("/token")).length, 1);
});

test("401 のときトークンを捨てて 1 回だけ再取得する", async () => {
  const seen: SeenRequest[] = [];
  let firstAuthed = true;
  const responder = (url: string) => {
    if (url.endsWith("/token")) return { json: { access_token: "tok", expires_in: 600 } };
    if (firstAuthed) { firstAuthed = false; return { status: 401, json: { message: "expired" } }; }
    return { json: { id: "doc-1", status: 2, participants: [] } };
  };
  const client = new FetchCloudSignApiClient("https://api.cloudsign.jp", "cid-1", { fetchImpl: recordingFetch(seen, responder) });
  const doc = await client.getDocument("doc-1");
  assert.equal((doc as any).id, "doc-1");
  // 初回トークン + 401後の再取得 = 2 回。
  assert.equal(seen.filter((r) => r.url.endsWith("/token")).length, 2);
});
