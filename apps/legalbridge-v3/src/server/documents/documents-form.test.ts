import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 文書作成フォームの不変条件。
 *
 * 一度これを壊して、日本語が打てない画面を出した。入力欄が作り直されると
 * 変換中の文字が勝手に確定し、埋めた項目は missing から消えて欄ごと消える。
 * 型では防げないので、書き方そのものを見る。
 */
const source = readFileSync(new URL("../../client/DocumentsWorkspace.tsx", import.meta.url), "utf8");

/** useEffect(...) の本体を、依存配列の中身つきで取り出す。 */
function effects(text: string): Array<{ body: string; deps: string }> {
  const out: Array<{ body: string; deps: string }> = [];
  const start = /useEffect\(\(\) => \{/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
    }
    const body = text.slice(m.index + m[0].length, i - 1);
    const tail = text.slice(i, text.indexOf(");", i) + 2);
    out.push({ body, deps: tail });
  }
  return out;
}

test("項目の一覧は手入力を空にして取る（埋めた欄が消えないように）", () => {
  const specEffect = effects(source).find((e) => /setSpec\(/.test(e.body));
  assert.ok(specEffect, "spec を立てる useEffect が見つからない");
  assert.match(specEffect.body, /manualInputs: \{\}/,
    "手入力を送ると、埋まった項目が missing から消えて入力欄ごと消える");
});

test("項目の一覧は手入力では取り直さない（変換中に確定させないため）", () => {
  const specEffect = effects(source).find((e) => /setSpec\(/.test(e.body));
  assert.ok(specEffect, "spec を立てる useEffect が見つからない");
  assert.doesNotMatch(specEffect.deps, /manual/,
    "手入力を依存に入れると、打つたびに入力欄が作り直されて日本語が打てない");
});

test("入力欄を出す条件は取り直しの途中で false にならない", () => {
  // setSpec(null) は「ひな形が無い」ときだけ。取り直しの前に消すと、
  // 入っている欄が一度消えて作り直される。
  const nulls = [...source.matchAll(/setSpec\(null\)/g)];
  assert.equal(nulls.length, 1, "spec を消してよいのはひな形が無いときだけ");
  const line = source.slice(0, nulls[0].index).split("\n").pop() ?? "";
  assert.match(line, /!templateKey/, "spec を消すのはひな形が無いときに限る");
});

test("プレビュー本文は入力欄と別に持つ", () => {
  assert.match(source, /srcDoc=\{rendered\.html\}/,
    "本文を spec から出すと、本文の取り直しが入力欄を巻き込む");
});
