import { useEffect, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm } from "./CreateForm.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { searchParties } from "./SearchSelect.js";
import { minorPerMajor } from "../server/royalty/economics.js";
import { CONDITION_USAGE_TYPES, isSublicensingUsage } from "../server/core/condition-usage.js";
import { conditionNameFor } from "../server/conditions/naming.js";

/**
 * 金額の欄の補足。通貨で単位が変わる。
 *
 * 「最小通貨単位」と書いてあるだけでは、USD の $7.35 を 7.35 と打ってしまう。
 * 小数は保存できないので弾かれるが、何を直せばいいのかは画面から読めない
 * （実際にここで手が止まった）。通貨に合わせて例を出す。
 */
export function minorUnitHint(currency: string): string {
  const per = minorPerMajor(currency || "JPY");
  if (per === 1) return `${currency || "JPY"} は整数で入れる。¥330,000 は 330000`;
  return `${currency} は1/${per}単位。$7.35 は 735（小数は入れられません）`;
}

/**
 * 条件明細の登録フォーム。
 *
 * 条件の画面と案件の画面の両方から使う。以前は条件の画面の中に直接書いてあり、
 * 案件から新しい条件を作るには「条件の画面で作ってください」と案内して、
 * 作ってから案件に戻って繋ぎ直す往復が要った。案件を見ながら作れるようにする。
 *
 * 相手先と作品の一覧は開いたときに取りに行く（登録するときにしか要らない）。
 */

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };

/** 「1年」「6か月」を月に。空なら1年（12か月）。 */
const renewMonths = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  if (!s) return 12;
  const m = s.match(/^(\d+)(年|か月|ヶ月|カ月)?$/);
  if (!m) return 12;
  const n = Number(m[1]);
  return /年/.test(m[2] ?? "") ? n * 12 : n;
};

