import assert from "node:assert/strict";
import test from "node:test";
import {
  PgConditionSyncRepository, MemoryConditionSyncRepository, type ConditionSyncClient
} from "./condition-sync-repository.js";
import { buildDocumentConditionInputs } from "./condition-sync.js";

// Pg 実装の SQL 発行列を台本式の偽クライアントで検証する（実DBなし）。
// 監査指摘（Pg 実装が1本もテストされない）への対応として、クエリ内容まで見る。

type Issued = { text: string; params: unknown[] };

function fakeClient(options: {
  existingLineCodes?: Record<string, string>; materialWorkId?: number;
  // 文書の作品紐づけ（form_data.work_code）と、それが指す作品ID。
  documentWorkCode?: string; documentWorkId?: number;
  // 契約取込が form_data.work_id に入れる参照（契約番号-作品コードの連結）と、実在する作品コード。
  documentWorkRef?: string; worksCode?: string;
} = {}) {
  const issued: Issued[] = [];
  let seq = 0;
  let lineId = 100;
  const client: ConditionSyncClient = {
    async query(text: string, params: unknown[] = []) {
      issued.push({ text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
      if (text.includes("FROM documents WHERE id")) {
        return { rows: [{ work_code: options.documentWorkCode ?? null, work_ref: options.documentWorkRef ?? null }] };
      }
      if (text.includes("FROM works WHERE")) {
        const match = options.worksCode ?? options.documentWorkCode;
        return options.documentWorkId && params[0] === match
          ? { rows: [{ id: options.documentWorkId }] } : { rows: [] };
      }
      if (text.includes("FROM work_materials")) {
        return options.materialWorkId
          ? { rows: [{ id: 77, work_id: options.materialWorkId }] }
          : { rows: [] };
      }
      if (text.includes("SELECT line_code FROM condition_lines")) {
        const key = `${params[0]}:${params[1]}`;
        const code = options.existingLineCodes?.[key];
        return { rows: code ? [{ line_code: code }] : [] };
      }
      if (text.includes("INSERT INTO document_sequences")) {
        return { rows: [{ current_value: ++seq }] };
      }
      if (text.includes("INSERT INTO condition_lines")) {
        return { rows: [{ id: ++lineId }] };
      }
      if (text.startsWith("DELETE FROM condition_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE condition_lines")) {
        return { rows: [{ id: 1 }, { id: 2 }] };
      }
      return { rows: [] };
    },
    release() { /* noop */ }
  };
  return { client, issued };
}

function repositoryFor(fake: { client: ConditionSyncClient }) {
  return new PgConditionSyncRepository({ connect: async () => fake.client });
}

test("Pg: upsert は (document_id,line_no) 競合更新・素材結線・CHECK整合で発行される", async () => {
  const fake = fakeClient({ materialWorkId: 55 });
  const result = await repositoryFor(fake).upsertDocumentConditions(10, buildDocumentConditionInputs({
    financial_conditions: [
      { condition_no: 1, condition_name: "利用許諾料", rate_pct: 10, mg_amount: 200000,
        material_code: "MAT-001", region_territory: "日本・韓国" },
      { condition_no: 2, condition_name: "一時金", unit_amount: 50000 }
    ]
  }));
  assert.equal(result.written, 2);

  const inserts = fake.issued.filter((q) => q.text.includes("INSERT INTO condition_lines"));
  assert.equal(inserts.length, 2);
  assert.ok(inserts[0].text.includes("ON CONFLICT (document_id, line_no) DO UPDATE"));
  // line_code は更新対象から除外（採番の安定性）
  assert.ok(!/ON CONFLICT.*line_code = EXCLUDED/.test(inserts[0].text.replace(/\n/g, " ")));

  // 1行目: royalty＝rate/mg 保持・素材結線（source_material_id=77 / source_work_id=55）
  const cols = inserts[0].text.match(/INSERT INTO condition_lines \(([^)]+)\)/)![1]
    .split(",").map((c) => c.trim());
  const rowOf = (issued: Issued) => Object.fromEntries(cols.map((c, i) => [c, issued.params[i]]));
  const first = rowOf(inserts[0]);
  assert.equal(first.payment_scheme, "royalty");
  assert.equal(first.rate_pct, 10);
  assert.equal(first.mg_amount, 200000);
  assert.equal(first.source_material_id, 77);
  assert.equal(first.source_work_id, 55);
  assert.equal(first.amount_ex_tax, null);            // royalty は消化型でない
  // 2行目: lump_sum＝rate/mg/ag NULL・amount_ex_tax 既定0（消化型）
  const second = rowOf(inserts[1]);
  assert.equal(second.payment_scheme, "lump_sum");
  assert.equal(second.rate_pct, null);
  assert.equal(second.mg_amount, null);
  assert.equal(second.amount_ex_tax, 0);

  // 地域は結合文字列の分解で子テーブルへ置換（DELETE→INSERT 2件・言語は未指定＝触らない）
  const regionDeletes = fake.issued.filter((q) => q.text.startsWith("DELETE FROM condition_line_regions"));
  const regionInserts = fake.issued.filter((q) => q.text.includes("INSERT INTO condition_line_regions"));
  assert.equal(regionDeletes.length, 1);
  assert.deepEqual(regionInserts.map((q) => q.params[2]), ["日本", "韓国"]);
  assert.equal(fake.issued.some((q) => q.text.includes("condition_line_languages")), false);

  // 安全削除: 実績・作品参照を持たない行だけを対象にするガードがある
  const cleanup = fake.issued.find((q) => q.text.startsWith("DELETE FROM condition_lines"));
  assert.ok(cleanup);
  assert.ok(cleanup!.text.includes("NOT EXISTS (SELECT 1 FROM condition_events"));
  assert.ok(cleanup!.text.includes("NOT EXISTS (SELECT 1 FROM work_material_uses"));
  assert.deepEqual(cleanup!.params, [10, [1, 2]]);
});

test("Pg: work_id は 文書の作品 ＞ 素材の作品 の順で決まり、向きフラグ（in/out・is_inbound）も書く", async () => {
  // 文書は WRK-10013（作品ID 9）に紐づき、素材は別作品（55）＝跨ぎ原作。条件が属するのは文書の作品。
  const fake = fakeClient({ materialWorkId: 55, documentWorkCode: "WRK-10013", documentWorkId: 9 });
  await repositoryFor(fake).upsertDocumentConditions(10, buildDocumentConditionInputs({
    flow_direction: "in",
    financial_conditions: [
      { condition_no: 1, condition_name: "原作料率", rate_pct: 5, material_code: "MAT-001" },
      { condition_no: 2, condition_name: "一時金", unit_amount: 50000 }
    ]
  }));
  const inserts = fake.issued.filter((q) => q.text.includes("INSERT INTO condition_lines"));
  const cols = inserts[0].text.match(/INSERT INTO condition_lines \(([^)]+)\)/)![1].split(",").map((c) => c.trim());
  const rowOf = (issued: Issued) => Object.fromEntries(cols.map((c, i) => [c, issued.params[i]]));
  const withMaterial = rowOf(inserts[0]);
  assert.equal(withMaterial.work_id, 9);            // 文書の作品が優先
  assert.equal(withMaterial.source_work_id, 55);    // 出どころの作品は素材側
  assert.equal(withMaterial.flow_direction, "in");
  assert.equal(withMaterial.is_inbound, true);
  const withoutMaterial = rowOf(inserts[1]);
  assert.equal(withoutMaterial.work_id, 9);         // 素材が無くても文書の作品に付く
  // 作品を解決する問い合わせは文書ごとに1回（行ごとに繰り返さない）
  assert.equal(fake.issued.filter((q) => q.text.includes("FROM documents WHERE id")).length, 1);
});

