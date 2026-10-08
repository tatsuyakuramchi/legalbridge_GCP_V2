import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ExistingContractsImportService } from "./existing-contracts.js";
import { AgreementService } from "../agreements/service.js";

/**
 * 既存契約の一括登録。DucQrews の実例：基本契約 ATT-2026-00069（システムに無い番号）、
 * 条件書は作品ごとに ARC-PUBT-2026-0012（番号だけ先に出した空の条件書）と 0026（まだ無い）。
 */
interface Options {
  works?: Record<string, number>;
  agreements?: Array<{ id: number; no: string; counterparty_id: number; kind: string; title: string }>;
  documents?: Record<string, { id: number; status: string; agreement_id: number | null; condition_ids: number[] | null; party_ids: number[] | null }>;
  conditions?: Record<number, Array<{ id: number; condition_no: string; usage_type: string; agreement_id: number | null }>>;
}

const db = (o: Options = {}) => new FakeDatabase((text, params) => {
  if (text.includes("SELECT id, work_code, title FROM works")) {
    const key = String(params[0] || params[1]);
    const id = o.works?.[key];
    return id ? [{ id, work_code: null, title: key }] : [];
  }
  if (text.includes("SELECT id, name FROM parties")) return [{ id: 120, name: "合同会社DucQrews" }];
  if (text.includes("SELECT id, condition_no, usage_type, agreement_id FROM conditions")) {
    return o.conditions?.[Number(params[0])] ?? [];
  }
  if (text.includes("SELECT id, counterparty_id, kind, title FROM agreements")) {
    return (o.agreements ?? []).filter((a) => a.no.toLowerCase() === String(params[0]).toLowerCase());
  }
  if (text.includes("FROM documents d WHERE d.document_no = $1")) {
    const d = o.documents?.[String(params[0])];
    return d ? [d] : [];
  }
  if (text.includes("INSERT INTO documents")) return [{ id: 9026 }];
  if (text.includes("SELECT COALESCE(max(line_no), 0) AS n")) return [{ n: 0 }];
  return undefined;
});

const deps = () => {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    agreements: {
      create: async (input: Record<string, unknown>) => { created.push(input); return { id: 700, agreementNo: String(input.agreementNo) }; }
    }
  };
};

const ROWS = [
  { 作品名: "武装伝奇RPG　神我狩", 相手先: "合同会社DucQrews", 相手先コード: "V-0120",
    基本契約番号: "ATT-2026-00069", 個別契約番号: "ARC-PUBT-2026-0026", 締結日: "2026-09-24" },
  { 作品名: "神我狩リプレイ 黒剣のスレイヤー", 相手先: "合同会社DucQrews", 相手先コード: "V-0120",
    基本契約番号: "ATT-2026-00069", 個別契約番号: "ARC-PUBT-2026-0012", 締結日: "2026-09-24" }
];

const OPTIONS: Options = {
  works: { "武装伝奇RPG　神我狩": 11, "神我狩リプレイ 黒剣のスレイヤー": 12 },
  conditions: {
    11: [{ id: 111, condition_no: "CL-111", usage_type: "pub_digital", agreement_id: null },
         { id: 112, condition_no: "CL-112", usage_type: "pub_print", agreement_id: null }],
    12: [{ id: 121, condition_no: "CL-121", usage_type: "pub_digital", agreement_id: null }]
  },
  documents: {
    // 番号だけ先に出した空の条件書（相手先も条件も無い）。
    "ARC-PUBT-2026-0012": { id: 9012, status: "issued", agreement_id: null, condition_ids: null, party_ids: null }
  }
};

test("試算は何も書かない。基本契約を作るか、条件書を作るか既存に繋ぐかを行ごとに出す", async () => {
  const fake = db(OPTIONS);
  const d = deps();
  const svc = new ExistingContractsImportService(fake, d);
  const r = await svc.run(ROWS, true, "tester");
  assert.deepEqual([r.ok, r.error], [2, 0]);
  assert.match(r.rows[0].message ?? "", /基本契約 ATT-2026-00069（作る）／条件書 ARC-PUBT-2026-0026（作る）／条件 CL-111・CL-112/);
  assert.match(r.rows[1].message ?? "", /基本契約 ATT-2026-00069（作る）／条件書 ARC-PUBT-2026-0012（既存に繋ぐ）/,
    "同じ CSV の前の行で作る基本契約も、試算では「作る」と読む");
  assert.equal(d.created.length, 0);
  assert.equal(fake.find("INSERT INTO documents"), undefined);
  assert.equal(fake.find("UPDATE conditions SET agreement_id"), undefined);
});

