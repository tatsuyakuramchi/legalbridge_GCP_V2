import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { UnsentSendPlanner } from "./unsent-send.js";

/**
 * 相手先 11（請求先あり）に計算書 2 枚と条件書 1 枚、相手先 12（連絡先なし・メールなし）に計算書 1 枚、
 * 相手先 13 に計算書 21 枚。
 */
const docs = [
  { id: 1, document_no: "ARC-ROY-2026-1039-R2", template_key: "royalty_statement_pub", party_id: 11 },
  { id: 2, document_no: "ARC-ROY-2026-1040", template_key: "royalty_statement_pub", party_id: 11 },
  { id: 3, document_no: "ARC-TRM-2026-0001", template_key: "pub_license_terms_v3", party_id: 11 },
  { id: 4, document_no: "ARC-ROY-2026-1041", template_key: "royalty_statement_pub", party_id: 12 },
  ...Array.from({ length: 21 }, (_, i) => ({ id: 100 + i, document_no: `ARC-ROY-2026-2${String(i).padStart(3, "0")}`,
                                            template_key: "royalty_statement_pub", party_id: 13 }))
].map((d) => ({ ...d, issued_at: "2026-10-01T03:00:00Z", template_label: "利用許諾計算書", reviewed_at: null }));

const db = () => new FakeDatabase((text, params) => {
  if (text.includes("JOIN v_document_display v")) return docs;
  if (text.includes("SELECT p.id, p.name, p.kind")) {
    return [{ id: 11, name: "作家甲", kind: "individual", email: "kou@example.test" },
            { id: 12, name: "作家乙", kind: "individual", email: null },
            { id: 13, name: "作家丙", kind: "individual", email: "hei@example.test" }];
  }
  if (text.includes("FROM settings WHERE key")) {
    return [{ key: "company_profile", value: { name: "株式会社アークライト" } },
            { key: "mail_templates", value: { partyCc: ["keiri@arclight.test"] } }];
  }
  if (text.includes("'_showRevision'")) {
    const ids = (params[0] as number[]).map(Number);
    return docs.filter((d) => ids.includes(d.id)).map((d) => ({
      ...d, show_revision: null,
      rendered_values: { grandTotalPayableStr: d.id === 1 ? "12,000" : d.id === 2 ? "3,400" : "1,000" }
    }));
  }
  if (text.includes("json_agg(json_build_object")) {
    return [
      { id: 11, email: "kou@example.test", contacts: [
        { name: "甲 本人", email: "kou@example.test", roles: ["primary"] },
        { name: "甲 経理", email: "kou-billing@example.test", roles: ["billing"] }] },
      { id: 12, email: null, contacts: [] },
      { id: 13, email: "hei@example.test", contacts: [] }
    ];
  }
  return undefined;
});

test("計算書だけに絞り、相手先ごとに 1 通の宛先・件名・本文を組む（請求先 → 主担当、cc は設定の cc）", async () => {
  const mails = await new UnsentSendPlanner(db()).plan([11, 12], ["statement"]);
  const kou = mails.find((m) => m.partyId === 11)!;
  assert.deepEqual(kou.docs.map((d) => d.id), [1, 2], "条件書は入れない");
  assert.deepEqual(kou.to, [{ name: "甲 経理", email: "kou-billing@example.test" }], "請求先を先に");
  assert.deepEqual(kou.cc.map((c) => c.email), ["keiri@arclight.test"]);
  assert.match(kou.subject, /利用許諾料計算書のご送付/, "計算書だけなら計算書の文面");
  assert.match(kou.subject, /ARC-ROY-2026-1039（改訂2）・ARC-ROY-2026-1040/, "番号は紙と同じ形で、文書ごとにつなぐ");
  assert.match(kou.body, /作家甲 御中/);
  assert.match(kou.body, /¥12,000・¥3,400/, "金額は文書番号と同じ順");
  assert.equal(kou.mails, 1);
  assert.deepEqual(kou.warnings, []);

  const otsu = mails.find((m) => m.partyId === 12)!;
  assert.deepEqual(otsu.to, []);
  assert.match(otsu.warnings.join(), /メールアドレスの登録がありません/);
});

test("種類が混ざれば「その他の書類」の文面。連絡先が無ければ相手先のメール。20 枚を超えれば分けて送る", async () => {
  const mails = await new UnsentSendPlanner(db()).plan([11, 13], ["statement", "terms"]);
  assert.match(mails.find((m) => m.partyId === 11)!.subject, /書類のご送付/);
  const hei = mails.find((m) => m.partyId === 13)!;
  assert.deepEqual(hei.to, [{ name: null, email: "hei@example.test" }]);
  assert.equal(hei.docs.length, 21);
  assert.equal(hei.mails, 2);
});

test("選んでいない相手先・種類に当たる文書の無い相手先は組まない", async () => {
  assert.deepEqual(await new UnsentSendPlanner(db()).plan([12], ["terms"]), []);
});
