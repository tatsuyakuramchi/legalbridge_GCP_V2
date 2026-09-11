import test from "node:test";
import assert from "node:assert/strict";
import { resolveLegacyVariable } from "./legacy-variables.js";
import { bindVariables } from "./binding.js";

const ctx = (over: Record<string, any> = {}) => ({
  document: { number: "ARC-INS-2026-0072", issuedOn: "2026-09-08" },
  company: { name: "株式会社アークライト", address: "東京都千代田区", representative: "代表 太郎" },
  condition: {
    name: "毎月280,000円の委託", termStart: "2026-04-01", termEnd: "2027-03-31",
    paymentTerms: "検収月の翌月末払い",
    counterparty: { name: "吉澤淳郎", kind: "individual", kana: "ヨシザワ ジユンロウ",
                    invoiceNo: "T1234567890123" },
    work: { title: "作品X" }
  },
  contacts: [{ role: "primary", name: "吉澤 淳郎", email: "y@example.com" },
             { role: "signer", name: "署名 太郎" }],
  owner: { name: "川島 純子", department: "法務部", email: "j@arclight.co.jp" },
  event: { occurredOn: "2026-04-30", amount: 300000, period: "2026年4月分" },
  totals: { exTax: 280000, tax: 28000, incTax: 308000 },
  bank: { bankName: "みずほ銀行", branchName: "渋谷支店", accountType: "ordinary",
          accountNumber: "1234567", holderKana: "ヨシザワ ジユンロウ" },
  matter: { title: "制作委託" },
  ...over
});

const at = (name: string, over: Record<string, any> = {}) => resolveLegacyVariable(name, ctx(over));

test("V1 の変数名で文書番号と発行日が埋まる", () => {
  assert.equal(at("CONTRACT_NO"), "ARC-INS-2026-0072");
  assert.equal(at("DOC_NO"), "ARC-INS-2026-0072");
  assert.equal(at("ORDER_NO"), "ARC-INS-2026-0072");
  assert.equal(at("SIGN_DATE"), "2026-09-08");
  assert.equal(at("発行日"), "2026-09-08");
});

test("相手先は別名でも引ける（V1 の実データは表記が揺れている）", () => {
  for (const name of ["VENDOR_NAME", "LICENSOR_NAME", "許諾者", "相手先", "取引先",
                      "counterparty", "受託者名", "contractor_name"]) {
    assert.equal(at(name), "吉澤淳郎", name);
  }
});

test("敬称は区分から導く（個人なら様・法人なら御中）", () => {
  assert.equal(at("VENDOR_SUFFIX"), "様");
  assert.equal(at("LICENSOR_SUFFIX"), "様");
  const corp = { condition: { counterparty: { name: "甲社", kind: "corporate" } } };
  assert.equal(at("VENDOR_SUFFIX", corp), "御中");
});

test("法人区分は文字列で返す（真偽値だとテンプレの比較が常に偽になる）", () => {
  // V2 の context-adapter と同じ。`eq VENDOR_IS_CORPORATION "法人"` と
  // `or VENDOR_IS_CORPORATION ...` の両方で使われる。
  assert.equal(at("VENDOR_IS_CORPORATION"), "");
  assert.equal(at("VENDOR_IS_CORPORATION",
    { condition: { counterparty: { name: "甲社", kind: "corporate" } } }), "法人");
});

test("自社の担当者は案件の担当スタッフから埋まる", () => {
  assert.equal(at("STAFF_NAME"), "川島 純子");
  assert.equal(at("STAFF_DEPARTMENT"), "法務部");
  assert.equal(at("検収者氏名"), "川島 純子");
  assert.equal(at("検収者部署"), "法務部");
});

/**
 * 検収者は「誰が検収したか」の記録なので、実績にあればそれが正しい。
 * 実績に入れておけば、検収書を作るときに人が入れずに済む。
 */
test("検収者と検収日は、実績にあれば実績から取る", () => {
  const withEvent = { event: { occurredOn: "2026-08-31", inspectedOn: "2026-09-02",
                               inspectorName: "倉持 達也", inspectorDept: "事業推進部" } };
  assert.equal(at("検収者氏名", withEvent), "倉持 達也");
  assert.equal(at("検収者部署", withEvent), "事業推進部");
  assert.equal(at("inspectorName", withEvent), "倉持 達也");
  assert.equal(at("検収日", withEvent), "2026-09-02");
  // 担当者そのものは実績で上書きしない。発注書の申請者などに使う。
  assert.equal(at("STAFF_NAME", withEvent), "川島 純子");
});

