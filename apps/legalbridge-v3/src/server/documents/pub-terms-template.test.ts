import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { blankPlaceholders } from "./preflight.js";
import { PUB_TERMS_VARIABLES, pubTermsPatch, pubTitleSeeds } from "./pub-terms.js";
import { bankInfoLine } from "./template-context.js";

/**
 * ひな形の本文は infra/v3/113 の SQL が運ぶ（本番に流すのはその SQL）。
 * ここは同じ SQL から本文を取り出して描画し、本文が差す名前と計算ブロックが
 * 出す名前がずれていないかを見張る。片方だけ直すと空欄の紙が出る。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.resolve(here, "../../../../../infra/v3/113_pub_license_terms_v3.sql"), "utf8");
const html = (() => {
  const start = sql.indexOf("$html$") + "$html$".length;
  const end = sql.indexOf("$html$", start);
  assert.ok(start > 5 && end > start, "SQL に $html$ … $html$ の本文がある");
  return sql.slice(start, end);
})();

const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  exclusivity: "non_exclusive", exclusivityLabel: "非独占", notes: null, counterpartyId: 5,
  termStart: "2026-10-01", termEnd: "2031-09-30",
  scopes: { region: ["全世界"], language: ["日本語"], media: [] as string[] }, ...over
});
const context: Record<string, any> = {
  document: { number: "ARC-PUBT-2026-0041", issuedOn: "2026-10-01" },
  company: { name: "株式会社サンプル出版", address: "東京都文京区本郷", rep: "代表取締役 乙山 乙子", invoiceNo: "T9876543210987" },
  agreement: { no: "ARC-PUBM-2025-0003", title: "出版等利用許諾基本契約書", autoRenewal: true, renewalNoticeMonths: 1 },
  contacts: [{ role: "primary", name: "甲野 甲太", email: "kono@example.test", phone: "03-0000-0000", department: null }],
  owner: { name: "編集 花子", email: "hanako@example.test", phone: "03-1111-1111", department: "編集部" },
  bank: { bankName: "〇〇銀行", branchName: "本店", accountType: "ordinary", accountNumber: "0000000", holderKana: "コウノ コウタ" },
  conditions: [
    cond({ id: 1, conditionNo: "CL-2026-00451", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 11, notes: "初版100部（見本・献本除く）", scopes: { region: ["全世界"], language: ["日本語"], media: ["紙"] } }),
    cond({ id: 2, conditionNo: "CL-2026-00452", name: "星降る夜のはなし（単行本）", workId: 10,
      work: { title: "星降る夜のはなし" }, ratePct: 15, scopes: { region: ["全世界"], language: ["日本語"], media: ["電子"] } }),
    cond({ id: 3, conditionNo: "CL-2026-00453", name: "ねこの図書館 ①", workId: 11,
      work: { title: "ねこの図書館" }, ratePct: 10, exclusivity: "exclusive", exclusivityLabel: "独占", scopes: { region: [], language: [], media: ["紙"] } })
  ]
};
context.condition = { ...context.conditions[0],
  counterparty: { name: "甲野 甲太", kind: "individual", address: "東京都千代田区", invoiceNo: null, withholding: true } };

function render(manual: Record<string, unknown>) {
  const patch = pubTermsPatch(context, manual);
  const values = { taxRate: 10, BANK_INFO: bankInfoLine(context.bank), ...patch };
  return { out: renderDocumentHtml(html, values), values };
}

test("本文が差す名前はすべて計算ブロックから出る（空欄で出る差し込みが無い）", () => {
  const rows = pubTitleSeeds(context);
  rows[0] = { ...rows[0], copyright: "© 2026 甲野 甲太", third_party: "なし" };
  const { out, values } = render({ pub_titles: rows, "翻訳版取り分": "50", "特記事項": "電子署名で締結する。" });
  const blanks = blankPlaceholders(html, values, PUB_TERMS_VARIABLES.map((v) => v.name));
  // 行の中の名前（no / title …）は each の文脈なので、外側の値には無くてよい。
  const rowNames = new Set(["no", "title", "edition", "copyright", "thirdParty", "printRate", "printExclusivity",
    "digitalRate", "digitalExclusivity", "note", "hasPrint", "hasDigital"]);
  const outside = blanks.filter((name) => !rowNames.has(name));
  assert.deepEqual(outside, [], `空欄で出る差し込み: ${outside.join(", ")}`);
  assert.ok(!out.includes("{{"), "差し込みが残っていない");
  assert.ok(out.includes("size: A4 landscape"), "A4 横");
  assert.ok(out.includes("2026年10月1日"), "締結日は和暦風の表記");
  assert.ok(out.includes("11%／非独占"), "紙の料率と独占区分");
  assert.ok(out.includes("15%／非独占"), "電子の料率と独占区分");
  assert.ok(out.includes("<td class=\"c\">—</td>"), "電子の無い作品は「—」だけ");
  assert.ok(out.includes("10%／独占"));
  assert.ok(out.includes("© 2026 甲野 甲太"));
  assert.ok(out.includes("初版100部（見本・献本除く）"));
  assert.ok(out.includes("対価（税抜）の 50%"), "翻訳版の行");
  assert.ok(out.includes("〇〇銀行 / 本店 / 普通 0000000 / コウノ コウタ"), "振込先は取引先の口座");
  assert.ok(out.includes("源泉徴収し"), "個人の許諾者は源泉あり");
  assert.ok(out.includes("甲野 甲太 ／ kono@example.test ／ 03-0000-0000"));
  assert.ok(out.includes("編集部 ／ 編集 花子"));
  assert.ok(out.includes("1か月前までに"), "合意の更新通知が入る");
  assert.ok(out.includes("第１０条"), "特記事項あり");
});

test("翻訳版なし・署名欄なし・法人の許諾者・期間の定めなし", () => {
  const corp = { ...context, condition: { ...context.condition,
    counterparty: { name: "株式会社甲", kind: "corporate", withholding: false } },
    conditions: context.conditions.map((c: any) => ({ ...c, termEnd: null })) };
  const patch = pubTermsPatch(corp, { "署名欄": "表示しない", "特記事項": "" });
  const out = renderDocumentHtml(html, { taxRate: 10, BANK_INFO: "", ...patch });
  assert.ok(!out.includes("翻訳版"), "翻訳版の行が無い");
  assert.ok(!out.includes("class=\"sign\""), "署名欄が無い");
  assert.ok(out.includes("甲が法人であるため源泉徴収は行わない"));
  assert.ok(out.includes("期間の定めなし"));
  assert.ok(!out.includes("第１０条"));
  assert.ok(!out.includes("{{"));
});
