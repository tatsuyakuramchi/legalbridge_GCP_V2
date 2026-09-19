import { useEffect, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm } from "./CreateForm.js";
import { searchParties } from "./SearchSelect.js";
import { conditionNameFor } from "../server/conditions/naming.js";

/**
 * 出版の条件を作品1点ぶん登録する（紙・電子）。
 *
 * 出版条件書は作品1点＝条件2本（媒体＝紙／電子）を1行に畳んで出す。
 * 2本を条件登録で別々に作ると、片方の媒体を入れ忘れる・作品や相手先が
 * 食い違う、が起きる。ここは1画面で受けて、サーバが1トランザクションで
 * 2本作る（POST /conditions/publishing-set）。
 *
 * 電子の料率を空にすれば紙だけ（条件書の電子欄は「—」）。
 *
 * 翻訳版の再許諾（A-033）もここで一緒に作る。紙・電子で率が違うので
 * 別々の欄。相手先が決まる前に決めるので、再許諾先は空でよい。
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

export interface PublishingSetCreated {
  print: { id: number; conditionNo: string | null } | null;
  digital: { id: number; conditionNo: string | null } | null;
  translationPrint?: { id: number; conditionNo: string | null } | null;
  translationDigital?: { id: number; conditionNo: string | null } | null;
}

/** 翻訳版の別途合意（A-033）。条件書の翻訳版の欄と第4条の書き分けに出る。 */
const CONSENT_OPTIONS = [
  { value: "covered", label: "不要（本条件書で許諾済み）" },
  { value: "required", label: "要（再許諾先ごとに別途合意）" }
];

