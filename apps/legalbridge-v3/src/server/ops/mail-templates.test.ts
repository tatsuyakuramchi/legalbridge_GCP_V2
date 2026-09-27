import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIL_TEMPLATES, deliveryKindOf, parseMailTemplates, readMailTemplates, renderMail
} from "./mail-templates.js";

test("既定の文面は差し込みの誤りが無い", () => {
  assert.deepEqual(parseMailTemplates(DEFAULT_MAIL_TEMPLATES).errors, []);
});

test("知らない差し込み・空の本文は保存しない", () => {
  const bad = structuredClone(DEFAULT_MAIL_TEMPLATES);
  bad.templates.inspection.body = "{取引先名} 御中";
  bad.templates.royalty.subject = " ";
  const { errors } = parseMailTemplates(bad);
  assert.ok(errors.some((e) => /検収書の送付の \{取引先名\} は差し込めません/.test(e)));
  assert.ok(errors.some((e) => /利用許諾計算書の送付の件名が空/.test(e)));
});

test("壊れた保存値でも既定値で埋めて読む", () => {
  const v = readMailTemplates({ templates: { inspection: { subject: "件名だけ" } } });
  assert.equal(v.templates.inspection.subject, "件名だけ");
  assert.equal(v.templates.inspection.body, DEFAULT_MAIL_TEMPLATES.templates.inspection.body);
  assert.equal(v.templates.owner_check.subject, DEFAULT_MAIL_TEMPLATES.templates.owner_check.subject);
});

test("送付の文面は文書の種類で選ぶ", () => {
  assert.equal(deliveryKindOf("inspection_certificate"), "inspection");
  assert.equal(deliveryKindOf("royalty_statement"), "royalty");
  assert.equal(deliveryKindOf("purchase_order"), "general");
  assert.equal(deliveryKindOf(null), "general");
});

test("差し込み、宛名が無ければ「様」だけの行を出さない", () => {
  const r = renderMail(DEFAULT_MAIL_TEMPLATES.templates.inspection, "（署名）", {
    相手先: "株式会社甲", 宛名: "", 文書番号: "ARC-IC-2026-1001", 金額: "¥110,000",
    発行日: "2026年9月27日", 会社名: "株式会社アークライト"
  });
  assert.equal(r.subject, "【株式会社アークライト】検収書のご送付（ARC-IC-2026-1001）");
  assert.match(r.body, /^株式会社甲 御中\n\nいつもお世話になっております。/);
  assert.match(r.body, /■ 検収金額：¥110,000/);
  assert.match(r.body, /（署名）$/);
  assert.doesNotMatch(r.body, /\{/);
});

test("いつも入れる cc はメールアドレスだけ。カンマ区切りの文字でも読む", () => {
  assert.deepEqual(parseMailTemplates({ partyCc: "keiri@example.com, keiri@example.com" }).value.partyCc, ["keiri@example.com"]);
  assert.ok(parseMailTemplates({ partyCc: ["経理"] }).errors.some((e) => /メールアドレスの形ではありません/.test(e)));
});
