import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MemoryDriveStorage } from "../documents/drive-storage.js";
import {
  RequesterUploadService, attachUploadsToMatter, makeUploadToken, safeFileName, verifyUploadToken, UPLOAD_MAX_BYTES
} from "./upload-service.js";
import { submitAcknowledgement } from "./request-service.js";

const SECRET = "s".repeat(32);

test("署名付きの鍵：作ったものは通る。書き換え・別の秘密・期限切れは断る", () => {
  const now = Date.UTC(2026, 8, 26);
  const t = makeUploadToken(SECRET, "r", 12, now);
  assert.deepEqual(verifyUploadToken(SECRET, t, now), { target: "r", id: 12 });
  assert.throws(() => verifyUploadToken(SECRET, t.replace("r.12.", "r.13."), now), /リンクが正しくありません/);
  assert.throws(() => verifyUploadToken("x".repeat(32), t, now), /リンクが正しくありません/);
  assert.throws(() => verifyUploadToken(SECRET, t, now + 31 * 86400_000), /有効期限（30 日）が切れています/);
  assert.throws(() => verifyUploadToken("", t, now), /設定がありません/, "秘密が無ければ受け付けない");
});

test("ファイル名からパスと制御文字を落とす", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\a\\契約書.docx"), "契約書.docx");
  assert.equal(safeFileName("a\u0000b.pdf"), "ab.pdf");
  assert.equal(safeFileName(""), "file");
});

test("設定が無ければリンクを作らず、理由を返す", () => {
  const db = new FakeDatabase();
  assert.match(String(new RequesterUploadService(db, null, { secret: "", publicBaseUrl: "https://x" }).link("r", 1).reason), /UPLOAD_SIGNING_SECRET/);
  assert.match(String(new RequesterUploadService(db, null, { secret: SECRET, publicBaseUrl: "" }).link("r", 1).reason), /PUBLIC_BASE_URL/);
  const ok = new RequesterUploadService(db, null, { secret: SECRET, publicBaseUrl: "https://legal.example.com/" }).link("m", 5);
  assert.match(String(ok.url), /^https:\/\/legal\.example\.com\/internal\/upload\?t=m\.5\./);
});

const service = (rows: { request?: any; stored?: any }) => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM intake_requests r WHERE r.id")) return rows.request ? [rows.request] : [];
    if (t.includes("INSERT INTO requester_uploads")) return [{ id: 1 }];
    if (t.includes("FROM requester_uploads WHERE id")) return [rows.stored];
    if (t.includes("FROM document_sequences")) return [{ current_value: 1 }];
    if (t.includes("RETURNING current_value")) return [{ current_value: 1 }];
    return undefined;
  });
  return { db, s: new RequesterUploadService(db, new MemoryDriveStorage(), { secret: SECRET, publicBaseUrl: "https://x" }) };
};
const storedRow = { id: 1, upload_no: "ATT-2026-00001", kind: "counterparty_draft", file_name: "draft.docx",
  mime_type: "application/msword", size_bytes: 3, drive_url: "https://drive/x", uploader_email: "a@example.com",
  note: null, uploaded_at: new Date(), intake_request_id: 9, matter_id: 4 };

test("保存：Drive に置いて記録し、依頼が案件になっていれば案件のやり取りにも残す", async () => {
  const { db, s } = service({ request: { request_id: 9, matter_id: 4, label: "REQ-2026-00009" }, stored: storedRow });
  const r = await s.store({ target: "r", id: 9 }, { name: "../draft.docx", mimeType: "application/msword", data: Buffer.from("abc") },
                          { kind: "counterparty_draft", uploaderEmail: "a@example.com" });
  assert.equal(r.uploadNo, "ATT-2026-00001");
  const ins = db.all("INSERT INTO requester_uploads")[0];
  assert.equal(ins.params[1], 9);
  assert.equal(ins.params[2], 4);
  assert.equal(ins.params[4], "draft.docx", "パスは落とす");
  assert.equal(db.all("INSERT INTO matter_communications").length, 1);
  assert.ok(db.all("INSERT INTO audit_events").some((q) => q.params[1] === "upload.store"));
});

test("保存：大きすぎる・空・メールの形が違うものは断る。Drive が無ければ理由を返す", async () => {
  const { s } = service({ request: { request_id: 9, matter_id: null, label: "REQ" } });
  await assert.rejects(s.store({ target: "r", id: 9 }, { name: "a", mimeType: "", data: Buffer.alloc(0) }, {}), /空のファイル/);
  await assert.rejects(s.store({ target: "r", id: 9 }, { name: "a", mimeType: "", data: Buffer.alloc(UPLOAD_MAX_BYTES + 1) }, {}), /30MB/);
  await assert.rejects(s.store({ target: "r", id: 9 }, { name: "a", mimeType: "", data: Buffer.from("x") }, { uploaderEmail: "nope" }), /メールアドレス/);
  const none = new RequesterUploadService(new FakeDatabase(), null, { secret: SECRET, publicBaseUrl: "https://x" });
  await assert.rejects(none.store({ target: "r", id: 9 }, { name: "a", mimeType: "", data: Buffer.from("x") }, {}), /Drive/);
});

test("受付で案件になったら、それまでの資料を案件に繋ぐ。表がまだ無ければ何もしない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("to_regclass")) return [{ ok: true }];
    if (t.includes("UPDATE requester_uploads")) return [{ upload_no: "ATT-2026-00002", file_name: "a.pdf", kind: "reference",
      uploader_email: null, drive_file_id: "f1", drive_url: "https://drive/f1" }];
    return undefined;
  });
  assert.equal(await attachUploadsToMatter(db, 9, 4), 1);
  assert.equal(db.all("INSERT INTO matter_communications").length, 1);
  assert.equal(await attachUploadsToMatter(new FakeDatabase(() => [{ ok: false }]), 9, 4), 0);
});

test("Slack の受付確認に、アップロードのリンクを添える（作れなければ添えない）", () => {
  const submission = { kind: "single" as const, title: "NDA", counterpartyName: null, dueOn: null, detail: null,
                       requesterSlackId: "U1", requesterName: null };
  assert.match(submitAcknowledgement({ requestNo: "REQ-1", issueKey: null, submission, uploadUrl: "https://x/u" }),
               /<https:\/\/x\/u\|資料アップロードページ>/);
  assert.doesNotMatch(submitAcknowledgement({ requestNo: "REQ-1", issueKey: null, submission }), /アップロード/);
});