export function PubConditionSetForm(
  { preset, onDone, onCancel }: {
    preset?: Partial<Record<"counterpartyId" | "workId" | "agreementId" | "matterId", string>>;
    onDone: (created: PublishingSetCreated) => void;
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

  return (
    <CreateForm
      title="出版の条件を登録（紙・電子）"
      submitLabel="紙・電子の条件を登録する"
      path="/conditions/publishing-set"
      initial={{ printExclusivity: "non_exclusive", digitalExclusivity: "non_exclusive",
                 sublicenseExclusivity: "non_exclusive", transConsent: "covered",
                 taxCategory: "taxable", ...preset }}
      fields={[
        { name: "counterpartyId", label: "許諾者（著作権者）", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す",
          hint: "条件書の甲。振込先はこの取引先の口座" },
        { name: "workId", label: "原著作物（作品）／原作を兼ねる作品", type: "search", required: true,
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          hint: (v) => {
            const t = works.find((w) => String(w.id) === String(v.workId ?? ""))?.title ?? "";
            return t ? `条件名：${t}｜紙出版 ／ ${t}｜電子出版（再許諾は 再許諾先／目的 つき）`
                     : "条件書の一覧は作品1点が1行。条件名は 作品名｜紙出版 のように自動で付く";
          } },
        { name: "agreementId", label: "基本契約（合意）", type: "search",
          options: agreements
            .filter((a) => !preset?.counterpartyId
              || String(a.counterparty?.id ?? "") === preset.counterpartyId)
            .map((a) => ({ value: String(a.id), label: a.title,
                           hint: [a.agreementNo, a.counterparty?.name].filter(Boolean).join("／") })),
          hint: "条件書の基本契約番号・自動更新の通知期限はここから出る" },
        { name: "termStart", label: "許諾開始", type: "date" },
        { name: "termEnd", label: "許諾終了", type: "date", hint: "空なら期間の定めなし" },

        { name: "printRate", label: "紙 料率（%）", type: "number", placeholder: "11",
          hint: "税抜定価 × 印税対象部数 × 料率。空なら紙の条件は作らない" },
        { name: "printExclusivity", label: "紙 独占区分", type: "select",
          options: [{ value: "non_exclusive", label: "非独占" }, { value: "exclusive", label: "独占" }],
          visibleWhen: (v) => String(v.printRate ?? "").trim() !== "" },
        { name: "digitalRate", label: "電子 料率（%）", type: "number", placeholder: "15",
          hint: "配信価格 × ダウンロード数 × 料率。空なら電子の条件は作らない（条件書は「—」）" },
        { name: "digitalExclusivity", label: "電子 独占区分", type: "select",
          options: [{ value: "non_exclusive", label: "非独占" }, { value: "exclusive", label: "独占" }],
          visibleWhen: (v) => String(v.digitalRate ?? "").trim() !== "" },
        { name: "transPrintRate", label: "翻訳版再許諾 紙 料率（%）", type: "number", placeholder: "50",
          hint: "乙が第三者に翻訳版を出させたときの取り分。受領する対価（税抜）× 料率。空なら作らない" },
        { name: "transDigitalRate", label: "翻訳版再許諾 電子 料率（%）", type: "number", placeholder: "40",
          hint: "紙と率が違ってよい。空なら電子の翻訳版の条件は作らない" },
        { name: "transConsent", label: "翻訳版 別途合意の要否", type: "select",
          options: CONSENT_OPTIONS,
          visibleWhen: (v) => String(v.transPrintRate ?? "").trim() !== ""
            || String(v.transDigitalRate ?? "").trim() !== "",
          hint: "条件書の翻訳版の欄と第4条に出る。相手先が決まる前でも決めておける" },
        { name: "transSublicensee", label: "翻訳版 再許諾先の名称（決まっていれば）",
          placeholder: "未定なら空",
          visibleWhen: (v) => String(v.transPrintRate ?? "").trim() !== ""
            || String(v.transDigitalRate ?? "").trim() !== "",
          hint: "空なら「翻訳版再許諾（紙）」のような条件名で作る" },
        { name: "sublicenseRate", label: "再許諾 料率（%）", type: "number", placeholder: "50",
          hint: (v) => {
            const t = works.find((w) => String(w.id) === String(v.workId ?? ""))?.title ?? "";
            const made = conditionNameFor({ workTitle: t, usageType: "sublicense", sublicensee: v.sublicensee, purpose: v.purpose });
            return `翻訳出版など、相手に許諾して受け取った額 × 料率。空なら再許諾の条件は作らない${made ? `。条件名：${made}` : ""}`;
          } },
        { name: "sublicensee", label: "再許諾 再許諾先の名称", required: true, placeholder: "海外出版社",
          visibleWhen: (v) => String(v.sublicenseRate ?? "").trim() !== "",
          hint: "条件名「作品名｜再許諾（再許諾先／目的）」に入る" },
        { name: "purpose", label: "再許諾 目的", placeholder: "英語版の翻訳出版",
          visibleWhen: (v) => String(v.sublicenseRate ?? "").trim() !== "" },
        { name: "sublicenseExclusivity", label: "再許諾 独占区分", type: "select",
          options: [{ value: "non_exclusive", label: "非独占" }, { value: "exclusive", label: "独占" }],
          visibleWhen: (v) => String(v.sublicenseRate ?? "").trim() !== "" },

        { name: "taxCategory", label: "税区分", type: "select",
          options: [{ value: "taxable", label: "課税" }, { value: "reduced", label: "軽減" },
                    { value: "exempt", label: "非課税" }] },
        { name: "regions", label: "地域（許諾範囲）", type: "regions",
          hint: "何も選ばなければ全世界" },
        { name: "languages", label: "言語（許諾範囲）", type: "languages",
          hint: "何も選ばなければ日本語として条件書に出る" },
        { name: "notes", label: "備考（条件書の備考欄に出る）", type: "textarea",
          placeholder: "初版100部（見本・献本除く）／著作権表示位置：奥付" }
      ]}
      toPayload={(v) => {
        const scopes = [
          ...parseRegions(v.regions ?? "")
            .map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
          ...parseLanguages(v.languages ?? "")
            .map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
        ];
        const print = rate(v.printRate);
        const digital = rate(v.digitalRate);
        const sub = rate(v.sublicenseRate);
        const transPrint = rate(v.transPrintRate);
        const transDigital = rate(v.transDigitalRate);
        const translation = (r: number) => ({
          ratePct: r, exclusivity: null, consent: v.transConsent || null,
          sublicensee: text(v.transSublicensee) ?? null, purpose: null
        });
        return {
          title: null,
          sublicense: sub === null ? null
            : { ratePct: sub, exclusivity: v.sublicenseExclusivity || null,
                sublicensee: text(v.sublicensee) ?? null, purpose: text(v.purpose) ?? null },
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId), matterId: int(v.matterId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          taxCategory: v.taxCategory, notes: text(v.notes),
          scopes: scopes.length ? scopes : undefined,
          print: print === null ? null : { ratePct: print, exclusivity: v.printExclusivity || null },
          digital: digital === null ? null : { ratePct: digital, exclusivity: v.digitalExclusivity || null },
          translationPrint: transPrint === null ? null : translation(transPrint),
          translationDigital: transDigital === null ? null : translation(transDigital)
        };
      }}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
