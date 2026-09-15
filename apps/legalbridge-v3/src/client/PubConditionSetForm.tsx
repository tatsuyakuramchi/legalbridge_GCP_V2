import { useEffect, useState } from "react";
import { api } from "./api.js";
import { parseLanguages, parseRegions } from "../server/core/rights-scope.js";
import { CreateForm } from "./CreateForm.js";
import { searchParties } from "./SearchSelect.js";

/**
 * 出版の条件を作品1点ぶん登録する（紙・電子）。
 *
 * 出版条件書は作品1点＝条件2本（媒体＝紙／電子）を1行に畳んで出す。
 * 2本を条件登録で別々に作ると、片方の媒体を入れ忘れる・作品や相手先が
 * 食い違う、が起きる。ここは1画面で受けて、サーバが1トランザクションで
 * 2本作る（POST /conditions/publishing-set）。
 *
 * 電子の料率を空にすれば紙だけ（条件書の電子欄は「—」）。
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
}

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
                 taxCategory: "taxable", ...preset }}
      fields={[
        { name: "counterpartyId", label: "許諾者（著作権者）", type: "search", required: true,
          search: searchParties, placeholder: "取引先名・コードで探す",
          hint: "条件書の甲。振込先はこの取引先の口座" },
        { name: "workId", label: "原著作物（作品）", type: "search",
          options: works.map((w) => ({ value: String(w.id), label: w.title })),
          hint: "条件書の一覧は作品1点が1行。作品に付けないと同じ作品の紙・電子を1行にまとめられない" },
        { name: "title", label: "対象出版物名", required: true,
          placeholder: "◯◯（単行本） / ◯◯ 第1巻",
          hint: "条件名になる。作品名と違うときだけ条件書の行に2段で出る" },
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
        return {
          title: text(v.title),
          counterpartyId: int(v.counterpartyId), workId: int(v.workId),
          agreementId: int(v.agreementId), matterId: int(v.matterId),
          termStart: text(v.termStart), termEnd: text(v.termEnd),
          taxCategory: v.taxCategory, notes: text(v.notes),
          scopes: scopes.length ? scopes : undefined,
          print: print === null ? null : { ratePct: print, exclusivity: v.printExclusivity || null },
          digital: digital === null ? null : { ratePct: digital, exclusivity: v.digitalExclusivity || null }
        };
      }}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
