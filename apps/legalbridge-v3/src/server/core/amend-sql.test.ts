import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// 生成器は素の JS（インフラ側の道具なので型は持たない）。
// @ts-expect-error 型宣言のない .mjs を読む（指示は指定子と同じ行の直前に置く）
import { buildStudioSql, sourceCheckCount, studioCheckCount } from "../../../../../infra/v3/tools/make-studio-sql.mjs";

/**
 * Cloud SQL Studio 用の 004_amend が、psql 用と食い違っていないかを見る。
 *
 * 同じ変更を2つのファイルに書くと、片方だけ直して本番に別のものを当てることに
 * なる。Studio 用は生成物なので、生成し直した結果と一致していれば足りる。
 */

const root = new URL("../../../../../infra/v3/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

test("Studio 用は 004_amend.sql から作った結果と一致する", () => {
  assert.equal(read("004_amend_studio.sql"), buildStudioSql(read("004_amend.sql")),
    "node infra/v3/tools/make-studio-sql.mjs で作り直してください");
});

test("Studio 用に psql のクライアント機能が残っていない", () => {
  // Studio は \set や \echo を解釈しない。1行でも残っていると全部が止まる。
  const lines = read("004_amend_studio.sql").split("\n");
  const meta = lines.filter((l) => l.startsWith("\\"));
  assert.deepEqual(meta, [], `psql の命令が残っている: ${meta.join(" / ")}`);
});

/**
 * 確認だけは生成できない。psql 版は1項目ずつ結果を出せるが、Studio は文ごとの
 * 結果のうちどれが見えるか分からないので、1本の表にまとめ直す必要がある。
 * つまり同じ確認を2つの書き方で持っている＝片方に足し忘れられる。
 *
 * 実際 A-012 の確認が Studio 版から落ちていた。生成物どうしを比べる
 * 「一致する」試験では、どちらも同じ古い CHECKS から作られるので気づけない。
 */
test("確認の項目数が psql 版と Studio 版で揃っている", () => {
  const inSource = sourceCheckCount(read("004_amend.sql"));
  assert.ok(inSource >= 13, `確認節が読めていない（${inSource} 項目）`);
  assert.equal(studioCheckCount(), inSource,
    "004_amend.sql に確認を足したら、make-studio-sql.mjs の CHECKS にも足すこと。"
    + "片方だけだと、Studio で流した人は確かめられないまま終わる");
});

test("A-009 は取引の中にある（確認の側に置かない）", () => {
  // 一度ここを間違えて、変更が COMMIT の外で走っていた。
  const changes = read("004_amend.sql").split("\nCOMMIT;\n")[0];
  for (const marker of ["A-008", "A-009"]) {
    assert.ok(changes.includes(marker), `${marker} が COMMIT より後にある`);
  }
});

/**
 * 採番記号の表は2か所にある。新規移行は 040 の v3_default_prefix()、
 * 移行済みのデータベースは 004 の A-005 が使う。片方だけ足すと、いつ移行したかで
 * 文書番号が変わる。実際に legal_freeform をここで取りこぼしていた。
 */
function prefixesOf(sql: string, pattern: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(pattern)) out.set(m[1], m[2]);
  return out;
}

test("採番記号の表が2か所で一致している", () => {
  const migration = prefixesOf(read("040_migrate_documents.sql"),
    /WHEN\s+'([a-z0-9_]+)'\s+THEN\s+'([A-Z0-9-]+)'/g);
  const amend = prefixesOf(read("004_amend.sql"),
    /\('([a-z0-9_]+)',\s*'([A-Z0-9-]+)'\)/g);

  assert.ok(migration.size >= 20, `040 の表が読めていない（${migration.size} 件）`);
  const diff: string[] = [];
  for (const [key, prefix] of migration) {
    if (amend.get(key) !== prefix) diff.push(`${key}: 040=${prefix} / 004=${amend.get(key) ?? "無い"}`);
  }
  for (const [key, prefix] of amend) {
    if (!migration.has(key)) diff.push(`${key}: 004=${prefix} / 040=無い`);
  }
  assert.deepEqual(diff, [], `採番記号が食い違っている: ${diff.join(" ／ ")}`);
});

test("汎用法務文書に採番記号がある（V1 では持っていなかった）", () => {
  const amend = prefixesOf(read("004_amend.sql"), /\('([a-z0-9_]+)',\s*'([A-Z0-9-]+)'\)/g);
  assert.equal(amend.get("legal_freeform"), "LG",
    "採番記号が無いと、そのひな形は発行しようとするたびに失敗する");
});
