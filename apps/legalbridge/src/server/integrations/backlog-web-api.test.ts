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
