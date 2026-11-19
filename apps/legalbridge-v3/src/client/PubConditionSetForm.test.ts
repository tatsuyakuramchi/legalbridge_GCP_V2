import { test } from "node:test";
import assert from "node:assert/strict";
import { pubSetSummary } from "./PubConditionSetForm.js";

test("出版の条件の登録：いまの入力で作られる条件を、登録の前に言葉で出す", () => {
  // 何も入れていない。
  assert.equal(pubSetSummary({}).head, "登録される条件：まだありません");
  // 再許諾だけ（自社で出す分は空）。海外だけ。
  const sub = pubSetSummary({ transPrintRate: "50", transDigitalRate: "50", regions: "日本を除く全世界", languages: "英語" });
  assert.equal(sub.head, "登録される条件：再許諾（紙）50%・再許諾（電子）50%（2 本）");
  assert.equal(sub.detail, "自社で出す分（紙・電子）は空なので作りません。再許諾だけの条件になります。地域：日本を除く全世界／言語：英語");
  // 再許諾の種類を選ぶと、その呼び名で出る。
  assert.equal(pubSetSummary({ transPrintRate: "50", transKind: "translation" }).head, "登録される条件：翻訳版（紙）50%（1 本）");
  assert.equal(pubSetSummary({ transPrintRate: "50", transKind: "other" }).head, "登録される条件：再許諾（翻訳以外）（紙）50%（1 本）");
  // 紙・電子だけ。地域・言語を選ばなければ、その扱いを書く。
  const own = pubSetSummary({ printRate: "11", digitalRate: "15%" });
  assert.equal(own.head, "登録される条件：紙出版 11%・電子出版 15%（2 本）");
  assert.equal(own.detail, "再許諾する分は空なので作りません。地域：指定なし（全世界）／言語：指定なし（条件書には日本語と出ます）");
  // 両方あれば、作らない分の断りは出さない。
  assert.equal(pubSetSummary({ printRate: "11", transPrintRate: "50" }).detail,
    "地域：指定なし（全世界）／言語：指定なし（条件書には日本語と出ます）");
});
