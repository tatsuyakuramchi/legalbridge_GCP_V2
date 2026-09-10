import test from "node:test";
import assert from "node:assert/strict";
import { bindVariables, parseVariables, pick, assertComplete } from "./binding.js";
import { DomainError } from "../core/errors.js";

const context = {
  agreement: { title: "繁体字版 配信許諾契約", counterparty: { name: "晨光數位出版", honorific: "御中" } },
  condition: { conditionNo: "CL-2026-00042", ratePct: 12.5, mgAmount: 1200000, work: { title: "星降る夜のミュゼ" } },
  conditions: [{ name: "繁体字版 電子書籍 配信許諾" }],
  totals: { exTax: 612000 }
};

test("供給元のパスから値を解決する（相手先のキー名が何であっても1本）", () => {
  const result = bindVariables(parseVariables([
    { name: "LICENSEE_NAME", from: "agreement.counterparty.name" },
    { name: "HONORIFIC", from: "agreement.counterparty.honorific" },
    { name: "CONTRACT_TITLE", from: "agreement.title" },
    { name: "RATE", from: "condition.ratePct" },
    { name: "WORK", from: "condition.work.title" }
  ]), context);

  assert.deepEqual(result.values, {
    LICENSEE_NAME: "晨光數位出版", HONORIFIC: "御中",
    CONTRACT_TITLE: "繁体字版 配信許諾契約", RATE: 12.5, WORK: "星降る夜のミュゼ"
  });
  assert.deepEqual(result.derived.sort(), ["CONTRACT_TITLE", "HONORIFIC", "LICENSEE_NAME", "RATE", "WORK"]);
  assert.deepEqual(result.missing, []);
});

test("配列は添字で辿れる", () => {
  const result = bindVariables(parseVariables([{ name: "LINE1", from: "conditions.0.name" }]), context);
  assert.equal(result.values.LINE1, "繁体字版 電子書籍 配信許諾");
});

test("manual は手入力から取り、既定値も効く", () => {
  const result = bindVariables(parseVariables([
    { name: "PERIOD", from: "manual" },
    { name: "REMARKS", default: "特になし" }
  ]), context, { PERIOD: "2026上期" });
  assert.equal(result.values.PERIOD, "2026上期");
  assert.equal(result.values.REMARKS, "特になし");
});

test("供給元が空のときだけ手入力で補える（移行期の欠測用）", () => {
  const result = bindVariables(parseVariables([
    { name: "WORK", from: "condition.work.title" },
    { name: "PART", from: "condition.work.part" }
  ]), context, { WORK: "手入力は使われない", PART: "本文" });
  assert.equal(result.values.WORK, "星降る夜のミュゼ", "データ側があれば優先する");
  assert.equal(result.values.PART, "本文", "データ側が空なら手入力で補う");
  assert.deepEqual(result.derived, ["WORK"]);
});

