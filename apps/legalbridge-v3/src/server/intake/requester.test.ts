import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequesterEmail } from "./requester.js";
import type { Queryable } from "../core/db.js";

function db(rowsBySql: Array<{ when: string; rows: Array<Record<string, unknown>> }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []): ReturnType<Queryable["query"]> {
      calls.push({ sql, params });
      const hit = rowsBySql.find((r) => sql.includes(r.when));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 0 };
    }
  };
}

test("依頼にメールがあればそれ（小文字にそろえる。表は引かない）", async () => {
  const q = db([]);
  assert.equal(await resolveRequesterEmail(q, { requester_email: " Taro@Example.com " }), "taro@example.com");
  assert.equal(q.calls.length, 0);
});

test("Slack の ID から社員のメールを引く", async () => {
  const q = db([{ when: "slack_user_id = $1", rows: [{ email: "Taro@example.com" }] }]);
  assert.equal(await resolveRequesterEmail(q, { requester_slack_id: "U01TARO", requester_name: "山田 太郎" }), "taro@example.com");
  assert.equal(q.calls.length, 1);
});

test("名前が 1 人に決まれば当てる。空白の揺れは落として比べる", async () => {
  const q = db([{ when: "replace(replace(name", rows: [{ email: "taro@example.com" }] }]);
  assert.equal(await resolveRequesterEmail(q, { requester_name: "山田　太郎" }), "taro@example.com");
  assert.deepEqual(q.calls[0].params, ["山田太郎"]);
});

test("名前が 2 人以上に当たる、または何も無ければ決めない", async () => {
  const two = db([{ when: "replace(replace(name", rows: [{ email: "a@x" }, { email: "b@x" }] }]);
  assert.equal(await resolveRequesterEmail(two, { requester_name: "山田太郎" }), null);
  assert.equal(await resolveRequesterEmail(db([]), { requester_slack_id: "U0NOBODY", requester_name: "" }), null);
  assert.equal(await resolveRequesterEmail(db([]), {}), null);
});
