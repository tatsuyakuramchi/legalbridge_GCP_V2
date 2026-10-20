import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { HomeStationsService } from "./home-stations.js";

const tools = (over: Partial<ConstructorParameters<typeof HomeStationsService>[1]> = {}) => ({
  intake: { counts: async () => ({ new: 2, updated: 1 }) },
  tasks: { counts: async () => ({ open: 7 }) },
  unsent: { list: async () => ({ bundles: [{ docs: [1, 2] }, { docs: [3] }] }) },
  missing: { list: async () => ({ parties: [1, 2, 3] }) },
  paydocs: { list: async () => ({ tiles: { wait: 4, make: 5, draft: 1, unsent: 6, await: 2, overdue: 9, nopay: 0 } }) },
  term: { preview: async () => ({ targets: [{ skip: null }, { skip: "x" }] }) },
  notice: { preview: async () => ({ targets: [{ skip: null }] }) },
  statements: { preview: async () => ({ groups: [{ status: "ready" }, { status: "paid" }] }) },
  tidy: { parties: async () => [{ marks: 2 }, { marks: 0 }] },
  ...over
});
const db = () => new FakeDatabase((t) => t.includes("AS owner_check") ? [{ drafts: 3, owner_check: 4, signing: 1, planned: 8 }] : undefined);

test("5 駅の札：各画面と同じ道具の数をそのまま並べる", async () => {
  const r = await new HomeStationsService(db(), tools()).stations();
  const card = (no: number, key: string) => r.stations.find((s) => s.no === no)!.cards.find((c) => c.key === key)!;
  assert.equal(card(1, "intake").count, 3);
  assert.equal(card(1, "tidy").count, 1, "直すところのある取引先だけ");
  assert.equal(card(2, "missing").count, 3);
  assert.equal(card(2, "drafts").count, 3);
  assert.equal(card(3, "fixes").count, 1 + 1 + 1, "skip の無い期間・通知先と ready の計算書");
  assert.equal(card(3, "owner").count, 4);
  assert.deepEqual([card(4, "unsent").count, card(4, "unsent").sub], [3, "2 相手先"]);
  assert.equal(card(5, "signing").count, 1);
  assert.equal(card(5, "planned").count, 8);
  assert.deepEqual(card(1, "tidy").go, { view: "agreement-map", mode: "tidy" });
  assert.deepEqual(card(4, "payunsent").go, { view: "paydocs", tile: "unsent" });
});

test("道具が 1 つ落ちても盤面は出る（その札は 0）", async () => {
  const r = await new HomeStationsService(db(), tools({ unsent: { list: async () => { throw new Error("down"); } } })).stations();
  assert.equal(r.stations.find((s) => s.no === 4)!.cards[0]!.count, 0);
  assert.equal(r.stations.find((s) => s.no === 1)!.cards[0]!.count, 3);
});