test("登録：基本契約は外部番号のまま 1 回だけ作り、条件をぶら下げる。無い条件書はその番号で作り、ある条件書は使い直して条件に繋ぐ", async () => {
  const fake = db(OPTIONS);
  const d = deps();
  const svc = new ExistingContractsImportService(fake, d);
  const r = await svc.run(ROWS, false, "tester");
  assert.deepEqual([r.ok, r.error], [2, 0], JSON.stringify(r.rows));

  assert.equal(d.created.length, 1, "同じ番号の基本契約は 2 行目では作らない");
  assert.deepEqual(
    [d.created[0].agreementNo, d.created[0].kind, d.created[0].domain, d.created[0].direction, d.created[0].status, d.created[0].executedOn],
    ["ATT-2026-00069", "master", "license", "in", "executed", "2026-09-24"]);

  const hang = fake.all("UPDATE conditions SET agreement_id");
  assert.deepEqual(hang.map((q) => q.params), [[[111, 112], 700], [[121], 700]]);

  const insert = fake.find("INSERT INTO documents")!;
  assert.equal(insert.params[0], "ARC-PUBT-2026-0026", "外部番号のまま（採番しない）");
  assert.equal(insert.params[1], 700);
  assert.equal(JSON.parse(String(insert.params[2])).documentKind, "利用許諾契約書", "条件書として扱う種別");
  assert.equal(insert.params[3], "2026-09-24");

  const reuse = fake.find("UPDATE documents")!;
  assert.deepEqual(reuse.params.slice(0, 2), [9012, 700], "番号だけの条件書を基本契約の下に置く");

  const links = fake.all("INSERT INTO document_conditions").map((q) => q.params.slice(0, 2));
  assert.deepEqual(links, [[9026, 111], [9026, 112], [9012, 121]]);
  assert.ok(fake.all("INSERT INTO document_conditions").every((q) => q.text.includes("ON CONFLICT (document_id, condition_id) DO NOTHING")),
    "当て先は主キー（行番号の一意制約は遅延可能で当て先にできない）");
  assert.equal(fake.all("INSERT INTO audit_events").filter((q) => q.params.includes("contracts.register_existing")).length, 2);
});

test("止める：作品が無い・条件が無い・基本契約が別の相手先・条件書が別の相手先の条件に繋がっている・条件が別の契約に載っている", async () => {
  const svc = (o: Options) => new ExistingContractsImportService(db({ ...OPTIONS, ...o }), deps());
  const one = async (o: Options, row: Record<string, string> = ROWS[0]) => (await svc(o).run([row], true, "t")).rows[0];

  assert.match((await one({ works: {} })).message ?? "", /作品「武装伝奇RPG　神我狩」が見つかりません/);
  assert.match((await one({ conditions: {} })).message ?? "", /出版条件（紙・電子）がありません/);
  assert.match((await one({ agreements: [{ id: 5, no: "ATT-2026-00069", counterparty_id: 999, kind: "master", title: "x" }] })).message ?? "",
    /合同会社DucQrews の契約ではありません/);
  assert.match((await one({ documents: { "ARC-PUBT-2026-0026": { id: 1, status: "issued", agreement_id: null, condition_ids: [9], party_ids: [999] } } })).message ?? "",
    /別の相手先の条件に繋がっています/);
  assert.match((await one({
    agreements: [{ id: 5, no: "ATT-2026-00069", counterparty_id: 120, kind: "master", title: "x" }],
    conditions: { 11: [{ id: 111, condition_no: "CL-111", usage_type: "pub_digital", agreement_id: 42 }] }
  })).message ?? "", /別の契約（#42）に載っています/);
  assert.match((await one({}, { ...ROWS[0], 個別契約番号: "" })).message ?? "", /個別契約番号が空です/);
});

test("基本契約：外部番号を渡せば採番せずその番号で作る。同じ番号があれば止める", async () => {
  const fake = new FakeDatabase((text) => {
    if (text.includes("SELECT id, name FROM parties WHERE id = $1")) return [{ id: 120, name: "DucQrews" }];
    if (text.includes("SELECT id FROM agreements WHERE lower(btrim(agreement_no))")) return [];
    if (text.includes("INSERT INTO agreements")) return [{ id: 700 }];
    return undefined;
  });
  const svc = new AgreementService(fake);
  const r = await svc.create({ counterpartyId: 120, direction: "in", kind: "master", domain: "license",
                               title: "出版及び著作物利用許諾に関する基本契約書", agreementNo: " ATT-2026-00069 ",
                               status: "executed", executedOn: "2026-09-24" }, "tester");
  assert.deepEqual(r, { id: 700, agreementNo: "ATT-2026-00069" });
  assert.equal(fake.find("document_sequences"), undefined, "採番しない");
  assert.equal(fake.find("INSERT INTO agreements")!.params[0], "ATT-2026-00069");

  const dup = new AgreementService(new FakeDatabase((text) => {
    if (text.includes("SELECT id, name FROM parties WHERE id = $1")) return [{ id: 120, name: "DucQrews" }];
    if (text.includes("SELECT id FROM agreements WHERE lower(btrim(agreement_no))")) return [{ id: 3 }];
    return undefined;
  }));
  await assert.rejects(dup.create({ counterpartyId: 120, direction: "in", kind: "master", domain: "license",
                                    title: "x", agreementNo: "ATT-2026-00069" }, "t"), /もう使われています/);
});