export function ConditionCreateForm(
  { title = "条件の登録", preset, onDone, onCancel }: {
    title?: string;
    /**
     * 分かっている項目を埋めた状態で開く。案件から作るなら相手先も
     * 条件の種類も案件が知っている。埋めないと、必須7項目を人が
     * もう一度入れることになる。
     */
    preset?: Partial<Record<
      "direction" | "kind" | "counterpartyId" | "workId" | "agreementId"
      | "currency" | "taxCategory" | "pricingModel" | "name", string>>;
    onDone: (created: { id: number }) => void;
    onCancel: () => void;
  }
) {
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
    // 条件は契約（合意）の明細。どの契約の下の条件かが入っていないと、
    // 契約から条件を辿れず、計算書の契約名・契約番号も空で出る。
    api.get<{ agreements: Agreement[] }>("/agreements")
      .then((a) => setAgreements(a.agreements)).catch(() => undefined);
  }, []);

  return (
<CreateForm
      title={title}
      path="/conditions"
      initial={{ direction: "in", kind: "service", pricingModel: "fixed",
                 currency: "JPY", taxCategory: "taxable", ...preset }}
      fields={[
        // 作品に紐づく許諾（IN）は名前を打たせない。作品名｜取引モデル で付く（下の利用形態）。
        { name: "name", label: "条件名", required: true, placeholder: "◯◯の制作委託 / △△の配信許諾",
          visibleWhen: (v) => !(v.kind === "license" && v.direction === "in" && String(v.workId ?? "").trim() !== "") },
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
        { name: "workId", label: "作品（許諾なら原作か、原作を兼ねる作品）", type: "search",
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          hint: "ライセンスの条件は作品にぶら下げる。ここが空だと権利の上限を計算できない" },
        // 相手先が分かっているときは、その相手先の契約だけを候補にする。
        { name: "agreementId", label: "契約（合意）", type: "search",
          options: agreements
            .filter((a) => !preset?.counterpartyId
              || String(a.counterparty?.id ?? "") === preset.counterpartyId)
            .map((a) => ({ value: String(a.id), label: a.title,
                           hint: [a.agreementNo, a.counterparty?.name].filter(Boolean).join("／") })),
          hint: "計算書の契約名・契約番号はここから出る" },
        { name: "termStart", label: "開始", type: "date" },
        { name: "termEnd", label: "終了", type: "date" },
        // 自動更新（A-039）。更新した回数は持たず、終了日・単位・今日から数える。
        { name: "autoRenew", label: "自動更新", type: "select",
          options: [{ value: "", label: "しない" }, { value: "1", label: "する" }],
          visibleWhen: (v) => String(v.termEnd ?? "").trim() !== "",
          hint: "終了日が来るたびに自動で更新したことにする。条件書には「更新 n 回」と出る" },
        { name: "renewMonths", label: "更新の単位", placeholder: "1年",
          visibleWhen: (v) => Boolean(v.autoRenew) && String(v.termEnd ?? "").trim() !== "",
          hint: "「1年」「6か月」。空なら1年" },
        { name: "renewStoppedOn", label: "更新を止めた日", type: "date",
          visibleWhen: (v) => Boolean(v.autoRenew) && String(v.termEnd ?? "").trim() !== "",
          hint: "入れるとその日で回数が止まる（いまの期間は満了まで有効）" },
        { name: "currency", label: "通貨", type: "select", required: true,
          options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },

        { name: "pricingModel", label: "計算方式", type: "select", required: true,
          options: [{ value: "fixed", label: "定額" }, { value: "revenue_rate", label: "料率" },
                    { value: "unit_rate", label: "単価×数量" }, { value: "subscription", label: "定期課金" },
                    { value: "none", label: "計算しない" }],
          hint: "選んだ方式に必要な値が無いと登録できない" },
        // 定期課金は「1回あたり」をこの欄に入れる（計算も period_amount として読む）。
        // 出していなかったので、定期課金の条件は金額を持てないまま作られていた。
        { name: "flatAmount",
          label: (v) => v.pricingModel === "subscription"
            ? "1回あたりの金額（最小通貨単位）" : "定額（最小通貨単位）",
          type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "fixed" || v.pricingModel === "subscription",
          hint: (v) => v.pricingModel === "subscription"
            ? `毎月・毎期のいちどぶん。総額ではない。${minorUnitHint(v.currency)}`
            : minorUnitHint(v.currency) },
        { name: "ratePct", label: "料率（%）", type: "number", required: true,
          visibleWhen: (v) => v.pricingModel === "revenue_rate",
          placeholder: "12.5", hint: "小数で入れる。12.5 は 12.5%" },
        { name: "unitAmount", label: "単価（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.pricingModel === "unit_rate",
          hint: (v) => minorUnitHint(v.currency) },

        { name: "mgAmount", label: "MG 最低保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: (v) => `毎期独立の下限。消化しないので残高を持たない。${minorUnitHint(v.currency)}` },
        { name: "agAmount", label: "AG 前払保証", type: "money",
          visibleWhen: (v) => v.direction === "out",
          hint: (v) => `累積で充当する。消化しきるまで実額が出ない。${minorUnitHint(v.currency)}` },
        { name: "exclusivity", label: "独占性", type: "select",
          visibleWhen: (v) => v.kind === "license",
          options: [{ value: "exclusive", label: "独占" }, { value: "non_exclusive", label: "非独占" }] },
        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" }] },
        { name: "paymentTerms", label: "支払条件", placeholder: "検収後30日 など" },
        // 発注書・検収書の明細はここから出る。備考を仕様代わりにしない。
        { name: "spec", label: "仕様・成果物", type: "textarea",
          placeholder: "カラーイラスト1点（表紙用）、A4 相当 など",
          hint: "発注書・検収書の明細の「仕様・成果物」にそのまま出る" },
        // V3 で発注書を出せば自動で入る。移行した条件は元が V1・V2 側にあるので控える。
        { name: "orderNo", label: "発注番号（外部）",
          placeholder: "ARC-PO-2025-0123",
          hint: "V1・V2 や紙で出した発注書の番号。検収書の発注番号に出る。V3 で発注書を出したらそちらが優先される" },
        { name: "deliverableOwnership", label: "成果物の帰属先", type: "select",
          options: [{ value: "orderer", label: "発注者（譲渡型）" }, { value: "contractor", label: "受注者（利用許諾型）" }],
          hint: "発注書の明細に出る。業績連動のとき 受注者=利用許諾料／発注者=インセンティブ報酬 として表記される" },
        { name: "regions", label: "地域（許諾範囲）", type: "regions",
          visibleWhen: (v) => v.kind === "license",
          hint: "何も選ばなければ、その次元は無制限（全世界）として扱われます" },
        // 利用形態（A-027）。条件書の行・計算書の製品名はこれで決まる。
        // 作品1点ぶんをまとめて作るなら「許諾セット」「出版セット」のほうが早い。
        { name: "usageType", label: "利用形態（取引モデル）", type: "select",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in",
          required: true,
          options: CONDITION_USAGE_TYPES.map((u) => ({ value: u.value, label: u.label, hint: u.hint })),
          hint: (v) => {
            const t = works.find((w) => String(w.id) === String(v.workId ?? ""))?.title ?? "";
            const made = v.usageType ? conditionNameFor({ workTitle: t, usageType: v.usageType as never,
                                                         sublicensee: v.sublicensee, purpose: v.purpose }) : null;
            return made ? `条件名：${made}` : "取得（IN）の許諾で、この条件がどの使い方の料率かを決める。作品を選ぶと 作品名｜取引モデル の条件名が付く";
          } },
        { name: "sublicensee", label: "再許諾先の名称", required: true, placeholder: "Alpha Games",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.usageType === "sublicense",
          hint: "条件名「作品名｜再許諾（再許諾先／目的）」に入る" },
        { name: "purpose", label: "再許諾の目的", placeholder: "英語版の製造販売",
          visibleWhen: (v) => v.kind === "license" && v.direction === "in" && v.usageType === "sublicense" },
        // 翻訳版の再許諾（A-033）。再許諾先ごとに別途合意が要るかを条件に持たせる。
        { name: "sublicenseConsent", label: "再許諾ごとの別途合意", type: "select",
          visibleWhen: (v) => isSublicensingUsage(v.usageType),
          options: [{ value: "covered", label: "不要（本条件書で許諾済み）" },
                    { value: "required", label: "要（再許諾先ごとに別途合意）" }],
          hint: "出版条件書の翻訳版の欄と本文（第4条）に出る" },
        { name: "languages", label: "言語（許諾範囲）", type: "languages",
          visibleWhen: (v) => v.kind === "license" },
        { name: "notes", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => {
        // 画面は表示名を繋いだ文字列で持っている。保存はコード付きに戻す。
        // 作品の権利包絡との照合はコードで行う（名前だと「日本」「日本国内」が
        // 別物になる）。表に無い語はコード無しのまま入れる。
        const scopes = [
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null })),
        ];
        const ruled = v.kind === "license" && v.direction === "in" && String(v.workId ?? "").trim() !== "";
        return {
          // 作品に紐づく許諾は名前を送らない（サーバが 作品名｜取引モデル で付ける）。
          name: ruled ? "" : text(v.name), direction: v.direction, kind: v.kind,
          sublicensee: ruled ? text(v.sublicensee) : undefined, purpose: ruled ? text(v.purpose) : undefined,
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          autoRenew: v.autoRenew ? true : (text(v.termEnd) ? false : undefined),
          renewMonths: v.autoRenew ? renewMonths(v.renewMonths) : undefined,
          renewStoppedOn: v.autoRenew ? (text(v.renewStoppedOn) ?? null) : undefined,
          currency: v.currency || "JPY", pricingModel: v.pricingModel,
          // 画面は % で受け、保存は ppm（百万分率）。12.5% → 125000
          ratePpm: v.ratePct ? Math.round(Number(v.ratePct) * 10000) : undefined,
          flatAmount: int(v.flatAmount), unitAmount: int(v.unitAmount),
          mgAmount: int(v.mgAmount), agAmount: int(v.agAmount),
          exclusivity: text(v.exclusivity), taxCategory: v.taxCategory,
          usageType: v.kind === "license" ? text(v.usageType) : undefined,
          sublicenseConsent: isSublicensingUsage(v.usageType) ? text(v.sublicenseConsent) : undefined,
          paymentTerms: text(v.paymentTerms), notes: text(v.notes),
          spec: text(v.spec), deliverableOwnership: text(v.deliverableOwnership),
          scopes: scopes.length ? scopes : undefined
        };
      }}
  onDone={onDone}
  onCancel={onCancel}
/>
  );
}
