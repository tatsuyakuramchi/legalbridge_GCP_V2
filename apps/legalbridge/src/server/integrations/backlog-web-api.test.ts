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
