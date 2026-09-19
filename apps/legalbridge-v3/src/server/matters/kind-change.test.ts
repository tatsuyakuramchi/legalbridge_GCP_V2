import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterWriteService } from "./write-service.js";

/**
 * 取引モデルは案件が扱うものを決める。作るときに間違えると後戻りできず、
 * 「文書作成のつもりが委託だった」がそのまま残っていた。
 * 変えられるようにするが、繋がっている条件が使えなくなる組み合わせは断る。
 */
const db = (linked: Array<Record<string, unknown>> = [], from = "single") =>
  new FakeDatabase((t) => {
    if (t.includes("SELECT kind FROM matters")) return [{ kind: from }];
    if (t.includes("target_type = 'condition'")) return linked;
    return undefined;
  });

test("取引モデルを変えられる", async () => {
  const d = db();
  const r = await new MatterWriteService(d).changeKind(3, "outsourcing", "kuramochi");
  assert.deepEqual(r, { id: 3, kind: "outsourcing" });
  assert.deepEqual(d.find("UPDATE matters SET kind")!.params, [3, "outsourcing"]);
  const audit = d.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "matter.change_kind");
  assert.deepEqual(JSON.parse(String(audit.params[5])), { from: "single", to: "outsourcing" });
});

test("同じモデルなら何もしない", async () => {
  const d = db([], "outsourcing");
  await new MatterWriteService(d).changeKind(3, "outsourcing", "a");
  assert.equal(d.find("UPDATE matters SET kind"), undefined);
});

test("繋がっている条件が使えなくなるなら断る（条件番号を添えて）", async () => {
  // 業務委託の委託料が繋がったままライセンスへ変えると、辿れるのに繋ぎ直せない条件が残る。
  const d = db([{ kind: "service", condition_no: "CL-2026-00410" }], "outsourcing");
  await assert.rejects(
    () => new MatterWriteService(d).changeKind(3, "work", "a"),
    /CL-2026-00410.*先に条件を外して/s);
  assert.equal(d.find("UPDATE matters SET kind"), undefined);
});

test("新しいモデルでも使える条件なら、繋がったまま変えられる", async () => {
  // 文書作成はどの種類も繋げるので、業務委託から移しても条件は残せる。
  const d = db([{ kind: "service", condition_no: "CL-2026-00410" }], "outsourcing");
  await new MatterWriteService(d).changeKind(3, "single", "a");
  assert.deepEqual(d.find("UPDATE matters SET kind")!.params, [3, "single"]);
});

test("無い案件は分かる理由で断る", async () => {
  const d = new FakeDatabase(() => []);
  await assert.rejects(() => new MatterWriteService(d).changeKind(9, "work", "a"),
    /案件 9 が見つかりません/);
});
