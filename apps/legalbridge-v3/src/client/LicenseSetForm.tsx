import { useEffect, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm, type Field } from "./CreateForm.js";
import { searchParties } from "./SearchSelect.js";
import { CONDITION_USAGE_TYPES } from "../server/core/condition-usage.js";
import { conditionNameFor } from "../server/conditions/naming.js";
import { minorUnitHint } from "./ConditionCreateForm.js";

/**
 * 許諾の条件を作品1点ぶん登録する（ゲーム：自社製造・自社販売／再許諾／自社製造・他社販売）。
 *
 * 条件は利用形態ごとに1本（料率1つ）。3本を条件登録で別々に作ると、作品や
 * 相手先・契約が食い違う、利用形態を入れ忘れる、が起きる。ここは1画面で
 * 受けて、サーバが1トランザクションで N 本作る（POST /conditions/license-set）。
 * 料率を空にした利用形態は作らない。個別利用許諾条件書はこの N 本を
 * 取引形態の表に畳んで出す。出版は PubConditionSetForm（紙・電子）。
 */

interface Agreement {
  id: number; agreementNo: string | null; title: string;
  counterparty: { id: number; name: string } | null;
}

const text = (v: unknown) => { const s = String(v ?? "").trim(); return s || undefined; };
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const rate = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/[%％]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const GAME_USAGES = CONDITION_USAGE_TYPES.filter((u) => u.family === "game");

export interface LicenseSetCreated {
  conditions: Array<{ usageType: string; id: number; conditionNo: string | null }>;
}

/** 「1年」「6か月」を月に。空なら1年（12か月）。 */
const renewMonths = (v: unknown) => {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  if (!s) return 12;
  const m = s.match(/^(\d+)(年|か月|ヶ月|カ月)?$/);
  if (!m) return 12;
  const n = Number(m[1]);
  return /年/.test(m[2] ?? "") ? n * 12 : n;
};

