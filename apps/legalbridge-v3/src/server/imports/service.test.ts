import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ImportService } from "./service.js";

/**
 * 利用許諾条件の CSV 取込。作品・許諾者は登録済みのものに当て、条件名は
 * 作品名｜取引モデル で付ける。同じ作品・許諾者・契約・期間の行は1束にして
 * 許諾セットで作る。
 */
const CSV = [
  "作品名,許諾者,契約番号,取引モデル,料率,独占,MG,再許諾先,目的,開始日,終了日,通貨,地域",
  "ito,権利者名,AGR-1,自社製造・自社販売,2,非独占,100000,,,2026-10-01,2031-09-30,JPY,全世界",
  "ito,権利者名,AGR-1,再許諾,50,,,Alpha Games,英語版の製造販売,2026-10-01,2031-09-30,JPY,全世界",
  "ito,権利者名,AGR-1,再許諾,50,,,,,2026-10-01,2031-09-30,JPY,",
  "しらない作品,権利者名,,紙出版,11,,,,,,,,",
  "ito,権利者名,,配信,10,,,,,,,,"
].join("\n");

const build = (existing: Array<Record<string, unknown>> = []) => {
  let next = 200;
  return new FakeDatabase((text, params) => {
    if (text.includes("FROM works\n        WHERE")) {
      return String(params?.[1] ?? "") === "ito" ? [{ id: 9, title: "ito" }] : [];
    }
    if (text.includes("FROM parties\n        WHERE status <> 'merged'")) return [{ id: 5, name: "権利者名" }];
    if (text.includes("FROM agreements WHERE lower(btrim(agreement_no))")) return [{ id: 3, cp: 5 }];
    if (text.includes("c.status IN ('active', 'scheduled')")) return existing;
    // 登録側（createLicenseSet）が使うもの
    if (text.includes("FROM parties WHERE id")) return [{ id: 5, name: "権利者名" }];
    if (text.includes("SELECT title FROM works WHERE id")) return [{ id: 9, title: "ito" }];
    if (text.includes("FROM works WHERE id")) return [{ id: 9, title: "ito" }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: next }];
    if (text.includes("FROM conditions WHERE condition_no")) return [];
    if (text.includes("INSERT INTO conditions")) { next += 1; return [{ id: next, condition_no: `CL-2026-00${next}` }]; }
    return undefined;
  });
};

test("試算：当たった行は条件名を返し、再許諾先なし・作品なし・知らない取引モデルは行ごとに弾く。何も書かない", async () => {
  const db = build();
  const r = await new ImportService(db).run({ kind: "license_conditions", csv: CSV, dryRun: true, actor: "k" });
  assert.equal(r.total, 5);
  assert.equal(r.ok, 2);
  assert.equal(r.error, 3);
  const byLine = new Map(r.rows.map((x) => [x.line, x]));
  assert.match(byLine.get(2)!.message ?? "", /ito｜自社製造・自社販売/);
  assert.match(byLine.get(3)!.message ?? "", /ito｜再許諾（Alpha Games／英語版の製造販売）/);
  assert.match(byLine.get(4)!.message ?? "", /再許諾先/);
  assert.match(byLine.get(5)!.message ?? "", /見つかりません/);
  assert.match(byLine.get(6)!.message ?? "", /取引モデルは/);
  assert.equal(db.find("INSERT INTO conditions"), undefined);
});

test("登録：同じ作品・許諾者・契約・期間の行は1束で許諾セットに入る。名前は規則どおり", async () => {
  const db = build();
  const r = await new ImportService(db).run({ kind: "license_conditions", csv: CSV, dryRun: false, actor: "k" });
  assert.equal(r.ok, 2);
  const inserts = db.queries.filter((q) => q.text.includes("INSERT INTO conditions"));
  assert.deepEqual(inserts.map((q) => q.params[4]), ["ito｜自社製造・自社販売", "ito｜再許諾（Alpha Games／英語版の製造販売）"]);
  assert.deepEqual(r.rows.filter((x) => x.status === "ok").map((x) => x.code), ["CL-2026-00201", "CL-2026-00202"]);
});

test("試算：同じ取引モデルの生きた条件が既にあれば重複として出す", async () => {
  const db = build([{ condition_no: "CL-1", usage_type: "in_house", name: "ito｜自社製造・自社販売" }]);
  const r = await new ImportService(db).run({ kind: "license_conditions", csv: CSV, dryRun: true, actor: "k" });
  const row2 = r.rows.find((x) => x.line === 2)!;
  assert.equal(row2.status, "duplicate");
  assert.match(row2.message ?? "", /CL-1/);
});

