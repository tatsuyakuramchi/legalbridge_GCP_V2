import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Cloud SQL Studio から本番の中身を取り出す SQL（094）と、それを取り込む側
 * （ops.sh の import-rows）が食い違っていないかを見る。
 *
 * 表の一覧を書かずに全部の表から取るために XML を経由しているが、
 * xpath(...)::text は XML の記号を元に戻さない。ひな形の本文の <h1> が
 * &lt;h1&gt; のまま入り、次に出すと &amp;lt; と二重に化ける。
 * 実際にこれで壊れたので、書き方を試験で縛る。
 */

const root = new URL("../../../../../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

const exportSql = () => read("infra/v3/094_export_rows.sql");
const ops = () => read("infra/local/bin/ops.sh");

test("取り出しは xmltable を使う", () => {
  assert.match(exportSql(), /xmltable\(/,
    "xmltable でないと XML の記号が元に戻らない");
});

test("xpath の結果を text にする書き方が残っていない", () => {
  const broken = exportSql().match(/xpath\([^;]*?\)\s*\)?\s*\[\d+\]::text/g) ?? [];
  assert.deepEqual(broken, [],
    `記号が二重に化ける書き方が残っている: ${broken.join(" / ")}`);
});

test("取り出しは読むだけ（書き換える文が無い）", () => {
  const writes = exportSql().match(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/gim) ?? [];
  assert.deepEqual(writes, [], `本番を書き換える文がある: ${writes.join(" / ")}`);
});

test("出す列と受ける列が揃っている", () => {
  // 094 は tbl と data の2列を出す。取り込み側の受け皿も同じ2列。
  assert.match(exportSql(), /SELECT\s+tbl,\s*data/,
    "094 が tbl, data の順で出していない");
  assert.match(ops(), /CREATE TEMP TABLE staging \(tbl text, data jsonb\)/,
    "ops.sh の受け皿が tbl, data になっていない");
});

test("取り込みは手元に無い列を黙って捨てない", () => {
  // 本番に列が増えたとき、JSON の鍵は落ちて値が消える。止めないと気づけない。
  assert.match(ops(), /手元の定義に無い列があります/,
    "取り込み側に列の食い違いを止める仕掛けが無い");
  assert.match(ops(), /参照先の無い行があります/,
    "取り込み側に参照の欠けを止める仕掛けが無い");
});

test("ページを分けても取りこぼさない並び順になっている", () => {
  // OFFSET でページを分けるので、全体で決まった並びが要る。
  assert.match(exportSql(), /ORDER BY tbl, data\s*\n\s*OFFSET/,
    "並び順が決まっていないとページの境目で取りこぼす");
});
