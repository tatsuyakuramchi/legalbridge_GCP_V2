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

/**
 * 利用許諾条件の更新（条件番号か、作品＋取引モデルで当てて、書いてある列だけ直す）。
 */
const condDb = (hits: Array<Record<string, unknown>> = [{ id: 31, condition_no: "CL-1", name: "ito｜紙出版", status: "active" }]) =>
  new FakeDatabase((text, params) => {
    if (text.includes("WHERE lower(btrim(condition_no))")) {
      return String(params?.[0]) === "CL-1" ? hits : [];
    }
    if (text.includes("FROM works\n          WHERE")) return [{ id: 9, title: "ito" }];
    if (text.includes("WHERE c.work_id = $1 AND c.usage_type = $2")) return hits;
    if (text.includes("FROM condition_scopes WHERE condition_id")) {
      return [{ scope_type: "media", label: "紙", code: "print" },
              { scope_type: "region", label: "日本", code: "JP" }];
    }
    // 更新側（ConditionWriteService）
    if (text.includes("FROM conditions") && text.includes("FOR UPDATE")) {
      return [{ id: 31, status: "active", condition_no: "CL-1", name: "ito｜紙出版" }];
    }
    if (text.includes("UPDATE conditions SET")) return [{ id: 31 }];
    if (text.includes("DELETE FROM condition_scopes")) return [];
    if (text.includes("INSERT INTO condition_scopes")) return [{ id: 1 }];
    if (text.includes("SELECT current_date")) return [{ today: "2026-09-19" }];
    // 実績が付いていれば版を分ける判断（ここでは付いていない＝その場で直す）
    if (text.includes("FROM condition_events WHERE condition_id")) return [{ n: 0 }];
    if (text.includes("FROM document_conditions WHERE condition_id")) {
      return [{ documents: 0, payments: 0, matters: 0, children: 0 }];
    }
    return undefined;
  });

test("条件の更新：条件番号で当て、料率だけを直す（％→ppm）", async () => {
  const db = condDb();
  const r = await new ImportService(db).run({
    kind: "license_conditions", csv: "条件番号,料率,備考\nCL-1,12.5,", dryRun: false, actor: "k", mode: "update" });
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  const q = db.find("UPDATE conditions SET")!;
  assert.match(q.text, /rate_ppm = \$2/);
  assert.equal(q.params[1], 125000);
  assert.doesNotMatch(q.text, /notes/, "空欄の備考は触らない");
});

test("条件の更新：既存の範囲を読む SQL は condition_scopes の実際の列だけを使う", async () => {
  // condition_scopes に id 列は無い。ORDER BY id と書くと、地域・言語を当てる
  // 行だけが「column id does not exist」で落ちる（書き出した CSV をそのまま
  // 取り込むと必ず通る道）。
  const db = condDb();
  await new ImportService(db).run({
    kind: "license_conditions", csv: "条件番号,地域\nCL-1,全世界", dryRun: false, actor: "k", mode: "update" });
  const q = db.find("FROM condition_scopes WHERE condition_id")!;
  assert.doesNotMatch(q.text, /\bid\b/, `実在しない列を使っている: ${q.text}`);
});

test("条件の更新：地域を当てても媒体（紙・電子）は残す", async () => {
  const db = condDb();
  await new ImportService(db).run({
    kind: "license_conditions", csv: "条件番号,地域\nCL-1,全世界", dryRun: false, actor: "k", mode: "update" });
  const inserts = db.all("INSERT INTO condition_scopes");
  const types = inserts.map((q) => String(q.params[1]));
  assert.ok(types.includes("media"), "媒体は残す");
  assert.ok(types.includes("region"), "地域は入れ替える");
  assert.equal(types.filter((t) => t === "region").length, 1, "古い地域は消える");
});

test("条件の更新：作品＋取引モデルでも当たる。当たらない・複数は止める", async () => {
  const db = condDb();
  const r = await new ImportService(db).run({
    kind: "license_conditions", csv: "作品名,取引モデル,料率\nito,紙出版,11", dryRun: true, actor: "k", mode: "update" });
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.equal(db.find("UPDATE conditions SET"), undefined, "試算では書かない");

  const many = await new ImportService(condDb([
    { id: 31, condition_no: "CL-1", name: "ito｜再許諾（A）", status: "active" },
    { id: 32, condition_no: "CL-2", name: "ito｜再許諾（B）", status: "active" }
  ])).run({ kind: "license_conditions", csv: "作品名,取引モデル,料率\nito,再許諾,50", dryRun: true, actor: "k", mode: "update" });
  assert.equal(many.error, 1);
  assert.match(many.rows[0].message ?? "", /複数あります/);
});

