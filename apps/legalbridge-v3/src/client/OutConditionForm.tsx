import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm } from "./CreateForm.js";
import { searchParties } from "./SearchSelect.js";
import { minorUnitHint } from "./ConditionCreateForm.js";
import { outConditionNameFor } from "../server/conditions/naming.js";
import { PAYMENT_TERMS_PRESETS_EN, PAYMENT_TERMS_PRESETS_JA } from "../server/conditions/payment-terms.js";

/**
 * 許諾先（OUT 条件）の登録。
 *
 * OUT 条件が要るのは、イン条件の実績が「再許諾」か「自社製造・他社販売」の
 * ときだけ。以前は汎用の条件登録で向きを OUT に切り替えて作っており、納期・
 * 仕様・発注番号など発注（IN）向けの欄が 20 以上並ぶうえ、OUT では取引形態を
 * 選べず、条件名が計算書の製品名になることも画面から読めなかった。
 *
 * ここは OUT 専用の小さいフォーム。向き＝out・種類＝license は固定で、
 * 取引形態（usage_type）を条件に持たせる。実績入力で取り違え（再許諾の実績に
 * 他社販売の許諾を選ぶ）を弾くのに使う。
 *
 * 作品画面・イン条件の詳細・実績入力の3か所から開く。どこから開いても同じ形。
 */

export type OutUsage = "sublicense" | "oem";

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };

