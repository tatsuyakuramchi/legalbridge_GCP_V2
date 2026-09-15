import test from "node:test";
import assert from "node:assert/strict";
import { COMPANY_PROFILE_FIELDS } from "./company-profile.js";
import { parseCompanyProfile } from "./company-profile-schema.js";
import { resolveAllLegacyVariables } from "../documents/legacy-variables.js";

test("未入力の項目は空文字で埋める（キーごと落とさない）", () => {
  const p = parseCompanyProfile({ name: "株式会社アークライト" });
  assert.equal(p.name, "株式会社アークライト");
  assert.equal(p.tel, "", "空と決めたのか未移行なのかを、読む側が区別できるように残す");
  assert.equal(Object.keys(p).length, COMPANY_PROFILE_FIELDS.length);
});

test("前後の空白は落とす", () => {
  assert.equal(parseCompanyProfile({ tel: "  03-1234-5678 " }).tel, "03-1234-5678");
});

test("知らないキーは弾く", () => {
  // 打ち間違いが黙って入ると、設定画面では入ったように見えるのに書類には出ない。
  assert.throws(() => parseCompanyProfile({ COMPANY_TEL: "03-1234-5678" }));
});

test("自社情報の全項目が書類の変数として引ける", () => {
  // 設定に入れられるのに書類側に別名が無い項目があると、入れた人からは
  // 「入れたのに出ない」としか見えない。実際 4 項目がその状態だった。
  const filled = Object.fromEntries(
    COMPANY_PROFILE_FIELDS.map((f) => [f.name, `<${f.name}>`]));
  const resolved = resolveAllLegacyVariables({ company: filled });
  const values = new Set(Object.values(resolved).map(String));

  const missing = COMPANY_PROFILE_FIELDS
    .filter((f) => !values.has(`<${f.name}>`))
    .map((f) => f.name);
  assert.deepEqual(missing, [],
    `設定できるのに書類へ出ない項目: ${missing.join("・")}`);
});
