import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ImportService, IMPORT_SPECS } from "./service.js";
import { PARTY_HEADERS, parsePartyRow } from "./parties.js";

/**
 * 取引先の一括登録・一括修正。列は取引先の画面（登録・修正・口座）と同じ。
 * 値はすべて架空。
 */
const PARTY = {
  id: 7, party_code: "PTY-1", name: "株式会社甲", kind: "corporate", name_kana: "コウ", aliases: ["甲社"],
  invoice_no: null, corporate_no: null, representative_title: null, representative_name: null,
  address: "東京都千代田区1-1", phone: null, email: null, withholding: false,
  residency: "resident", residence_country: null, treaty_rate_pct: null, treaty_docs_received_on: null,
  treaty_note: null, status: "active"
};
const BANK = { party_id: 7, bank_name: "みずほ銀行", branch_name: "神保町支店", account_type: "普通",
               account_number: "1234567", account_holder_kana: "カ）コウ", account_scope: "domestic" };

const db = (opts: { party?: Record<string, unknown>[]; bank?: Record<string, unknown> | null;
                    contact?: Record<string, unknown>[]; overseas?: boolean } = {}) =>
  new FakeDatabase((text) => {
    if (text.includes("SELECT to_jsonb(p) AS row FROM parties p")) return (opts.party ?? [PARTY]).map((row) => ({ row }));
    if (text.includes("SELECT to_jsonb(b) AS row FROM party_bank_accounts")) {
      return opts.bank === null ? [] : [{ row: opts.bank ?? BANK }];
    }
    if (text.includes("FROM party_contacts") && text.includes("'primary' = ANY(roles)")) return opts.contact ?? [];
    if (text.includes("information_schema.columns")) return [{ n: opts.overseas === false ? 0 : 1 }];
    if (text.includes("SELECT id, name, status, party_code FROM parties WHERE id")) return [PARTY];
    if (text.includes("UPDATE parties SET")) return [PARTY];
    if (text.includes("SELECT id, name FROM parties WHERE id")) return [{ id: 7, name: "株式会社甲" }];
    if (text.includes("SELECT id FROM parties WHERE id")) return [{ id: 7 }];
    if (text.includes("INSERT INTO party_contacts")) return [{ id: 55 }];
    if (text.includes("UPDATE party_contacts")) return [{ id: 3 }];
    if (text.includes("INSERT INTO parties")) return [{ id: 91, party_code: "PTY-9" }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: 9 }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    return undefined;
  });

const run = (d: FakeDatabase, csv: string, mode: "create" | "update", dryRun = false) =>
  new ImportService(d).run({ kind: "parties", csv, dryRun, actor: "kuramochi", mode });

test("取込の列は画面の項目（住所・非居住者・口座）を持ち、登録済みに当てられる", () => {
  const spec = IMPORT_SPECS.find((s) => s.kind === "parties")!;
  assert.equal(spec.updatable, true);
  assert.equal(spec.exportPath, "/imports/parties/export.csv");
  for (const h of ["住所", "電話", "メール", "居住区分", "居住国", "条約税率", "条約書類受領日", "状態",
                   "口座区分", "口座番号", "口座名義カナ", "SWIFT", "IBAN"]) {
    assert.ok(PARTY_HEADERS.includes(h as never), `${h} が無い`);
  }
  // 見本はそのまま読めて、エラーにならない
  const lines = spec.sample.split("\n");
  const head = lines[0].split(",");
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    assert.doesNotThrow(() => parsePartyRow(Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]))));
  }
});