test("実績に検収者が無ければ案件の担当者で代える", () => {
  const bare = { event: { occurredOn: "2026-08-31" } };
  assert.equal(at("検収者氏名", bare), "川島 純子");
  assert.equal(at("検収日", bare), "2026-08-31", "検収日が無ければ納品日");
});

// 並びと区切りは V1 の buildPurchaseOrderContext と同じにしてある。
// V1 の書類と並べたときに見た目が変わらないことが条件。
const BANK_LINE = "みずほ銀行 / 渋谷支店 / 普通 1234567 / ヨシザワ ジユンロウ";

test("振込先は1行にまとめて返す", () => {
  assert.equal(at("BANK_INFO"), BANK_LINE);
  assert.equal(at("振込先"), BANK_LINE);
});

test("振込先は項目ごとにも引ける（V1 の名前で）", () => {
  // ここが欠けていたせいで、検収書の振込先に口座番号と名義しか出なかった。
  assert.equal(at("BANK_NAME"), "みずほ銀行");
  assert.equal(at("BRANCH_NAME"), "渋谷支店");
  assert.equal(at("ACCOUNT_TYPE"), "普通", "DB は英字。書類に出すのは日本語");
  assert.equal(at("ACCOUNT_NUMBER"), "1234567");
  assert.equal(at("ACCOUNT_HOLDER_KANA"), "ヨシザワ ジユンロウ");
  // 日本語のラベルでも引ける（ひな形により名前が違う）。
  assert.equal(at("金融機関名"), "みずほ銀行");
  assert.equal(at("支店名"), "渋谷支店");
  assert.equal(at("預金種別"), "普通");
});

test("納品日・検収日・金額は実績から埋まる", () => {
  assert.equal(at("実納品日"), "2026-04-30");
  assert.equal(at("検収完了日"), "2026-04-30");
  assert.equal(at("納品額"), "300000", "条件の定額ではなく実績の金額");
  assert.equal(at("対象期間"), "2026年4月分");
});

test("対応表に無い名前は手入力に回す（当てずっぽうで埋めない）", () => {
  assert.equal(at("SOME_UNKNOWN_FIELD"), undefined);
  assert.equal(at(""), undefined);
});

test("値が無いときも手入力に回す", () => {
  assert.equal(resolveLegacyVariable("BANK_INFO", { }), undefined);
  assert.equal(resolveLegacyVariable("STAFF_NAME", { owner: null }), undefined);
});

test("供給元の宣言が無いひな形でも、名前が合えば自動で埋まる", () => {
  const r = bindVariables(
    [{ name: "CONTRACT_NO", label: "文書番号", required: true },
     { name: "VENDOR_NAME", label: "受託者名", required: true },
     { name: "検収者氏名", label: "検収者氏名", required: true },
     { name: "自由記入", label: "自由記入", required: true }],
    ctx(), {});
  assert.deepEqual(r.derived.sort(), ["CONTRACT_NO", "VENDOR_NAME", "検収者氏名"].sort());
  assert.deepEqual(r.missing.map((m) => m.name), ["自由記入"], "残るのは本当に人しか知らない項目だけ");
});

test("手入力が先。人が直したものをデータで上書きしない", () => {
  const r = bindVariables(
    [{ name: "VENDOR_NAME", label: "受託者名", required: true }],
    ctx(), { VENDOR_NAME: "手で直した名前" });
  assert.equal(r.values.VENDOR_NAME, "手で直した名前");
  assert.equal(r.derived.includes("VENDOR_NAME"), false);
});

// ---- 部分一致（V1 の名前は「検収書発行日」のように長い） ----

test("長い名前でも、含まれる名前で引ける", () => {
  assert.equal(at("検収書発行日"), "2026-09-08");
  assert.equal(at("成果物・業務内容"), "制作委託");
  assert.equal(at("実納品日"), "2026-04-30");
});

test("括弧つきのラベルでも引ける", () => {
  assert.equal(resolveLegacyVariable("amount_ex_tax", ctx(), "納品額 (税抜)"), "300000");
});

