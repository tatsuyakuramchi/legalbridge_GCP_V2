import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIL_TEMPLATES, deliveryKindOf, parseMailTemplates, readMailTemplates, renderMail, mailPurposeOptions, resolveMailTemplate } from "./mail-templates.js";

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

test("契約書の統一のご案内：相手先を差し込み、2 週間以内の返信をお願いする", () => {
  const r = renderMail(DEFAULT_MAIL_TEMPLATES.templates.contract_unify, "（署名）", {
    相手先: "作家甲", 会社名: "株式会社アークライト"
  });
  assert.equal(r.subject, "【株式会社アークライト】利用許諾契約書（統一書式）のご確認のお願い");
  assert.match(r.body, /^作家甲 様\n/);
  assert.match(r.body, /作家甲様とのお取引について/);
  assert.match(r.body, /本メールの受信から2週間以内に/);
  assert.match(r.body, /（署名）$/);
});

test("足した文面：鍵・名前・差込を確かめる。既定で「計算書の送付＋契約書のお取り交わし」と「契約未締結の締結案内」が入る", () => {
  const d = readMailTemplates(undefined);
  assert.deepEqual(d.custom.map((c) => c.key), ["royalty_contract_notice", "unsigned_reminder"]);
  assert.match(d.custom[0]!.body, /\{対象期間\}分の利用許諾料計算書/);
  const options = mailPurposeOptions(d);
  assert.ok(options.some((o) => o.value === "custom:royalty_contract_notice" && o.audience === "party"));
  const bad = parseMailTemplates({ custom: [{ key: "Bad Key", label: "", subject: "", body: "{無い項目}" }] });
  assert.match(bad.errors.join("/"), /鍵は英小文字/);
  assert.match(bad.errors.join("/"), /名前が空/);
  assert.match(bad.errors.join("/"), /差し込めません/);
  const ok = parseMailTemplates({ custom: [{ key: "x1", label: "案内", subject: "件名 {案内URL}", body: "本文 {担当者名}", audience: "owner" }], guideUrl: "https://a" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.custom[0]!.audience, "owner");
  assert.equal(ok.value.guideUrl, "https://a");
  const r = resolveMailTemplate(ok.value, "custom:x1", null);
  assert.equal(r?.kind, "custom:x1"); assert.equal(r?.audience, "owner");
  assert.equal(resolveMailTemplate(ok.value, "custom:nope", null), null);
  assert.equal(resolveMailTemplate(ok.value, "delivery", "royalty_statement_pub")?.kind, "royalty");
});
