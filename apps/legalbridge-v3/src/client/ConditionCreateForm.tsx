import { useEffect, useState } from "react";
import { api } from "./api.js";
import { CreateForm } from "./CreateForm.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { searchParties } from "./SearchSelect.js";

/**
 * 条件明細の登録フォーム。
 *
 * 条件の画面と案件の画面の両方から使う。以前は条件の画面の中に直接書いてあり、
 * 案件から新しい条件を作るには「条件の画面で作ってください」と案内して、
 * 作ってから案件に戻って繋ぎ直す往復が要った。案件を見ながら作れるようにする。
 *
 * 相手先と作品の一覧は開いたときに取りに行く（登録するときにしか要らない）。
 */

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };

export function ConditionCreateForm(
  { title = "条件の登録", preset, onDone, onCancel }: {
    title?: string;
    /**
     * 分かっている項目を埋めた状態で開く。案件から作るなら相手先も
     * 条件の種類も案件が知っている。埋めないと、必須7項目を人が
     * もう一度入れることになる。
     */
    preset?: Partial<Record<"direction" | "kind" | "counterpartyId", string>>;
    onDone: (created: { id: number }) => void;
    onCancel: () => void;
  }
) {
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
  }, []);

  return (
<CreateForm
      title={title}
      path="/conditions"
      initial={{ direction: "in", kind: "service", pricingModel: "fixed",
                 currency: "JPY", taxCategory: "taxable", ...preset }}
      fields={[
        { name: "name", label: "条件名", required: true, placeholder: "◯◯の制作委託 / △△の配信許諾" },
        { name: "direction", label: "向き", type: "select", required: true,
          options: [{ value: "in", label: "IN 取得（費用側）" }, { value: "out", label: "OUT 許諾（収入側）" }] },
        { name: "kind", label: "種類", type: "select", required: true,
          options: (["license", "product", "service", "expense", "fee"] as const).map((k) => ({
            value: k, label: CONDITION_KIND_LABEL[k]
          })),
          hint: "許諾料・製品はライセンスの案件、委託料・実費・手数料は業務委託の案件に繋がる" },
        // 取引先は 2,500 件ある。一覧から選ばせず、名前で探して決める。
        { name: "counterpartyId", label: "相手先", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す" },
        { name: "workId", label: "作品", type: "search",
          options: works.map((w) => ({ value: String(w.id), label: w.title })) },
        { name: "termStart", label: "開始", type: "date" },
        { name: "termEnd", label: "終了", type: "date" },
        { name: "currency", label: "通貨", type: "select", required: true,
          options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },

        { name: "pricingModel", label: "計算方式", type: "select", required: true,
          options: [{ value: "fixed", label: "定額" }, { value: "revenue_rate", label: "料率" },
                    { value: "unit_rate", label: "単価×数量" }, { value: "subscription", label: "定期課金" },
                    { value: "none", label: "計算しない" }],
          hint: "選んだ方式に必要な値が無いと登録できない" },
        { name: "flatAmount", label: "定額（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "fixed",
          hint: "円なら円単位。¥330,000 は 330000" },
        { name: "ratePct", label: "料率（%）", type: "number", required: true,
          visibleWhen: (v) => v.pricingModel === "revenue_rate",
          placeholder: "12.5", hint: "小数で入れる。12.5 は 12.5%" },
        { name: "unitAmount", label: "単価（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "unit_rate" },

        { name: "mgAmount", label: "MG 最低保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: "毎期独立の下限。消化しないので残高を持たない" },
        { name: "agAmount", label: "AG 前払保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: "累積で充当する。消化しきるまで実額が出ない" },
        { name: "exclusivity", label: "独占性", type: "select",
          visibleWhen: (v) => v.kind === "license",
          options: [{ value: "exclusive", label: "独占" }, { value: "non_exclusive", label: "非独占" }] },
        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" }] },
        { name: "paymentTerms", label: "支払条件", placeholder: "検収後30日 など" },
        { name: "regions", label: "地域（許諾範囲）", visibleWhen: (v) => v.kind === "license",
          placeholder: "日本, 台湾", hint: "カンマ区切り。空なら全世界として扱う" },
        { name: "languages", label: "言語（許諾範囲）", visibleWhen: (v) => v.kind === "license",
          placeholder: "日本語, 繁体字" },
        { name: "notes", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => {
        const scopes = [
          ...String(v.regions ?? "").split(/[,、]/).map((x) => x.trim()).filter(Boolean)
            .map((label) => ({ scopeType: "region" as const, label })),
          ...String(v.languages ?? "").split(/[,、]/).map((x) => x.trim()).filter(Boolean)
            .map((label) => ({ scopeType: "language" as const, label }))
        ];
        return {
          name: text(v.name), direction: v.direction, kind: v.kind,
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          currency: v.currency || "JPY", pricingModel: v.pricingModel,
          // 画面は % で受け、保存は ppm（百万分率）。12.5% → 125000
          ratePpm: v.ratePct ? Math.round(Number(v.ratePct) * 10000) : undefined,
          flatAmount: int(v.flatAmount), unitAmount: int(v.unitAmount),
          mgAmount: int(v.mgAmount), agAmount: int(v.agAmount),
          exclusivity: text(v.exclusivity), taxCategory: v.taxCategory,
          paymentTerms: text(v.paymentTerms), notes: text(v.notes),
          scopes: scopes.length ? scopes : undefined
        };
      }}
  onDone={onDone}
  onCancel={onCancel}
/>
  );
}