export function OutConditionForm(
  { preset, presetLabels, onDone, onCancel }: {
    /**
     * 分かっている値。実績入力なら作品・取引形態・通貨、イン条件からなら
     * 地域・言語（イン条件の許諾範囲を初期値にする）も渡す。
     */
    preset?: Partial<Record<"usageType" | "workId" | "counterpartyId" | "agreementId" | "currency"
                             | "regions" | "languages" | "name", string>>;
    presetLabels?: Partial<Record<"workId" | "counterpartyId" | "agreementId", string | null>>;
    onDone: (created: { id: number; conditionNo: string | null }) => void;
    onCancel: () => void;
  }
) {
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [agreements, setAgreements] = useState<Agreement[] | null>(null);
  const [partyFor, setPartyFor] = useState("");
  /** 引き継いだ相手先の表示名。引き継ぎ元が名前を知らないと「#12」と出るので引いて埋める。 */
  const [partyLabel, setPartyLabel] = useState<string | null>(null);
  /**
   * フォームの値を後から書き換える口。相手先の名前・居住区分は選んだあとに
   * 引きに行くので、届いた時点でフォームに入れる。
   */
  const setRef = useRef<((name: string, value: string) => void) | null>(null);
  /** 最後に自動で入れた製品名。人が書き換えたら、以後は上書きしない。 */
  const autoName = useRef("");
  /** いまの入力値。引いてきた値で、人が入れたものを上書きしないために見る。 */
  const valuesRef = useRef<Record<string, string>>({});
  /** 税込に合わせた相手先。同じ相手で人が課税に戻したら、もう一度は変えない。 */
  const taxFor = useRef("");

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => { setWorks(w.works); setRef.current?.("_worksLoaded", "1"); })
      .catch(() => undefined);
  }, []);

  // 相手先を選んだら、名前（製品名に入れる）・居住区分・締結済み契約を引く。
  useEffect(() => {
    if (!partyFor) { setAgreements(null); return; }
    let live = true;
    api.get<{ name: string; residency?: string }>(`/parties/${partyFor}`)
      .then((p) => {
        if (!live) return;
        setRef.current?.("_partyName", p.name ?? "");
        if (partyFor === String(preset?.counterpartyId ?? "")) setPartyLabel(p.name ?? null);
        // 海外の相手は税込（内税）で報告が来る。初期値のままなら合わせる。
        setRef.current?.("_nonResident", p.residency === "non_resident" ? "1" : "");
      })
      .catch(() => undefined);
    api.get<{ agreements: Agreement[] }>(`/parties/${partyFor}/agreements`)
      .then((r) => {
        if (!live) return;
        setAgreements(r.agreements);
        if (r.agreements.length === 1 && !valuesRef.current.agreementId) {
          setRef.current?.("agreementId", String(r.agreements[0]!.id));
        }
      })
      .catch(() => { if (live) setAgreements([]); });
    return () => { live = false; };
  }, [partyFor]);

  const workTitle = (v: Record<string, string>) =>
    works.find((w) => String(w.id) === String(v.workId ?? ""))?.title
      ?? (String(v.workId ?? "") === String(preset?.workId ?? "") ? presetLabels?.workId ?? "" : "");

  return (
    <CreateForm
      title="許諾先（OUT）の登録"
      path="/conditions"
      submitLabel="許諾先を登録"
      initial={{ usageType: "sublicense", pricingSub: "revenue_rate", pricingOem: "unit_rate",
                 currency: "JPY", taxCategory: "taxable", ...preset }}
      onValues={(v, set) => {
        setRef.current = set;
        valuesRef.current = v;
        const party = String(v.counterpartyId ?? "");
        if (party !== partyFor) {
          // 相手先を選び直したら、前の相手の契約は外す（開いた直後の初期値は残す）。
          if (partyFor && v.agreementId) set("agreementId", "");
          if (!party) set("_partyName", "");
          setPartyFor(party);
          return;
        }
        if (v._nonResident === "1" && v.taxCategory === "taxable" && taxFor.current !== party) {
          taxFor.current = party;
          set("taxCategory", "included");
        }
        // 製品名の初期値：作品名｜許諾言語｜許諾地域｜相手先名。
        const made = outConditionNameFor({
          workTitle: workTitle(v), languages: v.languages, regions: v.regions, partyName: v._partyName
        });
        const current = String(v.name ?? "");
        if (made && made !== current && (!current.trim() || current === autoName.current)) {
          autoName.current = made;
          set("name", made);
        }
      }}
      fields={[
        { name: "usageType", label: "取引形態", type: "select", required: true,
          options: [{ value: "sublicense", label: "再許諾" }, { value: "oem", label: "自社製造・他社販売" }],
          hint: (v) => v.usageType === "oem"
            ? "自社で作って相手が売る。相手から受け取る卸単価 × 製造個数が算定の基礎"
            : "相手に許諾して、相手から受け取った額が算定の基礎" },
        { name: "counterpartyId", label: (v) => v.usageType === "oem" ? "販売先" : "再許諾先",
          type: "search", required: true, search: searchParties, placeholder: "取引先名・コードで探す",
          valueLabel: presetLabels?.counterpartyId ?? partyLabel },
        { name: "workId", label: "作品", type: "search", required: true,
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          valueLabel: presetLabels?.workId ?? null },
        { name: "languages", label: "許諾言語", type: "languages" },
        { name: "regions", label: "許諾地域", type: "regions",
          hint: "何も選ばなければ無制限（全世界）として扱う" },
        { name: "name", label: "製品名（条件名）", required: true,
          hint: "利用許諾料計算書の「製品名」にそのまま出る。初期値は 作品名｜許諾言語｜許諾地域｜相手先名" },

        { name: "pricingSub", label: "受け取り方", type: "select", required: true,
          visibleWhen: (v) => v.usageType !== "oem",
          options: [{ value: "revenue_rate", label: "料率（相手の売上 × %）" },
                    { value: "fixed", label: "定額" },
                    { value: "none", label: "受領額を実績でそのまま入れる" }] },
        { name: "pricingOem", label: "受け取り方", type: "select", required: true,
          visibleWhen: (v) => v.usageType === "oem",
          options: [{ value: "unit_rate", label: "卸単価（1個あたり）" },
                    { value: "none", label: "受領額を実績でそのまま入れる" }],
          hint: "卸単価を入れておくと、実績入力で受領価格の欄に自動で入る" },
        { name: "ratePct", label: "料率（%）", type: "number", required: true, placeholder: "10",
          visibleWhen: (v) => v.usageType !== "oem" && v.pricingSub === "revenue_rate" },
        { name: "flatAmount", label: "定額（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.usageType !== "oem" && v.pricingSub === "fixed",
          hint: (v) => minorUnitHint(v.currency) },
        { name: "unitAmount", label: "卸単価（最小通貨単位）", type: "money", required: true,
          visibleWhen: (v) => v.usageType === "oem" && v.pricingOem === "unit_rate",
          hint: (v) => minorUnitHint(v.currency) },
        { name: "currency", label: "通貨", type: "select", required: true,
          options: [{ value: "JPY", label: "JPY 円" }, { value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }] },
        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "exempt", label: "非課税" },
                    { value: "included", label: "税込（海外・内税）" }],
          hint: (v) => v._nonResident === "1" ? "海外の相手なので 税込（内税）にしました" : "" },
        { name: "agreementId", label: "契約（合意）", type: "search",
          options: (agreements ?? []).map((a) => ({ value: String(a.id), label: a.title, hint: a.agreementNo })),
          valueLabel: presetLabels?.agreementId ?? null,
          hint: () => !partyFor ? "相手先を選ぶと、その相手の締結済み契約を当てます"
            : agreements === null ? "契約を引いています…"
            : agreements.length === 0 ? "この相手には締結済みの契約がありません（契約なしで登録できます）"
            : agreements.length > 1 ? `締結済みの契約が ${agreements.length} 本あります。どれの下に置くか選んでください`
            : "計算書の契約名・契約番号はここから出る" },

        { name: "more", label: "詳細も入れる（期間・MG/AG・独占性・支払条件・備考）", type: "checkbox" },
        { name: "termStart", label: "開始", type: "date", visibleWhen: (v) => v.more === "1" },
        { name: "termEnd", label: "終了", type: "date", visibleWhen: (v) => v.more === "1" },
        { name: "mgAmount", label: "MG 最低保証", type: "money", visibleWhen: (v) => v.more === "1",
          hint: (v) => `毎期独立の下限。${minorUnitHint(v.currency)}` },
        { name: "agAmount", label: "AG 前払保証", type: "money", visibleWhen: (v) => v.more === "1",
          hint: (v) => `累積で充当する。${minorUnitHint(v.currency)}` },
        { name: "exclusivity", label: "独占性", type: "select", visibleWhen: (v) => v.more === "1",
          options: [{ value: "exclusive", label: "独占" }, { value: "non_exclusive", label: "非独占" }] },
        { name: "paymentTerms", label: "支払条件", visibleWhen: (v) => v.more === "1",
          suggestions: [...PAYMENT_TERMS_PRESETS_JA, ...PAYMENT_TERMS_PRESETS_EN] },
        { name: "notes", label: "備考", type: "textarea", visibleWhen: (v) => v.more === "1" }
      ]}
      toPayload={(v) => {
        const oem = v.usageType === "oem";
        const pricingModel = oem ? (v.pricingOem || "unit_rate") : (v.pricingSub || "revenue_rate");
        const more = v.more === "1";
        const scopes = [
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null })),
        ];
        return {
          direction: "out", kind: "license", usageType: oem ? "oem" : "sublicense",
          name: text(v.name), counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId),
          currency: v.currency || "JPY", taxCategory: v.taxCategory || "taxable", pricingModel,
          ratePpm: pricingModel === "revenue_rate" && v.ratePct ? Math.round(Number(v.ratePct) * 10000) : undefined,
          flatAmount: pricingModel === "fixed" ? int(v.flatAmount) : undefined,
          unitAmount: pricingModel === "unit_rate" ? int(v.unitAmount) : undefined,
          termStart: more ? text(v.termStart) : undefined, termEnd: more ? text(v.termEnd) : undefined,
          mgAmount: more ? int(v.mgAmount) : undefined, agAmount: more ? int(v.agAmount) : undefined,
          exclusivity: more ? text(v.exclusivity) : undefined,
          paymentTerms: more ? text(v.paymentTerms) : undefined, notes: more ? text(v.notes) : undefined,
          scopes: scopes.length ? scopes : undefined
        };
      }}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
