import { useEffect, useState } from "react";
import { api } from "./api.js";
import { CreateForm, type Field } from "./CreateForm.js";
import { searchParties } from "./SearchSelect.js";
import { CONTRACT_FORMS } from "../server/conditions/contract-form.js";
import { minorUnitHint } from "./ConditionCreateForm.js";

/**
 * 業務委託の条件を業務1つぶん登録する（委託料＋実費＋手数料）。
 *
 * 業務委託の1つの業務は、委託料の条件に実費・手数料の条件が組で付いて動く。
 * 3本を条件登録で別々に作ると、相手先や契約が食い違う、実費だけ案件に繋がって
 * いない、が起きる。ここは1画面で受けて、サーバが1トランザクションで N 本作り、
 * 案件にも繋ぐ（POST /conditions/service-set）。
 *
 * 実費・手数料は空のままでもよい。発注書を作る段で欄に打てば、決定のときに
 * 条件が自動で作られて同じ業務に繋がる。
 */

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) && n ? n : undefined; };

export interface ServiceSetCreated {
  conditions: Array<{ usageType: string; id: number; conditionNo: string | null }>;
}

export function ServiceSetForm(
  { preset, counterpartyName, onDone, onCancel }: {
    preset?: Partial<Record<"counterpartyId" | "agreementId" | "matterId" | "workId", string>>;
    /** preset.counterpartyId の表示名。 */
    counterpartyName?: string | null;
    onDone: (created: ServiceSetCreated) => void;
    onCancel: () => void;
  }
) {
  const [agreements, setAgreements] = useState<Agreement[]>([]);

  useEffect(() => {
    api.get<{ agreements: Agreement[] }>("/agreements")
      .then((a) => setAgreements(a.agreements)).catch(() => undefined);
  }, []);

  const serviceFields: Field[] = [
    { name: "pricingModel", label: "委託料：計算方式", type: "select", required: true,
      options: [{ value: "fixed", label: "定額" }, { value: "unit_rate", label: "単価×数量" }] },
    { name: "flatAmount", label: "委託料：定額（税抜）", type: "money", required: true,
      visibleWhen: (v) => v.pricingModel === "fixed", hint: (v) => minorUnitHint(v.currency || "JPY") },
    { name: "unitAmount", label: "委託料：単価（税抜）", type: "money", required: true,
      visibleWhen: (v) => v.pricingModel === "unit_rate", hint: (v) => minorUnitHint(v.currency || "JPY") },
    { name: "quantity", label: "委託料：数量", type: "number",
      visibleWhen: (v) => v.pricingModel === "unit_rate", hint: "単価×数量が発注額になる。空なら発注書で入れる" },
    { name: "spec", label: "委託料：仕様・成果物", type: "textarea",
      placeholder: "カラーイラスト1点（表紙用）、A4 相当 など",
      hint: "発注書・検収書の明細の「仕様・成果物」にそのまま出る" },
    { name: "expenseAmount", label: "実費：上限額（税込）", type: "money",
      hint: (v) => `交通費・宿泊費などの立替。空なら作らない。${minorUnitHint(v.currency || "JPY")}` },
    { name: "expenseName", label: "実費：名前", placeholder: "取材交通費",
      visibleWhen: (v) => String(v.expenseAmount ?? "").trim() !== "", hint: "空なら「◯◯ 実費」" },
    { name: "feeAmount", label: "手数料：金額（税抜）", type: "money",
      hint: (v) => `送料・振込手数料など。空なら作らない。${minorUnitHint(v.currency || "JPY")}` },
    { name: "feeName", label: "手数料：名前", placeholder: "送料",
      visibleWhen: (v) => String(v.feeAmount ?? "").trim() !== "", hint: "空なら「◯◯ 手数料」" }
  ];

  return (
    <CreateForm
      title="業務セットを登録（委託料＋実費＋手数料）"
      submitLabel="この業務の条件を登録する"
      path="/conditions/service-set"
      initial={{ currency: "JPY", taxCategory: "taxable", pricingModel: "fixed", ...preset }}
      fields={[
        { name: "counterpartyId", label: "受託者（相手先）", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す", valueLabel: counterpartyName,
          hint: "発注書の宛先。委託料・実費・手数料すべてに同じ相手先が付く" },
        { name: "title", label: "業務名（委託料の条件名）", required: true,
          placeholder: "◯◯ 英語版 翻訳 / △△ 表紙イラスト制作",
          hint: "発注書の品目名になる。実費・手数料の名前はこれから付く" },
        { name: "agreementId", label: "基本契約（合意）", type: "search",
          options: agreements
            .filter((a) => !preset?.counterpartyId
              || String(a.counterparty?.id ?? "") === preset.counterpartyId)
            .map((a) => ({ value: String(a.id), label: a.title,
                           hint: [a.agreementNo, a.counterparty?.name].filter(Boolean).join("／") })),
          hint: "業務委託基本契約書。同じ案件でも契約や相手先が違えば別の業務になる" },
        { name: "contractForm", label: "契約形式", type: "select",
          options: [{ value: "", label: "（未定）" }, ...CONTRACT_FORMS.map((f) => ({ value: f, label: f }))],
          hint: "請負／準委任など。発注書の明細に出る" },
        { name: "deliverableOwnership", label: "成果物の帰属先", type: "select",
          options: [{ value: "", label: "（未定）" }, { value: "orderer", label: "発注者（譲渡型）" },
                    { value: "contractor", label: "受注者（利用許諾型）" }] },
        { name: "termStart", label: "開始", type: "date" },
        { name: "termEnd", label: "納期・終了", type: "date" },
        { name: "currency", label: "通貨", type: "select", required: true,
          options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },
        { name: "paymentTerms", label: "支払条件", placeholder: "検収後30日 など" },
        { name: "taxCategory", label: "委託料・手数料の税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" }],
          hint: "実費は税込の立替なので、いつも非課税で持つ" },
        ...serviceFields,
        { name: "notes", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => {
        const rows: Array<Record<string, unknown>> = [{
          kind: "service", pricingModel: v.pricingModel || "fixed",
          flatAmount: v.pricingModel === "fixed" ? num(v.flatAmount) ?? null : null,
          unitAmount: v.pricingModel === "unit_rate" ? num(v.unitAmount) ?? null : null,
          quantity: v.pricingModel === "unit_rate" ? num(v.quantity) ?? null : null,
          spec: text(v.spec) ?? null, notes: text(v.notes) ?? null
        }];
        if (text(v.expenseAmount)) {
          rows.push({ kind: "expense", name: text(v.expenseName) ?? null, pricingModel: "fixed",
                      flatAmount: num(v.expenseAmount) ?? 0, notes: "税込の実費（上限）" });
        }
        if (text(v.feeAmount)) {
          rows.push({ kind: "fee", name: text(v.feeName) ?? null, pricingModel: "fixed",
                      flatAmount: num(v.feeAmount) ?? 0 });
        }
        return {
          title: text(v.title), counterpartyId: int(v.counterpartyId),
          agreementId: int(v.agreementId), matterId: int(v.matterId), workId: int(v.workId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          currency: v.currency || "JPY", taxCategory: v.taxCategory || "taxable",
          paymentTerms: text(v.paymentTerms), contractForm: text(v.contractForm),
          deliverableOwnership: text(v.deliverableOwnership) ?? null,
          rows
        };
      }}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