test("読み方：語を内部の値に、日付と税率をそろえる。読めない値は行のエラー", () => {
  const p = parsePartyRow({ "区分": "個人", "居住区分": "非居住者", "条約税率": "10%", "条約書類受領日": "2026/1/5",
                            "源泉対象": "対象", "口座区分": "海外", "SWIFT": "exam us33", "銀行の国": "us", "受取通貨": "usd",
                            "状態": "取引終了", "別名": "a、b／c" });
  assert.equal(p.party.kind, "individual");
  assert.equal(p.party.residency, "non_resident");
  assert.equal(p.party.treatyRatePct, 10);
  assert.equal(p.party.treatyDocsReceivedOn, "2026-01-05");
  assert.equal(p.party.withholding, true);
  assert.equal(p.party.status, "archived");
  assert.deepEqual(p.party.aliases, ["a", "b", "c"]);
  assert.deepEqual(p.bank, { accountScope: "overseas", swiftBic: "EXAMUS33", bankCountry: "US", currency: "USD" });
  assert.throws(() => parsePartyRow({ "居住区分": "たぶん海外" }), /居住区分/);
  assert.throws(() => parsePartyRow({ "条約書類受領日": "2026-02-30" }), /日付/);
  assert.throws(() => parsePartyRow({ "条約税率": "120" }), /0〜100/);
  assert.throws(() => parsePartyRow({ "源泉対象": "たぶん" }), /源泉対象/);
  assert.throws(() => parsePartyRow({ "銀行の国": "USA" }), /国コード/);
  // 空欄は入れない（＝触らない）
  assert.deepEqual(parsePartyRow({ "住所": "", "銀行名": " " }), { party: {}, contact: {}, bank: {} });
});

test("新しく作る：住所・非居住者も入り、口座の列があれば口座も入れる", async () => {
  const d = db();
  const csv = "名称,区分,住所,居住区分,居住国,条約税率,口座区分,銀行名,口座番号,受取人名,SWIFT\n" +
              "EXAMPLE STUDIO LLC,法人,1 Example St,非居住者,United States,0,海外,EXAMPLE BANK,000111,EXAMPLE STUDIO LLC,EXAMUS33";
  const r = await run(d, csv, "create");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  const ins = d.find("INSERT INTO parties")!;
  assert.ok(ins.params.includes("1 Example St"));
  assert.ok(ins.params.includes("non_resident"));
  assert.ok(ins.params.includes("United States"));
  assert.ok(d.find("INSERT INTO party_bank_accounts"), "口座が入っていない");
  const up = d.find("UPDATE party_bank_accounts")!;
  assert.ok(up.params.includes("EXAMUS33"));
  assert.ok(up.params.includes("overseas"));
});

test("新しく作る：試算では書かない。海外の列がまだ無い DB では海外口座の行をエラーにする", async () => {
  const d = db();
  await run(d, "名称,区分,銀行名\n乙,法人,みずほ銀行", "create", true);
  assert.ok(!d.find("INSERT INTO parties"));
  assert.ok(!d.find("party_bank_accounts ("));
  const r = await run(db({ overseas: false }), "名称,区分,SWIFT\n乙,法人,EXAMUS33", "create", true);
  assert.equal(r.rows[0].status, "error");
  assert.match(r.rows[0].message ?? "", /海外口座の列/);
});

test("登録済みに当てる：取引先コードで当て、今と違う列だけ直す", async () => {
  const d = db();
  const r = await run(d, "取引先コード,名称,住所,電話,カナ\nPTY-1,株式会社甲,東京都千代田区1-1,03-0000-0000,コウ", "update");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.match(r.rows[0].message ?? "", /^電話 を更新しました$/);
  const q = d.find("UPDATE parties SET")!;
  assert.match(q.text, /phone = \$2/);
  assert.doesNotMatch(q.text.split("WHERE")[0], /address|name_kana|\bname = /, "同じ値の列まで書いている");
});

test("登録済みに当てる：全部今と同じなら変更なし。書き出しをそのまま戻しても何も書かない", async () => {
  const d = db();
  const r = await run(d,
    "取引先コード,名称,区分,カナ,別名,源泉対象,居住区分,状態,口座区分,銀行名,支店名,口座種別,口座番号,口座名義カナ\n" +
    "PTY-1,株式会社甲,法人,コウ,甲社,対象外,居住者,取引中,国内,みずほ銀行,神保町支店,普通,1234567,カ）コウ", "update");
  assert.equal(r.skipped, 1, JSON.stringify(r.rows));
  assert.ok(!d.find("UPDATE parties SET"));
  assert.ok(!d.find("party_bank_accounts\n"), "口座を書いている");
  assert.ok(!d.find("INSERT INTO party_bank_accounts"));
});

