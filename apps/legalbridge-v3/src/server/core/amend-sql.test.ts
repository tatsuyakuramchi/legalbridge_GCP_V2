import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// 生成器は素の JS（インフラ側の道具なので型は持たない）。
// @ts-expect-error 型宣言のない .mjs を読む
import { buildStudioSql } from "../../../../../infra/v3/tools/make-studio-sql.mjs";

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

test("A-009 は取引の中にある（確認の側に置かない）", () => {
  // 一度ここを間違えて、変更が COMMIT の外で走っていた。
  const changes = read("004_amend.sql").split("\nCOMMIT;\n")[0];
  for (const marker of ["A-008", "A-009"]) {
    assert.ok(changes.includes(marker), `${marker} が COMMIT より後にある`);
  }
});
