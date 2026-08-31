import { useMemo, useState } from "react";
import type { DocumentFormData } from "../types";
import { useToast } from "./Toast";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import {
  LANGUAGE_PRESETS, REGION_PRESETS, V3_FIXED_DEALS, buildLicenseTermsSeed,
  emptyIntakeMaterial, materialCreatePayload, materialFromDocument,
  rightsSourceCreatePayload, type IntakeMaterial
} from "./work-intake";

// 作品登録（作品＋素材＋イン条件）。承認済みモック（2026-08-31）の実装。
// ここを起点に個別利用許諾条件書（アウト文書）を作成する：
//   作品登録＋イン条件 → 条件書（素材と料率がマトリクスへ自動展開） → 利用許諾計算。
// アウト条件が決まったら作品詳細の「アウト条件」から随時追記する（既存機能）。

const MATERIAL_TYPES = [
  ["game_design", "ゲームデザイン"], ["illustration", "イラスト"], ["scenario", "シナリオ"],
  ["manuscript", "原稿"], ["other", "その他"]
] as const;
const MATERIAL_ROLES = [["core_logic", "中核（コアロジック）"], ["sub_component", "従属（構成部品）"]] as const;
const ACQUISITIONS = [
  ["license", "ライセンス（イン条件あり）"], ["buyout_commission", "買切・委託"], ["in_house", "自社制作"]
] as const;

type DocHit = {
  id: number; documentNumber: string; templateType: string; title: string; counterparty: string;
};