export function LicenseSetForm(
  { preset, presetLabels, onDone, onCancel }: {
    preset?: Partial<Record<"counterpartyId" | "workId" | "agreementId" | "matterId", string>>;
    /** 先に入れてある id の見た目（取引先名など）。無ければ id がそのまま出る。 */
    presetLabels?: Record<string, string | null | undefined>;
    onDone: (created: LicenseSetCreated) => void;
    onCancel: () => void;
  }
) {
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
    api.get<{ agreements: Agreement[] }>("/agreements")
      .then((a) => setAgreements(a.agreements)).catch(() => undefined);
  }, []);

  // 条件名は 作品名｜取引モデル で付く（再許諾は 再許諾先／目的 つき）。打たせない。
  const workTitle = (v: Record<string, string>) => works.find((w) => String(w.id) === String(v.workId ?? ""))?.title ?? "";
  const nameHint = (v: Record<string, string>, usage: typeof GAME_USAGES[number]["value"]) => {
    const made = conditionNameFor({ workTitle: workTitle(v), usageType: usage,
                                    sublicensee: v.sublicensee, purpose: v.purpose });
    return made ? `条件名：${made}` : usage === "sublicense" ? "条件名は 作品名｜再許諾（再許諾先／目的）。再許諾先を入れてください" : "作品を選ぶと 作品名｜取引モデル の条件名が付きます";
  };
  // 利用形態ごとに 料率／独占性／MG／AG。料率が空なら、その形態は作らない。
  // 許諾料の扱い（A-048）が「含む」「無償」なら料率は空でもその形態を作る。
  const on = (v: Record<string, string>, usage: string) =>
    String(v[`rate_${usage}`] ?? "").trim() !== "" || ["included", "free"].includes(String(v[`basis_${usage}`] ?? ""));
  const usageFields: Field[] = GAME_USAGES.flatMap((u): Field[] => [
    { name: `rate_${u.value}`, label: `${u.label}：料率（%）`, type: "number", placeholder: "2",
      hint: (v) => `${u.hint}。空ならこの形態の条件は作らない（「含む」「無償」を選べば作る）${on(v, u.value) ? `。${nameHint(v, u.value)}` : ""}` },
    { name: `basis_${u.value}`, label: `${u.label}：許諾料の扱い`, type: "select",
      options: [{ value: "separate", label: "別途（料率・額で定める）" },
                { value: "included", label: "業務委託報酬に含む（追加の許諾料なし）" },
                { value: "free", label: "無償" }],
      hint: "発注書の利用許諾条件の「料率・額」に出る" },
    ...(u.value === "sublicense" ? [
      { name: "sublicensee", label: "再許諾：再許諾先の名称", required: true, placeholder: "Alpha Games",
        visibleWhen: (v) => on(v, "sublicense"),
        hint: "条件名「作品名｜再許諾（再許諾先／目的）」に入る" } as Field,
      { name: "purpose", label: "再許諾：目的", placeholder: "英語版の製造販売",
        visibleWhen: (v) => on(v, "sublicense"),
        hint: "空でもよい。入れると条件名に入る" } as Field
    ] : []),
    { name: `excl_${u.value}`, label: `${u.label}：独占区分`, type: "select",
      options: [{ value: "non_exclusive", label: "非独占" }, { value: "exclusive", label: "独占" }],
      visibleWhen: (v) => on(v, u.value) },
    { name: `mg_${u.value}`, label: `${u.label}：MG 最低保証`, type: "money",
      visibleWhen: (v) => on(v, u.value) && String(v[`basis_${u.value}`] || "separate") === "separate",
      hint: (v) => `毎期独立の下限。${minorUnitHint(v.currency || "JPY")}` },
    { name: `ag_${u.value}`, label: `${u.label}：AG 前払保証`, type: "money",
      visibleWhen: (v) => on(v, u.value) && String(v[`basis_${u.value}`] || "separate") === "separate",
      hint: (v) => `累積で充当する。${minorUnitHint(v.currency || "JPY")}` }
  ]);

  return (
    <CreateForm
      title="許諾の条件を登録（利用形態ごとに1本）"
      submitLabel="利用形態ぶんの条件を登録する"
      path="/conditions/license-set"
      initial={{ currency: "JPY", taxCategory: "taxable",
                 ...Object.fromEntries(GAME_USAGES.map((u) => [`excl_${u.value}`, "non_exclusive"])),
                 ...Object.fromEntries(GAME_USAGES.map((u) => [`basis_${u.value}`, "separate"])),
                 ...preset }}
      fields={[
        { name: "counterpartyId", label: "許諾者（権利者）", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す",
          valueLabel: presetLabels?.counterpartyId ?? null,
          hint: "個別利用許諾条件書の Licensor" },
        { name: "workId", label: "原作（Core Logic）／原作を兼ねる作品", type: "search", required: true,
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          hint: "取得の条件は原作にぶら下げる。原作と同じ名前の自社作品なら、その作品自身を選ぶ（原作を別に登録しない）。条件名は 作品名｜取引モデル で自動で付く" },
        { name: "agreementId", label: "基本契約（合意）", type: "search",
          options: agreements
            .filter((a) => !preset?.counterpartyId
              || String(a.counterparty?.id ?? "") === preset.counterpartyId)
            .map((a) => ({ value: String(a.id), label: a.title,
                           hint: [a.agreementNo, a.counterparty?.name].filter(Boolean).join("／") })),
          hint: "条件書の基本契約名・計算書の契約番号はここから出る" },
        { name: "termStart", label: "許諾開始", type: "date" },
        { name: "termEnd", label: "許諾終了", type: "date", hint: "空なら期間の定めなし" },
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
        ...usageFields,
        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" }] },
        { name: "regions", label: "地域（許諾範囲）", type: "regions",
          hint: "何も選ばなければ全世界。利用形態ぶんの条件すべてに同じ範囲が付く" },
        { name: "languages", label: "言語（許諾範囲）", type: "languages" },
        { name: "notes", label: "備考", type: "textarea" }
      ]}
      toPayload={(v) => {
        const scopes = [
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
        ];
        const rows = GAME_USAGES.flatMap((u) => {
          const basis = v[`basis_${u.value}`] || "separate";
          const r = rate(v[`rate_${u.value}`]) ?? (basis === "separate" ? null : 0);
          return r === null ? [] : [{
            usageType: u.value, ratePct: r, exclusivity: v[`excl_${u.value}`] || null,
            licenseFeeBasis: basis,
            mgAmount: int(v[`mg_${u.value}`]) ?? null, agAmount: int(v[`ag_${u.value}`]) ?? null,
            ...(u.value === "sublicense" ? { sublicensee: text(v.sublicensee) ?? null, purpose: text(v.purpose) ?? null } : {})
          }];
        });
        return {
          title: null,
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId), matterId: int(v.matterId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          autoRenew: v.autoRenew ? true : (text(v.termEnd) ? false : undefined),
          renewMonths: v.autoRenew ? renewMonths(v.renewMonths) : undefined,
          renewStoppedOn: v.autoRenew ? (text(v.renewStoppedOn) ?? null) : undefined,
          currency: v.currency || "JPY", taxCategory: v.taxCategory, notes: text(v.notes),
          scopes: scopes.length ? scopes : undefined,
          rows
        };
      }}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