test("Pg: 契約取込の連結参照（契約番号-作品コード）は末尾の作品コードで作品を解決する", async () => {
  const fake = fakeClient({ documentWorkRef: "LIC-LO-2026-0015-W-2026-0001", worksCode: "W-2026-0001", documentWorkId: 1000000017 });
  await repositoryFor(fake).upsertDocumentConditions(328, buildDocumentConditionInputs({
    v3_conds: [{ id: "1", name: "自社製造・自社販売", fixedRate: 5, mg: 0, ag: 0 }]
  }));
  const insert = fake.issued.find((q) => q.text.includes("INSERT INTO condition_lines"))!;
  const cols = insert.text.match(/INSERT INTO condition_lines \(([^)]+)\)/)![1].split(",").map((c) => c.trim());
  assert.equal(insert.params[cols.indexOf("work_id")], 1000000017);
  // 連結参照そのまま → 末尾コード の順に問い合わせる
  const lookups = fake.issued.filter((q) => q.text.includes("FROM works WHERE")).map((q) => q.params[0]);
  assert.deepEqual(lookups, ["LIC-LO-2026-0015-W-2026-0001", "W-2026-0001"]);
});

test("Pg: 文書に作品紐づけが無ければ素材の作品を work_id にし、アウト（out）は is_inbound=false", async () => {
  const fake = fakeClient({ materialWorkId: 55 });
  await repositoryFor(fake).upsertDocumentConditions(10, buildDocumentConditionInputs({
    flow_direction: "out",
    financial_conditions: [{ condition_no: 1, rate_pct: 8, material_code: "MAT-001" }]
  }));
  const insert = fake.issued.find((q) => q.text.includes("INSERT INTO condition_lines"))!;
  const cols = insert.text.match(/INSERT INTO condition_lines \(([^)]+)\)/)![1].split(",").map((c) => c.trim());
  const row = Object.fromEntries(cols.map((c, i) => [c, insert.params[i]]));
  assert.equal(row.work_id, 55);
  assert.equal(row.direction, "receivable");
  assert.equal(row.flow_direction, "out");
  assert.equal(row.is_inbound, false);
});