export function WorkIntake({ canRegister, onOpenWork, onCreateLicenseTerms }: {
  canRegister: boolean;
  onOpenWork?: (workId: number) => void;
  onCreateLicenseTerms: (seed: DocumentFormData, workCode: string | null) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [kindChoice, setKindChoice] = useState<"licensed_in" | "own" | "co_dev">("licensed_in");
  const [holder, setHolder] = useState<{ id: number | null; label: string }>({ id: null, label: "" });
  const [parentWorkId, setParentWorkId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [materials, setMaterials] = useState<IntakeMaterial[]>([]);
  const [busy, setBusy] = useState(false);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docQuery, setDocQuery] = useState("");
  const [docHits, setDocHits] = useState<DocHit[]>([]);
  const [docLoading, setDocLoading] = useState(false);

  const replace = (index: number, patch: Partial<IntakeMaterial>) =>
    setMaterials((current) => current.map((m, i) => i === index ? { ...m, ...patch } : m));
  const remove = (index: number) => setMaterials((current) => current.filter((_, i) => i !== index));
  const addBlank = () => setMaterials((current) => [...current, emptyIntakeMaterial(holder.label, holder.id)]);

  async function searchDocuments(query: string) {
    setDocQuery(query);
    if (!query.trim()) { setDocHits([]); return; }
    setDocLoading(true);
    try {
      const response = await fetch(`/api/v2/master-data/search?type=document&q=${encodeURIComponent(query)}`);
      if (!response.ok) { setDocHits([]); return; }
      const result = await response.json();
      setDocHits((result.items ?? []).map((item: { values?: Record<string, unknown> }) => {
        const values = item.values ?? {};
        return {
          id: Number(values.id),
          documentNumber: String(values.document_number ?? ""),
          templateType: String(values.template_type ?? ""),
          title: String(values.CONTRACT_TITLE ?? values.基本契約名 ?? values.PROJECT_TITLE ?? values.title ?? ""),
          counterparty: String(values.vendor_name ?? values.counterparty ?? "")
        };
      }).filter((hit: DocHit) => Number.isFinite(hit.id) && hit.documentNumber));
    } catch { setDocHits([]); }
    finally { setDocLoading(false); }
  }

  function addFromDocument(hit: DocHit) {
    setMaterials((current) => [...current, materialFromDocument(hit)]);
    setDocSearchOpen(false); setDocQuery(""); setDocHits([]);
    toast.push(`${hit.documentNumber} から素材を引用しました（権利者・取得形態・根拠文書を自動設定）`, "success");
  }

  const rateOf = (value: string) => {
    const parsed = Number.parseFloat(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
  };
  const named = useMemo(() => materials.filter((m) => m.name.trim()), [materials]);
  const sums = useMemo(() => ({
    r1: named.reduce((s, m) => s + (m.royalty ? (rateOf(m.r1) ?? 0) : 0), 0),
    r3: named.reduce((s, m) => s + (m.royalty ? (rateOf(m.r3) ?? 0) : 0), 0)
  }), [named]);

  async function submit(createTerms: boolean) {
    if (!title.trim()) { toast.push("作品名を入力してください", "error"); return; }
    if (createTerms && !named.some((m) => m.royalty)) {
      toast.push("条件書を作成するには、ロイヤリティ対象の素材を1件以上入れてください（イン条件が空の条件書になるため）", "error");
      return;
    }
    setBusy(true);
    try {
      const workResponse = await fetch("/api/v2/works", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          kind: kindChoice === "own" ? "own" : "licensed_in",
          ...(kindChoice === "own" ? { isOriginal: true } : {}),
          ...(kindChoice === "co_dev" ? { derivationType: "co_development" } : {}),
          ...(holder.id ? { rightsHolderVendorId: holder.id } : {}),
          ...(parentWorkId ? { parentWorkId: Number(parentWorkId) } : {}),
          ...(remarks.trim() ? { remarks: remarks.trim() } : {})
        })
      });
      const work = await workResponse.json().catch(() => ({}));
      if (!workResponse.ok) {
        toast.push(work.error ?? "作品を登録できませんでした", "error");
        return;
      }
      const workId = Number(work.id);
      const workCode: string | null = work.workCode ?? null;

      // 素材を順に登録（コードはサーバ採番）。権利ソース（根拠文書）は best-effort。
      const saved: Array<{ material: IntakeMaterial; materialCode: string | null }> = [];
      const failed: string[] = [];
      let rightsFailed = 0;
      for (const [index, material] of named.entries()) {
        const response = await fetch("/api/v2/materials", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(materialCreatePayload(workId, material, index === 0))
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { failed.push(material.name.trim()); continue; }
        saved.push({ material, materialCode: body.materialCode ?? null });
        const rightsPayload = rightsSourceCreatePayload(Number(body.id), material);
        if (rightsPayload) {
          const rightsResponse = await fetch("/api/v2/rights-sources", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rightsPayload)
          }).catch(() => null);
          if (!rightsResponse?.ok) rightsFailed += 1;
        }
      }
      const summary = `作品 ${workCode ?? `#${workId}`} と素材${saved.length}件を登録しました`
        + (failed.length ? `（素材の失敗: ${failed.join("、")}）` : "")
        + (rightsFailed ? `（根拠文書の紐づけ失敗: ${rightsFailed}件 — 作品詳細から追加できます）` : "");
      toast.push(summary, failed.length ? "info" : "success");

      if (createTerms) {
        onCreateLicenseTerms(
          buildLicenseTermsSeed({ workCode, title: title.trim(), holderLabel: holder.label }, saved),
          workCode);
      } else {
        onOpenWork?.(workId);
      }
    } catch {
      toast.push("通信に失敗しました。", "error");
    } finally { setBusy(false); }
  }

  if (!canRegister) {
    return <section className="page"><div className="page-title"><div>
      <p>WORK INTAKE</p><h1>作品登録</h1>
      <small>作品・素材の書込権限（works / materials）が無効のため利用できません。</small>
    </div></div></section>;
  }

  return <section className="page work-intake">
    <div className="page-title"><div>
      <p>WORK INTAKE</p>
      <h1>作品登録（イン条件つき）</h1>
      <small>作品と素材（構成要素）を登録し、権利元から許諾を受ける条件（イン条件）まで入力します。ここを起点に個別利用許諾条件書を作成します。アウト条件は確定し次第、作品詳細から追記します。</small>
    </div></div>

    <div className="panel wi-card">
      <div className="wi-head"><span className="wi-step">①</span><h2>作品基本情報</h2><small>作品台帳（works）に登録・台帳コードは自動採番</small></div>
      <div className="wi-grid">
        <label className="wi-span2">作品名 *<input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="例: コラボボードゲーム（仮）" maxLength={1000} /></label>
        <label>作品種別
          <select value={kindChoice} onChange={(e) => setKindChoice(e.target.value as typeof kindChoice)}>
            <option value="licensed_in">ライセンスイン（他社原作）</option>
            <option value="own">自社オリジナル</option>
            <option value="co_dev">共同開発</option>
          </select></label>
        <SearchableLedgerSelect type="vendors" value={holder.id != null ? String(holder.id) : ""}
          label="主権利者（取引先マスタ）" placeholder="名称で検索…"
          onChange={(value, item) => setHolder({ id: value ? Number(value) : null, label: item?.title ?? "" })} />
        <SearchableLedgerSelect type="works" value={parentWorkId}
          label="原作（派生元・任意）" placeholder="作品名・台帳コードで検索…"
          helper="この作品が別の登録済み作品の派生ならその原作"
          onChange={(value) => setParentWorkId(value)} />
        <label className="wi-span2">備考（社内メモ）<textarea rows={2} value={remarks}
          onChange={(e) => setRemarks(e.target.value)} maxLength={4000} /></label>
      </div>
    </div>

    <div className="panel wi-card">
      <div className="wi-head"><span className="wi-step">②</span><h2>素材（構成要素）</h2><small>条件書のマトリクス行になります。コードは登録時に自動採番</small></div>
      {materials.map((material, index) => <article className="wi-mat" key={index}>
        <div className="wi-mat-head">
          <strong>素材{index + 1}</strong>
          {material.sourceDocNumber && <span className="wi-quote">引用: {material.sourceDocNumber}</span>}
          <span className="wi-spacer"></span>
          <label className="wi-check"><input type="checkbox" checked={material.royalty}
            onChange={(e) => replace(index, { royalty: e.target.checked })} />ロイヤリティ対象（イン条件を入力）</label>
          <button type="button" className="link-button" onClick={() => remove(index)}>削除</button>
        </div>
        <div className="wi-grid">
          <label className="wi-span2">素材名 *<input value={material.name}
            onChange={(e) => replace(index, { name: e.target.value })} maxLength={300} /></label>
          <label>素材区分<select value={material.materialType}
            onChange={(e) => replace(index, { materialType: e.target.value })}>
            {MATERIAL_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>役割<select value={material.materialRole}
            onChange={(e) => replace(index, { materialRole: e.target.value })}>
            {MATERIAL_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label>取得形態<select value={material.acquisitionType}
            onChange={(e) => replace(index, { acquisitionType: e.target.value })}>
            {ACQUISITIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <SearchableLedgerSelect type="vendors" value={material.holderVendorId != null ? String(material.holderVendorId) : ""}
            label="権利元（取引先マスタ）" placeholder={holder.label ? `既定: ${holder.label}` : "名称で検索…"}
            onChange={(value, item) => replace(index, {
              holderVendorId: value ? Number(value) : null, holderLabel: item?.title ?? material.holderLabel })} />
          <label>許諾地域（上限枠）<input list="wi-regions" value={material.region}
            onChange={(e) => replace(index, { region: e.target.value })} /></label>
          <label>許諾言語（上限枠）<input list="wi-langs" value={material.language}
            onChange={(e) => replace(index, { language: e.target.value })} /></label>
        </div>
        {material.royalty && <div className="wi-incond">
          <div className="wi-incond-head"><strong>イン条件（この素材について許諾を受ける条件）</strong>
            <small>＝権利元へ支払う料率。条件書の加算料率の内訳になります</small></div>
          <div className="wi-grid">
            <label className="wi-span2">根拠文書（任意・未締結なら空のまま）
              <input value={material.sourceDocNumber} readOnly={material.sourceDocId != null}
                placeholder="「既存の契約書から引用して追加」で紐づくか、番号を控えとして記入"
                onChange={(e) => replace(index, { sourceDocNumber: e.target.value })} /></label>
            <label>MG（ミニマム）<input inputMode="numeric" className="wi-num" value={material.mg}
              onChange={(e) => replace(index, { mg: e.target.value })} /></label>
            <label>AG（アドバンス）<input inputMode="numeric" className="wi-num" value={material.ag}
              onChange={(e) => replace(index, { ag: e.target.value })} /></label>
            <label>通貨<select value={material.cur} onChange={(e) => replace(index, { cur: e.target.value })}>
              {["JPY", "USD", "EUR"].map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          <table className="wi-rates">
            <thead><tr><th>取引形態（固定3種）</th><th>計算モデル</th><th className="r">この素材の料率</th></tr></thead>
            <tbody>
              {V3_FIXED_DEALS.map((deal) => {
                const key = (`r${deal.id}`) as "r1" | "r2" | "r3";
                return <tr key={deal.id}>
                  <td className="wi-deal">{deal.id === 1 ? "①" : deal.id === 2 ? "②" : "③"} {deal.name}
                    {deal.addon && <span className="wi-addon">加算型</span>}</td>
                  <td className="wi-model">{deal.basePrice}{deal.addon ? " × 料率" : " × 実効料率"}</td>
                  <td className="r"><span className="wi-rate"><input inputMode="decimal" className="wi-num"
                    value={material[key]} onChange={(e) => replace(index, { [key]: e.target.value } as Partial<IntakeMaterial>)} />%</span></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>}
        {!material.royalty && <p className="wi-hint">ロイヤリティ対象外（買切・自社制作など）。条件書には行として載りますが料率は持ちません。</p>}
      </article>)}
      <div className="wi-add-row">
        <button type="button" className="wi-add" onClick={addBlank}>＋ 素材を追加</button>
        <button type="button" className="wi-add" onClick={() => setDocSearchOpen((v) => !v)}>🔍 既存の契約書から引用して追加</button>
      </div>
      {docSearchOpen && <div className="wi-docsearch">
        <label>契約書・文書を検索（発注書・利用許諾条件書・基本契約など全文書）
          <input autoFocus value={docQuery} onChange={(e) => void searchDocuments(e.target.value)}
            placeholder="文書番号・件名・取引先名で検索…" /></label>
        <div className="wi-dochits">
          {docLoading && <small className="wi-hint">検索しています…</small>}
          {!docLoading && docQuery.trim() !== "" && !docHits.length && <small className="wi-hint">該当する文書がありません。</small>}
          {docHits.map((hit) => <button type="button" key={hit.id} onClick={() => addFromDocument(hit)}>
            <strong>{hit.documentNumber}</strong>
            <span>{hit.title || hit.templateType}</span>
            <small>{hit.counterparty}</small>
          </button>)}
        </div>
        <small className="wi-hint">選ぶと素材行が追加され、素材名・権利者・取得形態（発注書＝買切・委託／利用許諾＝ライセンス）・根拠文書が引用されます。</small>
      </div>}
      <datalist id="wi-regions">{REGION_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
      <datalist id="wi-langs">{LANGUAGE_PRESETS.map((l) => <option key={l} value={l} />)}</datalist>
    </div>

    {named.length > 0 && <div className="panel wi-card">
      <div className="wi-head"><span className="wi-step">③</span><h2>条件書マトリクスのプレビュー</h2><small>個別利用許諾条件書に自動展開される内容</small></div>
      <div className="table-scroll"><table className="wi-preview">
        <thead><tr><th>構成要素</th><th>権利元</th><th>許諾地域</th><th>許諾言語</th>
          <th className="r">① 自社製造・自社販売</th><th className="r">② 権利許諾</th><th className="r">③ 自社製造・他社販売</th></tr></thead>
        <tbody>
          {named.map((m, i) => <tr key={i}>
            <td>{m.name}</td><td>{m.holderLabel || "—"}</td><td>{m.region}</td><td>{m.language}</td>
            <td className="r">{m.royalty && rateOf(m.r1) != null ? `${rateOf(m.r1)}%` : "—"}</td>
            <td className="r">{m.royalty && rateOf(m.r2) != null ? `${rateOf(m.r2)}%` : "—"}</td>
            <td className="r">{m.royalty && rateOf(m.r3) != null ? `${rateOf(m.r3)}%` : "—"}</td>
          </tr>)}
          <tr className="wi-sum"><td colSpan={4}>適用料率（加算型はΣ）</td>
            <td className="r">Σ {+sums.r1.toFixed(2)}%</td><td className="r">条件書で確定</td>
            <td className="r">Σ {+sums.r3.toFixed(2)}%</td></tr>
        </tbody>
      </table></div>
    </div>}

    <div className="wi-actions">
      <span>保存すると作品＋素材＋根拠文書の紐づけが台帳に登録されます。料率・MG/AG は条件書に展開され、確定時に条件台帳へ同期されます。</span>
      <button type="button" disabled={busy || !title.trim()} onClick={() => void submit(false)}>
        {busy ? "処理中…" : "登録のみ（条件書はあとで）"}</button>
      <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void submit(true)}>
        {busy ? "処理中…" : "登録して個別利用許諾条件書を作成 →"}</button>
    </div>
  </section>;
}