test("作品 CSV：親作品を書くと原作にぶら下がる。当たらなければ止める", async () => {
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM works\n          WHERE lower(btrim(work_code))")) {
      return String(params?.[0]) === "原作小説" ? [{ id: 4 }] : [];
    }
    if (text.includes("FROM works WHERE btrim(title)")) return [];
    if (text.includes("SELECT id FROM works WHERE id")) return [{ id: 4 }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: 7 }];
    if (text.includes("INSERT INTO works")) return [{ id: 10, work_code: "WRK-7" }];
    // 著作権表示は履歴（A-031）の初版の行にも入る。
    if (text.includes("INSERT INTO work_credits")) return [{ id: 1 }];
    return undefined;
  });
  const csv = "作品名,種別,親作品,著作権表示\n新作ゲーム,,原作小説,© 2026 著者\n別のゲーム,,無い原作,";
  const r = await new ImportService(db).run({ kind: "works", csv, dryRun: false, actor: "k" });
  assert.equal(r.ok, 1);
  assert.equal(r.error, 1);
  const ins = db.find("INSERT INTO works")!;
  assert.equal(ins.params[3], "derivative", "親があれば派生作品");
  assert.equal(ins.params[7], "© 2026 著者");
  assert.ok(db.find("INSERT INTO work_lineage"));
  const credit = db.find("INSERT INTO work_credits")!;
  assert.equal(credit.params[2], "初版");
  assert.equal(credit.params[3], "© 2026 著者");
  assert.match(r.rows[1].message ?? "", /親作品「無い原作」が見つかりません/);
});

/**
 * 作品 CSV の更新（既に登録してある作品に、書いてある列だけを当てる）。
 * 備考だけをまとめて入れたい、という用がこれ。
 */
const updateDb = (hits: Array<Record<string, unknown>> = [{ id: 4, work_code: "WRK-1", title: "既存作品" }]) =>
  new FakeDatabase((text, params) => {
    if (text.includes("WHERE lower(btrim(work_code))")) {
      return String(params?.[0]) === "WRK-1" ? hits : [];
    }
    if (text.includes("WHERE btrim(title) = btrim($1) LIMIT 2")) {
      return String(params?.[0]) === "既存作品" ? hits : [];
    }
    // 更新側（WorkWriteService.update）が使うもの
    if (text.includes("merged_into_id FROM works")) return [{ id: 4, work_code: "WRK-1", title: "既存作品", status: "planning", merged_into_id: null }];
    if (text.includes("SELECT id FROM works WHERE id")) return [{ id: 4 }];
    if (text.includes("UPDATE works SET")) return [{ id: 4 }];
    return undefined;
  });

test("更新：作品コードで当て、書いてある列だけを直す。空欄の列は触らない", async () => {
  const db = updateDb();
  const csv = "作品コード,備考,カナ\nWRK-1,初版1000部,";
  const r = await new ImportService(db).run({ kind: "works", csv, dryRun: false, actor: "k", mode: "update" });
  assert.equal(r.mode, "update");
  assert.equal(r.ok, 1);
  const q = db.find("UPDATE works SET")!;
  assert.match(q.text, /remarks = \$2/);
  assert.doesNotMatch(q.text, /title_kana/, "空欄のカナは触らない");
  assert.equal(q.params[1], "初版1000部");
  assert.match(r.rows[0].message ?? "", /備考 を更新しました/);
});

test("更新：当てる列が全部空なら何もしない（変更なしとして数える）", async () => {
  const db = updateDb();
  const r = await new ImportService(db).run({
    kind: "works", csv: "作品コード,備考\nWRK-1,", dryRun: false, actor: "k", mode: "update" });
  assert.equal(r.skipped, 1);
  assert.equal(r.ok, 0);
  assert.equal(db.find("UPDATE works SET"), undefined);
});

test("更新：当たらない・複数当たる行は止める。試算では書かない", async () => {
  const none = await new ImportService(updateDb()).run({
    kind: "works", csv: "作品コード,備考\nWRK-9,あ", dryRun: true, actor: "k", mode: "update" });
  assert.equal(none.error, 1);
  assert.match(none.rows[0].message ?? "", /見つかりません/);

  const many = await new ImportService(updateDb([{ id: 4, work_code: "WRK-1", title: "既存作品" },
                                                 { id: 5, work_code: "WRK-2", title: "既存作品" }]))
    .run({ kind: "works", csv: "作品名,備考\n既存作品,あ", dryRun: true, actor: "k", mode: "update" });
  assert.equal(many.error, 1);
  assert.match(many.rows[0].message ?? "", /複数あります/);

  const db = updateDb();
  const dry = await new ImportService(db).run({
    kind: "works", csv: "作品コード,備考\nWRK-1,あ", dryRun: true, actor: "k", mode: "update" });
  assert.equal(dry.ok, 1);
  assert.equal(db.find("UPDATE works SET"), undefined, "試算では書かない");
});

test("更新：当てる手がかりの見出しが無ければ受け付けない。取引先は更新できない", async () => {
  const svc = new ImportService(updateDb());
  await assert.rejects(() => svc.run({ kind: "works", csv: "備考\nあ", dryRun: true, actor: "k", mode: "update" }),
    /作品コード.*作品名/);
  await assert.rejects(() => svc.run({ kind: "parties", csv: "名称\n甲", dryRun: true, actor: "k", mode: "update" }),
    /できません/);
});
