import assert from "node:assert/strict";
import test from "node:test";
import { BacklogApiError, BacklogWebApiClient, normalizeBacklogHost } from "./backlog-web-api.js";

test("Backlogのプロジェクトを読取専用GETで確認する", async () => {
  let requested: URL | undefined;
  const client = new BacklogWebApiClient({
    host: "https://arclight.backlog.com/",
    apiKey: "secret-value",
    projectKey: "LEGAL",
    fetch: async (input, init) => {
      requested = new URL(String(input));
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify({
        id: 123,
        projectKey: "LEGAL",
        name: "法務"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(await client.getProject(), {
    id: 123,
    projectKey: "LEGAL",
    name: "法務"
  });
  assert.equal(requested?.pathname, "/api/v2/projects/LEGAL");
  assert.equal(requested?.searchParams.get("apiKey"), "secret-value");
});

test("Backlog APIエラーへAPIキーを含めない", async () => {
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com",
    apiKey: "do-not-leak",
    projectKey: "LEGAL",
    fetch: async () => new Response("forbidden", { status: 403 })
  });
  await assert.rejects(client.getProject(), (error: unknown) => {
    assert.ok(error instanceof BacklogApiError);
    assert.equal(error.message.includes("do-not-leak"), false);
    return true;
  });
});

test("Backlogホストへパスを混在させない", () => {
  assert.equal(normalizeBacklogHost("arclight.backlog.com"), "arclight.backlog.com");
  assert.throws(() => normalizeBacklogHost("arclight.backlog.com/api/v2"));
});

test("課題一覧はprojectIdを解決してGETし、要点を整形する", async () => {
  const urls: URL[] = [];
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com", apiKey: "secret", projectKey: "LEGAL",
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/projects/LEGAL")) {
        return new Response(JSON.stringify({ id: 55, projectKey: "LEGAL", name: "法務" }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { id: 1, issueKey: "LEGAL-1", summary: "NDA確認", description: "件名：秘密保持", status: { name: "未対応" }, assignee: { name: "田中" }, created: "2026-08-01T00:00:00Z", updated: "2026-08-02T00:00:00Z" },
        { id: 2, issueKey: "LEGAL-2", summary: "契約レビュー", status: {}, assignee: null }
      ]), { status: 200 });
    }
  });
  const issues = await client.getIssues({ count: 20, keyword: "契約" });
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], { id: 1, issueKey: "LEGAL-1", summary: "NDA確認", description: "件名：秘密保持", statusName: "未対応", assigneeName: "田中", created: "2026-08-01T00:00:00Z", updated: "2026-08-02T00:00:00Z" });
  assert.equal(issues[1].statusName, null);
  assert.equal(issues[1].assigneeName, null);
  const issuesUrl = urls.find((u) => u.pathname.endsWith("/issues"))!;
  assert.equal(issuesUrl.searchParams.get("projectId[]"), "55");
  assert.equal(issuesUrl.searchParams.get("count"), "20");
  assert.equal(issuesUrl.searchParams.get("keyword"), "契約");
  assert.equal(issuesUrl.searchParams.get("apiKey"), "secret");
});

test("プロジェクトメタデータはstatuses/customFieldsの実IDを整形して返す", async () => {
  const urls: URL[] = [];
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com", apiKey: "secret", projectKey: "LEGAL",
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/statuses")) {
        return new Response(JSON.stringify([
          { id: 1, name: "未対応" },
          { id: 4, name: "完了", color: "#b0be3c" }
        ]), { status: 200 });
      }
      if (url.pathname.endsWith("/customFields")) {
        return new Response(JSON.stringify([
          { id: 101, typeId: 6, name: "契約種別" },
          { id: 102, typeId: 1, name: "相手方" }
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }
  });
  const metadata = await client.getProjectMetadata();
  assert.deepEqual(metadata.statuses, [
    { id: 1, name: "未対応" },
    { id: 4, name: "完了" }
  ]);
  assert.deepEqual(metadata.customFields, [
    { id: 101, name: "契約種別", typeId: 6 },
    { id: 102, name: "相手方", typeId: 1 }
  ]);
  assert.ok(urls.some((u) => u.pathname.endsWith("/projects/LEGAL/statuses")));
  assert.ok(urls.some((u) => u.pathname.endsWith("/projects/LEGAL/customFields")));
  assert.ok(urls.every((u) => u.searchParams.get("apiKey") === "secret"));
});

test("メタデータ取得もAPIエラー時はBacklogApiError", async () => {
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com", apiKey: "do-not-leak", projectKey: "LEGAL",
    fetch: async () => new Response("forbidden", { status: 403 })
  });
  await assert.rejects(client.getProjectMetadata(), (error: unknown) => {
    assert.ok(error instanceof BacklogApiError);
    assert.equal(error.message.includes("do-not-leak"), false);
    return true;
  });
});


test("Backlog課題取得・添付一覧をGETする", async () => {
  const calls: URL[] = [];
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com",
    apiKey: "secret-value",
    projectKey: "LEGAL",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(init?.method, "GET");
      if (url.pathname.endsWith("/attachments")) {
        return new Response(JSON.stringify([{ id: 8, name: "file.pdf", size: 123 }]), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        id: 10,
        projectId: 123,
        issueKey: "LEGAL-10",
        summary: "テスト課題",
        status: { name: "処理中" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const issue = await client.getIssue("LEGAL-10");
  assert.equal(issue.issueKey, "LEGAL-10");
  assert.equal(issue.statusName, "処理中");
  const attachments = await client.listIssueAttachments("LEGAL-10");
  assert.deepEqual(attachments, [{ id: 8, name: "file.pdf", size: 123 }]);
  assert.equal(calls[0].searchParams.get("apiKey"), "secret-value");
});

test("Backlog添付アップロード後にコメントへattachmentIdを渡す", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new BacklogWebApiClient({
    host: "arclight.backlog.com",
    apiKey: "secret-value",
    projectKey: "LEGAL",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname.endsWith("/space/attachment")) {
        assert.equal(init?.method, "POST");
        assert.ok(init?.body instanceof FormData);
        return new Response(JSON.stringify({ id: 55, name: "ARC-LG-1.pdf", size: 12 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      assert.equal(url.pathname, "/api/v2/issues/LEGAL-10/comments");
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof URLSearchParams);
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("attachmentId[]"), "55");
      return new Response(JSON.stringify({ id: 77, content: "registered" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const attachment = await client.uploadAttachment({
    filename: "ARC-LG-1.pdf",
    contentType: "application/pdf",
    data: Uint8Array.from([37, 80, 68, 70])
  });
  assert.equal(attachment.id, 55);
  const comment = await client.addIssueComment({
    issueIdOrKey: "LEGAL-10",
    content: "registered",
    attachmentIds: [attachment.id]
  });
  assert.equal(comment.id, 77);
  assert.equal(calls.length, 2);
});