test("必須の未入力は missing に集まり、発行前に弾ける", () => {
  const result = bindVariables(parseVariables([
    { name: "PERIOD", from: "manual", required: true, label: "対象期間" },
    { name: "AMOUNT", from: "totals.exTax", required: true }
  ]), context);
  assert.deepEqual(result.missing, [{ name: "PERIOD", label: "対象期間" }]);
  assert.throws(() => assertComplete(result),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION" && /対象期間/.test(e.message));
});

test("解決できないパスは値を作らない（空文字を焼き付けない）", () => {
  const result = bindVariables(parseVariables([{ name: "X", from: "agreement.missing.deep" }]), context);
  assert.equal("X" in result.values, false);
});

test("pick は途中が null でも落ちない", () => {
  assert.equal(pick({ a: null }, "a.b.c"), undefined);
  assert.equal(pick(context, "condition.conditionNo"), "CL-2026-00042");
});

test("parseVariables は name の無い項目を捨てる", () => {
  assert.equal(parseVariables([{ label: "名前なし" }, { name: "OK" }, null, "x"]).length, 1);
});

// ---------------------------------------------------------------------------
// V1 の field_schema をそのまま読む（移行したひな形はこの形で入っている）
// ---------------------------------------------------------------------------

test("dbField の宣言から値を引く", () => {
  const context = {
    condition: { counterparty: { name: "吉澤淳郎", address: "東京都千代田区", kind: "individual" } },
    bank: { bankName: "三菱UFJ銀行", branchName: "神保町支店", accountType: "ordinary",
            accountNumber: "2513200", holderKana: "ヨシザワ　アツオ" },
    owner: { name: "浅井 崇", department: "制作部" },
    company: { name: "株式会社アークライト", address: "東京都千代田区", rep: "野澤 邦仁" }
  };
  const r = bindVariables(parseVariables([
    { name: "BANK_NAME", label: "金融機関", dbField: "vendor.bank_name", required: true },
    { name: "ACCOUNT_TYPE", label: "種別", dbField: "vendor.account_type", required: true },
    { name: "VENDOR_ADDRESS", label: "住所", dbField: "vendor.address", required: true },
    { name: "STAFF_NAME", label: "担当", dbField: "staff.staff_name", required: true },
    { name: "COMPANY_REP", label: "代表", dbField: "company.rep", required: true }
  ]), context, {});
  assert.equal(r.values.BANK_NAME, "三菱UFJ銀行");
  assert.equal(r.values.ACCOUNT_TYPE, "普通", "英字のまま出さない");
  assert.equal(r.values.VENDOR_ADDRESS, "東京都千代田区");
  assert.equal(r.values.STAFF_NAME, "浅井 崇");
  assert.equal(r.values.COMPANY_REP, "野澤 邦仁");
  assert.deepEqual(r.missing, []);
});

test("計算で埋まる欄は手入力より優先する（表と合計をずらさない）", () => {
  const r = bindVariables(
    parseVariables([{ name: "taxAmountStr", label: "消費税額", required: true }]),
    {}, { taxAmountStr: "0" }, { templateKey: "inspection_certificate",
                                 computed: { taxAmountStr: "28,000" } });
  assert.equal(r.values.taxAmountStr, "28,000");
  assert.ok(r.derived.includes("taxAmountStr"));
});

test("隠し項目と使わない分岐の項目は未入力に数えない", () => {
  const variables = parseVariables([
    { name: "hidden_one", label: "内部用", required: true, hidden: true },
    { name: "MODE", label: "方式", required: false },
    { name: "only_for_a", label: "A専用", required: true,
      showWhen: { field: "MODE", anyOf: ["A"] } },
    { name: "always", label: "いつでも", required: true }
  ]);
  const r = bindVariables(variables, {}, { MODE: "B" }, { templateKey: "purchase_order" });
  assert.deepEqual(r.missing.map((m) => m.name), ["always"]);
});

test("検収書は明細があるとき単票の金額欄を要求しない", () => {
  const variables = parseVariables([
    { name: "deliveredAmountStr", label: "納品額", required: true },
    { name: "taxAmountStr", label: "消費税額", required: true },
    { name: "totalAmountStr", label: "合計額", required: true },
    { name: "REMARKS", label: "備考", required: true }
  ]);
  const withLines = bindVariables(variables, {}, {}, {
    templateKey: "inspection_certificate",
    computed: { delivery_line_items: [{ amount_ex_tax: 280000 }] }
  });
  assert.deepEqual(withLines.missing.map((m) => m.name), ["REMARKS"],
    "明細から計算する欄を人に打たせない");

  const withoutLines = bindVariables(variables, {}, {}, {
    templateKey: "inspection_certificate", computed: { delivery_line_items: [] }
  });
  assert.deepEqual(withoutLines.missing.map((m) => m.name).sort(),
    ["REMARKS", "deliveredAmountStr", "taxAmountStr", "totalAmountStr"].sort(),
    "明細が無ければ従来どおり手入力に回す");
});

test("計算書の計算欄は人に入力させない（試算がまだ無くても）", () => {
  // V1 はここを人が打てた。V3 の計算書は必ず条件と実績から出るので、
  // ひな形を選んだ直後（試算がまだ無い）でも打たせる欄ではない。
  // 宣言をそのまま並べていたころは「金額を全部手で入れてください」という
  // 画面になっていた（本番のひな形は 64 項目のうち 22 項目がこれ）。
  const variables = parseVariables([
    { name: "grossRoyaltyStr", label: "グロス", required: true },
    { name: "PERIOD", label: "対象期間", required: true }
  ]);
  for (const context of [{ royalty: { grossExTax: 1000 } }, {}]) {
    const bound = bindVariables(variables, context, {}, { templateKey: "royalty_statement" });
    assert.deepEqual(bound.missing.map((m) => m.name), ["PERIOD"]);
    assert.deepEqual(bound.fields.map((f) => f.name), ["PERIOD"], "計算欄は画面に出さない");
  }

  // ほかのひな形には効かない。同じ名前でも意味が違う。
  const other = bindVariables(variables, {}, {}, { templateKey: "inspection_certificate" });
  assert.equal(other.missing.length, 2);
});

test("個人の相手先に法人だけの項目を要求しない", () => {
  const variables = parseVariables([{ name: "VENDOR_REP", label: "代表者", required: true }]);
  const individual = bindVariables(variables,
    { condition: { counterparty: { kind: "individual" } } }, {}, { templateKey: "license_master" });
  assert.deepEqual(individual.missing, []);
  const corporate = bindVariables(variables,
    { condition: { counterparty: { kind: "corporate" } } }, {}, { templateKey: "license_master" });
  assert.deepEqual(corporate.missing.map((m) => m.name), ["VENDOR_REP"]);
});

test("口座種別しか無い行は口座として扱わない", async () => {
  // V1 のフォームは口座種別に「普通」を初期値で入れていた。銀行名も口座番号も
  // 名義も無いまま保存された取引先が98件あり、そのまま書類に出すと
  //「振込先: 普通」とだけ印字される。空欄より悪い（あるように見える）。
  const { buildTemplateContext } = await import("./template-context.js");
  const empty = buildTemplateContext("inspection_certificate", { bank: null }, {});
  assert.equal(empty.BANK_INFO, "");
  assert.equal(empty.ACCOUNT_TYPE, "");
  // 銀行名だけでも入っていれば口座として出す（海外の相手先はこの形になる）。
  const partial = buildTemplateContext("inspection_certificate",
    { bank: { bankName: "INTESA SANPAOLO SPA", branchName: null, accountType: null,
              accountNumber: null, holderKana: null } }, {});
  assert.equal(partial.BANK_NAME, "INTESA SANPAOLO SPA");
  assert.equal(partial.BANK_INFO, "INTESA SANPAOLO SPA");
});

test("画面に出す項目は区分と出どころ付きで並ぶ。明細と隠し項目は出さない", () => {
  // 発注書の形。相手先は条件から、合計は計算から、備考は人が入れる。
  const variables = parseVariables([
    { name: "VENDOR_NAME", label: "相手先", group: "I. 基本情報", from: "condition.counterparty.name", required: true },
    { name: "totalAmountStr", label: "合計", group: "III. 金額" },
    { name: "REMARKS", label: "備考", group: "IV. その他", type: "textarea", helpText: "任意" },
    { name: "items", label: "明細", type: "array" },
    { name: "SECRET", label: "隠し", hidden: true },
    { name: "PAY_METHOD", label: "支払方法", type: "select", options: ["振込", "現金"], required: true }
  ]);
  const r = bindVariables(variables, { condition: { counterparty: { name: "合同会社アトリエ蒼" } } },
    { REMARKS: "急ぎ" }, { templateKey: "purchase_order", computed: { totalAmountStr: "330,000" } });

  assert.deepEqual(r.fields.map((f) => [f.name, f.source, f.group]), [
    ["VENDOR_NAME", "auto", "I. 基本情報"],
    ["totalAmountStr", "computed", "III. 金額"],
    ["REMARKS", "manual", "IV. その他"],
    ["PAY_METHOD", "manual", null]
  ], "明細（array）と隠し項目は画面に出さない");
  assert.equal(r.fields[0].value, "合同会社アトリエ蒼", "自動で引いた値をそのまま見せる");
  assert.equal(r.fields[2].value, "急ぎ");
  assert.equal(r.fields[2].helpText, "任意");
  assert.deepEqual(r.fields[3].options, ["振込", "現金"]);
  assert.deepEqual(r.missing.map((m) => m.name), ["PAY_METHOD"]);
});

test("noGuess の項目は名前で推測しない（近い名前の値が紛れ込まない）", () => {
  // 条件書の「許諾者種別」は 法人／個人 の選択。名前が近いだけで相手先の
  // 名前が入っていた。供給元をこちらで決めている項目は推測を切る。
  const context = {
    condition: { counterparty: { name: "晨光數位出版股份有限公司", kind: "corporate" } }
  };
  const guessed = bindVariables([{ name: "許諾者種別" }], context, {});
  assert.equal(guessed.values["許諾者種別"], "晨光數位出版股份有限公司", "推測は当たってしまう");

  const declared = bindVariables(
    [{ name: "許諾者種別", dbField: "vendor.entity_type", noGuess: true }], context, {});
  assert.equal(declared.values["許諾者種別"], "法人");

  const blank = bindVariables([{ name: "許諾者種別", noGuess: true }], context, {});
  assert.equal(blank.values["許諾者種別"], undefined, "供給元が無ければ空のまま");
});
