import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { UnsentBundlesService, kindOfTemplate } from "./unsent-bundles.js";

test("未送付の文書を相手先ごとに束ねる。受取人宛ての文書はその受取人。種類の順（基本契約書 → 条件書 → 計算書）", async () => {
  const db = new FakeDatabase((text) => {
    if (text.includes("JOIN v_document_display v")) {
      return [{ id: 31, document_no: "ARC-RS-2026-0031", issued_at: "2026-10-07", template_key: "royalty_statement", template_label: "利用許諾計算書", party_id: 11 },
              { id: 21, document_no: "ARC-PUBT-2026-0021", issued_at: "2026-10-06", template_key: "pub_license_terms_v3", template_label: "出版条件書", party_id: 11 },
              { id: 20, document_no: "ARC-PUB-2026-0020", issued_at: "2026-10-06", template_key: "pub_master_individual", template_label: "出版許諾契約書（個人）", party_id: 11 },
              { id: 40, document_no: "ARC-RS-2026-0040", issued_at: "2026-10-07", template_key: "royalty_statement", template_label: "利用許諾計算書", party_id: 22 },
              { id: 50, document_no: "X", issued_at: null, template_key: "royalty_statement", template_label: null, party_id: null }];
    }
    if (text.includes("FROM parties p WHERE p.id = ANY")) {
      return [{ id: 11, name: "瀧里フユ", kind: "individual", email: "fuyu@example.test" },
              { id: 22, name: "宝井ロメロ", kind: "individual", email: null }];
    }
    return undefined;
  });
  const { bundles } = await new UnsentBundlesService(db).list();
  assert.deepEqual(bundles.map((b) => [b.partyName, b.email, b.docs.map((d) => d.kind), b.counts]), [
    ["瀧里フユ", "fuyu@example.test", ["master", "terms", "statement"], { master: 1, terms: 1, statement: 1, other: 0 }],
    ["宝井ロメロ", null, ["statement"], { master: 0, terms: 0, statement: 1, other: 0 }]
  ]);
  assert.deepEqual(bundles[0].docs.map((d) => d.documentNo), ["ARC-PUB-2026-0020", "ARC-PUBT-2026-0021", "ARC-RS-2026-0031"]);
  assert.equal(kindOfTemplate("individual_license_terms_v4"), "terms");
  assert.equal(kindOfTemplate("license_master"), "master");
  assert.equal(kindOfTemplate(null), "other");
});

test("社内確認として担当者に送った文書（gmail.review）は未送付のまま残り、送った日時が付く", async () => {
  const db = new FakeDatabase((text) => {
    if (text.includes("JOIN v_document_display v")) {
      return [{ id: 31, document_no: "ARC-ROY-2026-1021", issued_at: "2026-06-30", template_key: "royalty_statement_pub",
                template_label: "利用許諾計算書", party_id: 11, reviewed_at: "2026-10-08T05:00:00Z" },
              { id: 21, document_no: "ARC-PUBT-2026-1028", issued_at: "2026-10-08", template_key: "pub_license_terms_v3",
                template_label: "出版条件書", party_id: 11, reviewed_at: null }];
    }
    if (text.includes("FROM parties p WHERE p.id = ANY")) return [{ id: 11, name: "伊藤圭亮", kind: "individual", email: null }];
    return undefined;
  });
  const { bundles } = await new UnsentBundlesService(db).list();
  assert.deepEqual(bundles[0].docs.map((d) => [d.documentNo, d.reviewedAt]),
    [["ARC-PUBT-2026-1028", null], ["ARC-ROY-2026-1021", "2026-10-08T05:00:00.000Z"]]);
  const sql = db.find("JOIN v_document_display v")!.text;
  assert.match(sql, /action = 'gmail\.review'/);
  assert.match(sql, /a\.action IN \('gmail\.send', 'cloudsign\.send'\)/, "未送付の判定は相手先へ送った記録だけ");
});