test("長いほうを優先する（短い名前に先に当たらない）", () => {
  // 「実納品日」は「納品日」も含むが、どちらも実績の発生日なので同じ値。
  // 取り違えが起きうる組み合わせを見張る。
  assert.equal(at("契約開始日"), "2026-04-01");
  assert.equal(at("契約終了日"), "2027-03-31");
  assert.notEqual(at("契約終了日"), at("契約開始日"));
});

test("関係のない名前は拾わない", () => {
  // 3文字未満の名前での部分一致は使わない。「日」や「額」で何にでも当たると困る。
  assert.equal(at("承認"), undefined);
  assert.equal(at("備考欄に書くこと"), undefined);
  assert.equal(at("XYZ"), undefined);
});

test("値が無ければ、当たっても手入力に回す", () => {
  // 案件を選んでいない＝担当者が居ないときは、検収者を勝手に埋めない。
  assert.equal(resolveLegacyVariable("検収者氏名", { condition: { name: "x" } }), undefined);
});

test("見出しの発注番号は、条件をまたぐと重複なく「・」で並ぶ", () => {
  const context = {
    related: [
      { conditionId: 1, documentNo: "ARC-PO-2026-0031", templateKey: "purchase_order" },
      { conditionId: 2, documentNo: "ARC-PO-2026-0033", templateKey: "purchase_order" },
      { conditionId: 3, documentNo: "ARC-PO-2026-0031", templateKey: "purchase_order" }
    ]
  } as any;
  assert.equal(resolveLegacyVariable("parent_po_number", context), "ARC-PO-2026-0031・ARC-PO-2026-0033");
});

test("見出しの発注番号も、V3 の発注書が無ければ条件の控えを使う", () => {
  const context = {
    related: [],
    conditions: [{ id: 1, orderNo: "ARC-PO-2025-0123" }, { id: 2, orderNo: "ARC-PO-2025-0124" },
                 { id: 3, orderNo: null }]
  } as any;
  assert.equal(resolveLegacyVariable("parent_po_number", context),
               "ARC-PO-2025-0123・ARC-PO-2025-0124");
});

test("「発注番号」は文書自身の番号を指す（検収書の親は parent_po_number）", () => {
  // 同じ名前が2か所にあり、先に見つかったほうが勝つ。発注書では自分の番号が正しい。
  // 検収書のひな形で親の発注番号を出したいときは parent_po_number を使う。
  const context = {
    document: { number: "ARC-INS-2026-1001" },
    related: [{ conditionId: 1, documentNo: "ARC-PO-2026-0031", templateKey: "purchase_order" }]
  } as any;
  assert.equal(resolveLegacyVariable("発注番号", context), "ARC-INS-2026-1001");
  assert.equal(resolveLegacyVariable("parent_po_number", context), "ARC-PO-2026-0031");
});

test("発注元（甲・委託者・ライセンシー）は自社。相手先ではない", () => {
  // PARTY_A_NAME を相手先の対応表にも入れていたので、相手先のほうが先に
  // 当たり、発注書の「発注元 名称」に取引先の名前が入っていた。
  // 住所と代表者は自社を返していたので、社名だけ相手のものになっていた。
  const context = {
    company: { name: "自社", address: "自社住所", rep: "自社代表" },
    condition: { counterparty: { name: "取引先", address: "取引先住所" } }
  };
  for (const label of ["発注元 名称", "甲 名称", "発注者 (甲)", "甲 (委託者) 商号", "ライセンシー名称"]) {
    assert.equal(resolveLegacyVariable("PARTY_A_NAME", context, label), "自社");
  }
  assert.equal(resolveLegacyVariable("PARTY_A_ADDRESS", context, "発注元 住所"), "自社住所");
  assert.equal(resolveLegacyVariable("PARTY_A_REP", context, "発注元 代表者"), "自社代表");
  // 相手先の欄はそのまま。
  assert.equal(resolveLegacyVariable("VENDOR_NAME", context, "発注先 名称"), "取引先");
});

test("基本契約ありは、条件に契約が付いているかで決まる", () => {
  // 埋まらないと、契約を当ててあっても紙は「スポット契約の約款による」で出る。
  assert.equal(resolveLegacyVariable("HAS_BASE_CONTRACT",
    { agreement: { no: "AGR-2025-0011", title: "制作業務委託基本契約" } }, "基本契約あり"), true);
  // 契約が無ければ決めない（人がチェックを入れられる）。
  assert.equal(resolveLegacyVariable("HAS_BASE_CONTRACT", { agreement: undefined }, "基本契約あり"), undefined);
});