test("登録済みに当てる：口座は書いた項目だけ直し、書いていない国内の項目は今の値を残す", async () => {
  const d = db();
  await run(d, "取引先コード,口座番号\nPTY-1,7654321", "update");
  const q = d.find("INSERT INTO party_bank_accounts")!;
  assert.deepEqual(q.params, [7, "みずほ銀行", "神保町支店", "普通", "7654321", "カ）コウ"]);
  const audit = JSON.stringify(d.all("INSERT INTO audit_events").map((a) => a.params));
  assert.doesNotMatch(audit, /7654321/, "口座番号が監査に漏れている");
});

test("登録済みに当てる：名称で当てるときは名称を直さない。同名が 2 件なら止める", async () => {
  const d = db();
  const r = await run(d, "名称,住所\n株式会社甲,大阪府大阪市1-1", "update");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.doesNotMatch(d.find("UPDATE parties SET")!.text, /\bname = /);
  const two = await run(db({ party: [PARTY, { ...PARTY, id: 8, party_code: "PTY-2" }] }), "名称,住所\n株式会社甲,大阪", "update");
  assert.equal(two.rows[0].status, "error");
  assert.match(two.rows[0].message ?? "", /2 件以上/);
  const none = await run(db({ party: [] }), "取引先コード,住所\nPTY-404,大阪", "update");
  assert.match(none.rows[0].message ?? "", /見つかりません/);
});

test("登録済みに当てる：主担当がいれば直し、いなければ主担当の印で足す", async () => {
  const d = db({ contact: [{ id: 3, name: "乙山", email: "a@example.co.jp", department: null }] });
  await run(d, "取引先コード,主担当氏名,主担当部署\nPTY-1,乙山,制作部", "update");
  const u = d.find("UPDATE party_contacts")!;
  assert.match(u.text, /department = /);
  assert.doesNotMatch(u.text, /\bname = /, "同じ氏名まで書いている");

  const d2 = db();
  await run(d2, "取引先コード,主担当メール\nPTY-1,b@example.co.jp", "update");
  const ins = d2.find("INSERT INTO party_contacts")!;
  assert.deepEqual(ins.params[2], ["primary"]);
  const r = await run(db(), "取引先コード,主担当部署\nPTY-1,制作部", "update");
  assert.match(r.rows[0].message ?? "", /主担当氏名か主担当メール/);
});

test("登録済みに当てる：試算では何も書かない", async () => {
  const d = db();
  const r = await run(d, "取引先コード,住所,口座番号\nPTY-1,大阪,7654321", "update", true);
  assert.match(r.rows[0].message ?? "", /住所・口座 を更新します/);
  assert.ok(!d.find("UPDATE parties SET"));
  assert.ok(!d.find("INSERT INTO party_bank_accounts"));
});

test("書き出し：取込と同じ見出しで、口座と主担当も 1 行に出す", async () => {
  const d = new FakeDatabase((text) => text.includes("FROM parties p") && text.includes("party_bank_accounts b")
    ? [{ party: { ...PARTY, withholding: true, residency: "non_resident", treaty_rate_pct: "10.00",
                  treaty_docs_received_on: "2026-01-05" },
         contact: { name: "乙山", email: "a@example.co.jp", department: "制作部" },
         bank: { ...BANK, account_scope: "overseas", swift_bic: "EXAMUS33" } }]
    : undefined);
  const csv = await new ImportService(d).exportParties();
  const [head, line] = csv.split("\r\n");
  assert.equal(head, PARTY_HEADERS.join(","));
  const cells = Object.fromEntries(head.split(",").map((h, i) => [h, line.split(",")[i]]));
  assert.equal(cells["取引先コード"], "PTY-1");
  assert.equal(cells["源泉対象"], "対象");
  assert.equal(cells["居住区分"], "非居住者");
  assert.equal(cells["条約税率"], "10");
  assert.equal(cells["主担当部署"], "制作部");
  assert.equal(cells["口座区分"], "海外");
  assert.equal(cells["SWIFT"], "EXAMUS33");
  assert.equal(cells["口座番号"], "1234567");
});