test("条件の更新：無効・旧版は止める。当てる手がかりの見出しが無ければ受け付けない", async () => {
  const voided = condDb([{ id: 31, condition_no: "CL-1", name: "ito｜紙出版", status: "void" }]);
  const r = await new ImportService(voided).run({
    kind: "license_conditions", csv: "条件番号,料率\nCL-1,11", dryRun: true, actor: "k", mode: "update" });
  assert.match(r.rows[0].message ?? "", /無効化/);

  await assert.rejects(() => new ImportService(condDb()).run({
    kind: "license_conditions", csv: "料率\n11", dryRun: true, actor: "k", mode: "update" }), /条件番号/);
});

/**
 * 翻訳版再許諾（A-033）。取引モデルの選択肢に紙・電子の翻訳版が増え、
 * 「別途合意」の列で再許諾ごとの合意の要否を入れられる。
 */
test("登録：翻訳版再許諾（紙・電子）を取り込み、別途合意の要否も入る", async () => {
  const db = build();
  const csv = [
    "作品名,許諾者,取引モデル,料率,別途合意",
    "ito,権利者名,翻訳版再許諾（紙）,50,要",
    "ito,権利者名,翻訳版再許諾（電子）,40,不要"
  ].join("\n");
  const r = await new ImportService(db).run({ kind: "license_conditions", csv, dryRun: false, actor: "k" });
  assert.equal(r.ok, 2, JSON.stringify(r.rows));
  // 再許諾先が決まっていなくても作れる（相手は後から決まる）。
  assert.match(r.rows[0].message ?? "", /ito｜翻訳版再許諾（紙）/);
  const inserts = db.all("INSERT INTO conditions");
  assert.equal(inserts.length, 2);
  const usage = inserts.map((q) => q.params.find((p) => String(p).startsWith("pub_sub")));
  assert.deepEqual(usage, ["pub_sub_print", "pub_sub_digital"]);
  assert.ok(inserts[0].params.includes("required"), "紙は「要」");
  assert.ok(inserts[1].params.includes("covered"), "電子は「不要」");
});

test("登録：別途合意は翻訳版再許諾だけの列。読めない値は行ごとに止める", async () => {
  const db = build();
  const csv = [
    "作品名,許諾者,取引モデル,料率,別途合意",
    "ito,権利者名,紙出版,11,",
    "ito,権利者名,翻訳版再許諾（紙）,50,たぶん要る"
  ].join("\n");
  const r = await new ImportService(db).run({ kind: "license_conditions", csv, dryRun: true, actor: "k" });
  assert.equal(r.ok, 1);
  assert.equal(r.error, 1);
  assert.match(r.rows[1].message ?? "", /別途合意は「要」か「不要」です/);
});

test("条件の更新：別途合意だけを直せる", async () => {
  const db = condDb();
  const r = await new ImportService(db).run({
    kind: "license_conditions", csv: "条件番号,別途合意\nCL-1,不要", dryRun: false, actor: "k", mode: "update" });
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  const q = db.find("UPDATE conditions SET")!;
  assert.match(q.text, /sublicense_consent = \$2/);
  assert.equal(q.params[1], "covered");
});

/**
 * 許諾期間の自動更新（A-039）。期間は束ごとなので、CSV も束の列として受ける。
 */
test("登録：自動更新と更新の単位を取り込む（「1年」「6か月」）", async () => {
  const db = build();
  const csv = [
    "作品名,許諾者,取引モデル,料率,開始日,終了日,自動更新,更新の単位",
    "ito,権利者名,自社製造・自社販売,2,2026-10-01,2031-09-30,する,1年"
  ].join("\n");
  const r = await new ImportService(db).run({ kind: "license_conditions", csv, dryRun: false, actor: "k" });
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  const q = db.find("INSERT INTO conditions")!;
  assert.ok(q.params.includes(true), "自動更新する");
  assert.ok(q.params.includes(12), "1年 = 12か月");
});

test("登録：読めない自動更新・単位は行ごとに止める", async () => {
  const db = build();
  const csv = [
    "作品名,許諾者,取引モデル,料率,開始日,終了日,自動更新,更新の単位",
    "ito,権利者名,紙出版,11,2026-10-01,2031-09-30,たぶんする,",
    "ito,権利者名,電子出版,15,2026-10-01,2031-09-30,する,ときどき"
  ].join("\n");
  const r = await new ImportService(db).run({ kind: "license_conditions", csv, dryRun: true, actor: "k" });
  assert.equal(r.error, 2);
  assert.match(r.rows[0].message ?? "", /自動更新は「する」か「しない」です/);
  assert.match(r.rows[1].message ?? "", /更新の単位は「1年」「6か月」のように/);
});

test("条件の更新：自動更新と止めた日を直せる", async () => {
  const db = condDb();
  const r = await new ImportService(db).run({
    kind: "license_conditions", csv: "条件番号,自動更新,更新の単位,更新停止日\nCL-1,する,6か月,2030-04-01",
    dryRun: false, actor: "k", mode: "update" });
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  const q = db.find("UPDATE conditions SET")!;
  assert.match(q.text, /auto_renew = \$\d/);
  assert.match(q.text, /renew_months = \$\d/);
  assert.match(q.text, /renew_stopped_on = \$\d/);
  assert.ok(q.params.includes(6), "6か月");
});
