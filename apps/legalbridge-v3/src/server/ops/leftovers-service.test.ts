import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { LeftoverService } from "./leftovers-service.js";

/**
 * 残骸の片づけ。消す操作なので、断るところを厚く確かめる。
 * 実際に消す手順はそれぞれの持ち主に任せてあるので、ここで見るのは
 * 「誰に、どの順で渡すか」と「渡さないもの」。
 */

const calls: string[] = [];
const parts = (over: Record<string, unknown> = {}) => {
  calls.length = 0;
  return {
    documents: { discardDraft: async (id: number) => { calls.push(`draft:${id}`); return {} as never; } },
    events: {
      discardVoided: async (_c: number, id: number) => { calls.push(`event:${id}`); return {} as never; }
    },
    conditions: {
      remove: async (id: number, _actor: string, reason?: string) => {
        calls.push(`condition:${id}:${reason ?? ""}`); return {} as never;
      }
    },
    ...over
  } as never;
};

/** 下書き1件・無効な実績1件・無効な条件1件が残っている台帳。 */
const db = () => new FakeDatabase((t) => {
  if (t.includes("FROM documents d")) {
    return [{ id: 11, status: "draft", created_at: null, supersedes_id: null,
              h_events: 0, h_notes: 0, h_successors: 0 }];
  }
  if (t.includes("FROM condition_events e")) {
    return [{ id: 22, condition_id: 5, occurred_on: "2026-09-01",
              h_allocations: 0, h_statement_lines: 0 }];
  }
  if (t.includes("FROM conditions c")) {
    return [{ id: 33, condition_no: "CL-1", name: "旧条件",
              h_events: 0, h_out_refs: 0, h_documents: 0, h_payments: 0,
              h_statements: 0, h_matters: 0, h_children: 0, h_older: 0 }];
  }
  if (t.includes("SELECT condition_id FROM condition_events")) return [{ condition_id: 5 }];
  return [];
});

test("実績を条件より先に渡す（順が逆だと条件が実績に引き止められる）", async () => {
  const p = parts();
  const r = await new LeftoverService(db(), p).dispose(
    [{ kind: "condition", id: 33 }, { kind: "event", id: 22 }, { kind: "draft", id: 11 }],
    "確認用に作ったものの片づけ", "admin");
  // 理由は3つとも同じものが渡る（監査で片づけの1回ぶんが辿れる）。
  assert.deepEqual(calls, ["draft:11", "event:22", "condition:33:確認用に作ったものの片づけ"]);
  assert.deepEqual(r.map((x) => x.removed), [true, true, true]);
});

test("一覧に無いものは、持ち主に渡さない", async () => {
  // 出した記録・生きている行を id で名指しされても、ここから先へ通さない。
  const p = parts();
  const r = await new LeftoverService(db(), p).dispose(
    [{ kind: "draft", id: 999 }], "確認", "admin");
  assert.equal(r[0].removed, false);
  assert.match(r[0].message!, /片づけの対象ではありません/);
  // 「もう無い」と言い切らない（生きている行が消えたと読めてしまう）。
  assert.doesNotMatch(r[0].message!, /^もう残っていません/);
  assert.deepEqual(calls, [], "1つも渡していないこと");
});

test("途中で断られても、そこまでは捨てたまま1件ずつ返す", async () => {
  // まとめて巻き戻すと、捨てられたものまで戻って何度やっても同じ所で止まる。
  const p = parts({
    events: { discardVoided: async () => { throw new Error("支払の割当 1 件"); } }
  });
  const r = await new LeftoverService(db(), p).dispose(
    [{ kind: "draft", id: 11 }, { kind: "event", id: 22 }, { kind: "condition", id: 33 }],
    "片づけ", "admin");
  assert.deepEqual(r.map((x) => [x.kind, x.removed]),
    [["draft", true], ["event", false], ["condition", true]]);
  assert.ok(calls.includes("condition:33:片づけ"));
  assert.match(r[1].message!, /支払の割当/);
});

test("理由は必須。選ばれていなければ断る", async () => {
  const s = new LeftoverService(db(), parts());
  await assert.rejects(() => s.dispose([{ kind: "draft", id: 11 }], "  ", "admin"),
    /捨てる理由は必須です/);
  await assert.rejects(() => s.dispose([], "片づけ", "admin"), /選ばれていません/);
});

test("指しているものがあれば、捨てられないものとして並べる", async () => {
  const held = new FakeDatabase((t) => {
    if (t.includes("FROM documents d")) {
      return [{ id: 11, status: "draft", created_at: null, supersedes_id: null,
                h_events: 2, h_notes: 0, h_successors: 0 }];
    }
    return [];
  });
  const items = await new LeftoverService(held, parts()).list();
  assert.equal(items[0].disposable, false);
  assert.deepEqual(items[0].holders, [{ target: "結びついた実績", rows: 2 }]);
});

test("訂正版の下書きには、捨てる前の注意を付ける", async () => {
  // 「金額の直し」が作った直しかけ。捨てると元の文書が直っていないまま残る。
  const wip = new FakeDatabase((t) => {
    if (t.includes("FROM documents d")) {
      return [{ id: 107, status: "draft", created_at: null, supersedes_id: 52,
                supersedes_no: "ARC-PO-2026-0036", supersede_reason: "納品日の再調整",
                h_events: 0, h_notes: 0, h_successors: 0 }];
    }
    return [];
  });
  const items = await new LeftoverService(wip, parts()).list();
  assert.equal(items[0].disposable, true, "引き止めはしない");
  assert.match(items[0].caution!, /ARC-PO-2026-0036 は直っていないまま残ります/);
  assert.match(items[0].origin, /訂正版の作りかけ/);
});