test("Pg: 既存 line_code は再利用し採番しない", async () => {
  const fake = fakeClient({ existingLineCodes: { "10:1": "CL-2025-00042" } });
  await repositoryFor(fake).upsertDocumentConditions(10, buildDocumentConditionInputs({
    financial_conditions: [{ condition_no: 1, rate_pct: 5 }]
  }));
  assert.equal(fake.issued.some((q) => q.text.includes("INSERT INTO document_sequences")), false);
  const insert = fake.issued.find((q) => q.text.includes("INSERT INTO condition_lines"))!;
  assert.ok(insert.params.includes("CL-2025-00042"));
});

test("Pg: moveConditions は document_id と互換ミラー capability_id を新版へ付け替える", async () => {
  const fake = fakeClient({});
  const moved = await repositoryFor(fake).moveConditions(10, 20);
  assert.equal(moved, 2);
  const update = fake.issued.find((q) => q.text.includes("UPDATE condition_lines"))!;
  assert.ok(update.text.includes("SET document_id = $2, capability_id = $2"));
  assert.deepEqual(update.params, [10, 20]);
});

test("Memory: 置換セマンティクス（実績あり行は削除しない）", async () => {
  const repository = new MemoryConditionSyncRepository();
  await repository.upsertDocumentConditions(1, buildDocumentConditionInputs({
    financial_conditions: [{ condition_no: 1, rate_pct: 5 }, { condition_no: 2, unit_amount: 100 }]
  }));
  repository.protectedLineNos.add("1:2");
  const result = await repository.upsertDocumentConditions(1, buildDocumentConditionInputs({
    financial_conditions: [{ condition_no: 1, rate_pct: 7 }]
  }));
  assert.equal(result.deleted, 0);                       // line_no 2 は実績ありで保全
  assert.equal(repository.documents.get(1)!.size, 2);
  assert.equal(repository.documents.get(1)!.get(1)!.rate_pct, 7);
});
