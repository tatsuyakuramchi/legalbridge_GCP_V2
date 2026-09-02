import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentFormData } from "../types";
import { useToast } from "./Toast";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import {
  BUSINESS_LINE_OPTIONS, INTAKE_DOC_KINDS, buildLicenseTermsSeed, businessLineLabel,
  emptyIntakeMaterial, planDocumentUploads,
  type BusinessLine, type IntakeMaterial, type WorkDocumentChoice
} from "./work-intake";
import { WorkDocumentLauncher } from "./WorkDocumentLauncher";

// 作品の登録・編集（2026-09-02 再構築・承認済みモック準拠）。
// 1画面の縦ステッパーで「①基本情報 → ②原作 → ③素材 → ④既存文書 → ⑤確認」を
// 順に埋めると完成する。原作＝コアロジック素材（作品につき1件・必須）。
// 条件（料率・MG/AG・地域言語）はこの画面では扱わず、登録後に文書作成
// （個別条件書・発注書）または過去文書の取込で入力する。
// editWorkId を渡すと同じ画面が編集モードになる（全ステップ展開＋保存バー）。

const MATERIAL_TYPES = [
  ["game_design", "ゲームデザイン"], ["illustration", "イラスト"], ["scenario", "シナリオ"],
  ["manuscript", "原稿"], ["other", "その他"]
] as const;

type KindChoice = "own" | "licensed_in" | "co_dev";

type DocHit = { id: number; documentNumber: string; templateType: string; title: string; counterparty: string };

type CoreRow = {
  materialId: number | null;
  name: string;
  vendorId: number | null;
  vendorLabel: string;
  quoteDocId: number | null;
  quoteDocNumber: string;
};

type MatRow = {
  materialId: number | null;   // null = 新規行
  name: string;
  materialType: string;
  rights: "license" | "owned"; // 許諾を受けて使用 / 買取・自社保有
  vendorId: number | null;
  vendorLabel: string;
  quoteDocId: number | null;
  quoteDocNumber: string;
  dirty: boolean;              // 既存行の変更検知（PATCH の要否）
};

// 作品に紐づく既存文書（GET /works/:id/documents）。編集モードで
// 「未登録の過去文書がないか」を確認し、条件明細の登録へ直行する入口になる。
type WorkDoc = {
  id: number; documentNumber: string | null; templateType: string | null;
  templateVersionId: number | null; title: string | null; counterparty: string | null;
  supersededBy: string | null; conditionCount: number;
};

const DOC_KIND_LABELS: Record<string, string> = {
  ...Object.fromEntries(INTAKE_DOC_KINDS.map((k) => [k.value, k.label])),
  individual_license_terms_v3: "個別利用許諾条件書",
  royalty_statement: "利用許諾料計算書",
  inspection_certificate: "検収書"
};

type DocSeries = {
  key: number;
  files: File[];               // [初版, 巻き直し…] 最後が有効版
  templateType: string;
  docNumber: string;
  vendorId: number | null;
  vendorLabel: string;
  date: string;
};

const emptyCore = (): CoreRow =>
  ({ materialId: null, name: "", vendorId: null, vendorLabel: "", quoteDocId: null, quoteDocNumber: "" });
const emptyMat = (): MatRow => ({
  materialId: null, name: "", materialType: "illustration", rights: "owned",
  vendorId: null, vendorLabel: "", quoteDocId: null, quoteDocNumber: "", dirty: false
});

// 既存契約書（発注書・利用許諾・取込文書すべて）からの引用検索。
function DocQuotePicker({ note, quoteNumber, onPick }: {
  note: string;
  quoteNumber: string;
  onPick: (hit: DocHit | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [loading, setLoading] = useState(false);

  async function search(q: string) {
    setQuery(q);
    if (!q.trim()) { setHits([]); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/v2/master-data/search?type=document&q=${encodeURIComponent(q)}`);
      if (!response.ok) { setHits([]); return; }
      const result = await response.json();
      setHits((result.items ?? []).map((item: { values?: Record<string, unknown> }) => {
        const values = item.values ?? {};
        return {
          id: Number(values.id),
          documentNumber: String(values.document_number ?? ""),
          templateType: String(values.template_type ?? ""),
          title: String(values.CONTRACT_TITLE ?? values.基本契約名 ?? values.PROJECT_TITLE ?? values.title ?? ""),
          counterparty: String(values.vendor_name ?? values.counterparty ?? "")
        };
      }).filter((hit: DocHit) => Number.isFinite(hit.id) && hit.documentNumber));
    } catch { setHits([]); }
    finally { setLoading(false); }
  }

  if (quoteNumber) {
    return <div className="wz-quote">
      <span className="wz-quote-chip">引用元: {quoteNumber}
        <button type="button" onClick={() => onPick(null)} title="引用を解除">×</button></span>
    </div>;
  }
  return <div className="wz-quote">
    {!open && <button type="button" className="link-button" onClick={() => setOpen(true)}>🔍 {note}</button>}
    {open && <>
      <input autoFocus value={query} onChange={(e) => void search(e.target.value)}
        placeholder="文書番号・件名・相手先で検索…" />
      <div className="wz-quote-hits">
        {loading && <small>検索しています…</small>}
        {!loading && query.trim() !== "" && !hits.length && <small>該当する文書がありません。</small>}
        {hits.slice(0, 8).map((hit) => <button type="button" key={hit.id}
          onClick={() => { onPick(hit); setOpen(false); setQuery(""); setHits([]); }}>
          <strong>{hit.documentNumber}</strong>
          <span>{hit.title || hit.templateType}</span>
          <small>{hit.counterparty}</small>
        </button>)}
      </div>
    </>}
  </div>;
}

export function WorkIntake({ canRegister, editWorkId = null, onOpenWork, onCreateLicenseTerms, onCreateDocumentFromWork, onOpenImport, onRegisterDocDetails }: {
  canRegister: boolean;
  editWorkId?: number | null;
  onOpenWork?: (workId: number) => void;
  onCreateLicenseTerms: (seed: DocumentFormData, workCode: string | null) => void;
  // 出版個別条件書・出版基本契約・発注書を作品から起こす（初期値は App 側で取引先・作品を差し込む）。
  onCreateDocumentFromWork?: (
    choice: "pub_license_terms" | "pub_master" | "purchase_order",
    work: { workId: number; workCode: string | null; title: string; vendorId: number | null }
  ) => void;
  // 過去文書取込（条件明細の登録）画面へ移動する導線（任意）。
  onOpenImport?: () => void;
  // アップロードした文書の詳細編集（条件明細エディタ付き）を直接開く。
  // 締結済み契約の条件は文書を新規発行せずここから登録する（利用者要望 2026-09-02）。
  onRegisterDocDetails?: (id: number) => void;
}) {
  const toast = useToast();
  const editMode = editWorkId != null;

  // ステップ制御（新規モードのみ。編集モードは全ステップ展開）。
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);

  // ① 基本情報
  const [title, setTitle] = useState("");
  const [kindChoice, setKindChoice] = useState<KindChoice>("own");
  const [businessLine, setBusinessLine] = useState<BusinessLine | null>(null);
  const [parentWorkId, setParentWorkId] = useState("");
  const [remarks, setRemarks] = useState("");
  // 編集モードの変更検知用（未変更の区分・派生元は送らない）。
  const [initial, setInitial] = useState<{
    kind: KindChoice; parent: string; derivation: string | null; businessLine: BusinessLine | null;
  } | null>(null);

  // ② 原作　③ 素材　④ 文書
  const [core, setCore] = useState<CoreRow>(emptyCore());
  const [mats, setMats] = useState<MatRow[]>([]);
  const [docs, setDocs] = useState<DocSeries[]>([]);
  const docSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileTarget = useRef<number | null>(null); // null=新しい系列 / key=巻き直し版の追加先

  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [doneInfo, setDoneInfo] = useState<{
    workId: number; workCode: string | null;
    saved: Array<{ material: IntakeMaterial; materialCode: string | null }>;
    uploadedDocs: Array<{ id: number; documentNumber: string }>;
  } | null>(null);

  // ── 編集モード：既存作品を読み込んで各ステップへ展開 ─────────────────
  const [loaded, setLoaded] = useState<{
    workCode: string | null; title: string; rightsHolderVendorId: number | null; rightsHolderName: string;
    // 編集モードで個別条件書V3を起こすときのマトリクス展開用（サーバ採番の素材コードつき）。
    materials: Array<{ materialCode: string | null; materialName: string; rightsHolderLabel: string;
      isRoyaltyBearing: boolean; territory: string | null; language: string | null }>;
  } | null>(null);
  const [workDocs, setWorkDocs] = useState<WorkDoc[]>([]);
  useEffect(() => {
    if (!editMode) return;
    let aborted = false;
    // 紐づく文書と条件明細の登録状況（失敗しても編集自体は続けられる）。
    (async () => {
      try {
        const response = await fetch(`/api/v2/works/${editWorkId}/documents`);
        if (!response.ok || aborted) return;
        const data = await response.json();
        if (!aborted) setWorkDocs(data.documents ?? []);
      } catch { /* 縮退表示 */ }
    })();
    (async () => {
      try {
        const response = await fetch(`/api/v2/works/${editWorkId}/detail`);
        if (!response.ok) { if (!aborted) setLoadError("作品を読み込めませんでした"); return; }
        const detail = await response.json();
        if (aborted) return;
        const work = detail.work ?? {};
        const kind: KindChoice = work.derivationType === "co_development" ? "co_dev"
          : work.kind === "own" ? "own" : "licensed_in";
        const line: BusinessLine | null = ["game", "publishing", "both"].includes(String(work.businessLine ?? ""))
          ? work.businessLine as BusinessLine : null;
        setTitle(String(work.title ?? ""));
        setKindChoice(kind);
        setBusinessLine(line);
        setParentWorkId(work.parentWorkId != null ? String(work.parentWorkId) : "");
        setRemarks(String(work.remarks ?? ""));
        setInitial({ kind, parent: work.parentWorkId != null ? String(work.parentWorkId) : "", derivation: work.derivationType ?? null, businessLine: line });
        const materials: Array<Record<string, unknown>> = detail.materials ?? [];
        setLoaded({
          workCode: work.workCode ?? null, title: String(work.title ?? ""),
          rightsHolderVendorId: work.rightsHolderVendorId != null ? Number(work.rightsHolderVendorId) : null,
          rightsHolderName: String(work.rightsHolderName ?? ""),
          materials: materials.map((m) => ({
            materialCode: (m.materialCode as string | null) ?? null,
            materialName: String(m.materialName ?? m.materialCode ?? ""),
            rightsHolderLabel: String(m.rightsHolderLabel ?? work.rightsHolderName ?? ""),
            isRoyaltyBearing: Boolean(m.isRoyaltyBearing),
            territory: (m.territory as string | null) ?? null,
            language: (m.language as string | null) ?? null
          }))
        });
        const coreMaterial = materials.find((m) => m.materialRole === "core_logic") ?? null;
        if (coreMaterial) {
          setCore({
            materialId: Number(coreMaterial.id), name: String(coreMaterial.materialName ?? ""),
            vendorId: null, vendorLabel: String(coreMaterial.rightsHolderLabel ?? work.rightsHolderName ?? ""),
            quoteDocId: null, quoteDocNumber: ""
          });
        }
        setMats(materials.filter((m) => m !== coreMaterial).map((m) => ({
          materialId: Number(m.id), name: String(m.materialName ?? ""),
          materialType: String(m.materialType ?? "other"),
          rights: m.rightsType === "license" ? "license" : "owned",
          vendorId: null, vendorLabel: String(m.rightsHolderLabel ?? ""),
          quoteDocId: null, quoteDocNumber: "", dirty: false
        })));
      } catch { if (!aborted) setLoadError("通信に失敗しました"); }
    })();
    return () => { aborted = true; };
  }, [editMode, editWorkId]);

  // ── 文書ファイルの追加 ────────────────────────────────────────────
  function pickFiles(targetKey: number | null) {
    fileTarget.current = targetKey;
    fileInput.current?.click();
  }
  function onFilesChosen(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const target = fileTarget.current;
    fileTarget.current = null;
    if (target == null) {
      setDocs((current) => [...current, ...files.map((file) => ({
        key: ++docSeq.current, files: [file], templateType: "contract",
        docNumber: "", vendorId: null, vendorLabel: "", date: ""
      }))]);
    } else {
      setDocs((current) => current.map((d) => d.key === target ? { ...d, files: [...d.files, ...files] } : d));
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  const updateMat = (index: number, patch: Partial<MatRow>) =>
    setMats((current) => current.map((m, i) => i === index ? { ...m, ...patch, dirty: m.materialId != null ? true : m.dirty } : m));
  const updateDoc = (key: number, patch: Partial<DocSeries>) =>
    setDocs((current) => current.map((d) => d.key === key ? { ...d, ...patch } : d));

  // ── ステップ検証 ──────────────────────────────────────────────────
  function validateStep(n: number): string | null {
    if (n === 1 && !title.trim()) return "作品名を入力してください";
    if (n === 1 && !editMode && !businessLine) return "展開区分（ゲーム／出版／両方）を選んでください";
    if (n === 2) {
      // 編集モード：原作素材が無い旧作品は空のまま保存できる（入れたら新規作成）。
      if (!core.name.trim()) {
        return editMode && core.materialId == null ? null : "原作（コアロジック）の名称を入力してください";
      }
      if (kindChoice !== "own" && core.vendorId == null && !core.vendorLabel.trim()) {
        return kindChoice === "licensed_in" ? "原作の権利元（許諾元）を選んでください" : "共同開発の相手方を選んでください";
      }
    }
    if (n === 4) {
      for (const d of docs) {
        if (!d.files.length) continue;
        if (!d.docNumber.trim()) return `文書「${d.files[0].name}」の文書番号を入力してください`;
      }
      const numbers = docs.filter((d) => d.files.length).map((d) => d.docNumber.trim());
      if (new Set(numbers).size !== numbers.length) return "文書番号が重複しています";
    }
    return null;
  }
  function next(from: number) {
    const problem = validateStep(from);
    if (problem) { toast.push(problem, "error"); return; }
    const to = from + 1;
    setStep(to);
    setMaxStep((m) => Math.max(m, to));
  }

  // ── 保存処理（共通部品）─────────────────────────────────────────
  async function postJson(url: string, body: unknown, method: "POST" | "PATCH" = "POST") {
    const response = await fetch(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }

  function coreCreatePayload(workId: number) {
    const own = kindChoice === "own";
    return {
      workId, materialName: core.name.trim(),
      materialType: "game_design", materialRole: "core_logic",
      acquisitionType: own ? "in_house" : "license",
      rightsType: own ? "owned" : "license",
      ...(core.vendorId ? { rightsHolderVendorId: core.vendorId } : {}),
      ...(core.vendorLabel.trim() ? { rightsHolderLabel: core.vendorLabel.trim() } : own ? { rightsHolderLabel: "当社" } : {}),
      isDefault: true, isRoyaltyBearing: !own
    };
  }
  function matCreatePayload(workId: number, m: MatRow) {
    return {
      workId, materialName: m.name.trim(), materialType: m.materialType, materialRole: "sub_component",
      acquisitionType: m.rights === "license" ? "license" : "buyout_commission",
      rightsType: m.rights,
      ...(m.vendorId ? { rightsHolderVendorId: m.vendorId } : {}),
      ...(m.vendorLabel.trim() ? { rightsHolderLabel: m.vendorLabel.trim() } : {}),
      isDefault: false, isRoyaltyBearing: m.rights === "license"
    };
  }
  async function addRightsSource(materialId: number, quoteDocId: number, license: boolean, vendorId: number | null) {
    const response = await fetch("/api/v2/rights-sources", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        materialId,
        sourceType: license ? "upstream_license" : "direct_contract",
        sourceDocumentId: quoteDocId,
        ...(vendorId ? { rightsHolderVendorId: vendorId } : {}),
        isPrimary: true
      })
    }).catch(() => null);
    return Boolean(response?.ok);
  }

  // 巻き直しの版を順にアップロード（旧版→有効版）。有効版の文書ID一覧と
  // 失敗した版の番号を返す（有効版IDは完了帯の「条件明細を登録」導線に使う）。
  async function uploadDocs(workCode: string | null): Promise<{
    uploaded: Array<{ id: number; documentNumber: string }>; failed: string[];
  }> {
    const uploaded: Array<{ id: number; documentNumber: string }> = [];
    const failed: string[] = [];
    for (const series of docs) {
      if (!series.files.length) continue;
      const plans = planDocumentUploads({ docNumber: series.docNumber, fileNames: series.files.map((f) => f.name) });
      for (const [index, plan] of plans.entries()) {
        const form = new FormData();
        form.append("file", series.files[index]);
        form.append("originalName", series.files[index].name);
        form.append("documentNumber", plan.documentNumber);
        form.append("templateType", series.templateType);
        form.append("title", plan.title);
        if (series.vendorLabel.trim()) form.append("counterparty", series.vendorLabel.trim());
        if (series.vendorId) form.append("counterpartyVendorId", String(series.vendorId));
        if (series.date.trim()) form.append("documentDate", series.date.trim());
        if (workCode) form.append("workCode", workCode);
        if (plan.supersededBy) form.append("supersededBy", plan.supersededBy);
        try {
          const response = await fetch("/api/v2/documents/import/upload", { method: "POST", body: form });
          if (response.ok) {
            const data = await response.json().catch(() => ({}));
            // 有効版（supersededBy 無し）だけを控える＝件数も条件明細の導線も有効版単位。
            if (!plan.supersededBy && data.document?.id) {
              uploaded.push({ id: Number(data.document.id), documentNumber: plan.documentNumber });
            }
          } else {
            const data = await response.json().catch(() => ({}));
            failed.push(`${plan.documentNumber}（${data.error ?? "登録失敗"}）`);
          }
        } catch { failed.push(`${plan.documentNumber}（通信失敗）`); }
      }
    }
    return { uploaded, failed };
  }

  function toIntakeMaterial(name: string, holderLabel: string, royalty: boolean, sourceDocNumber: string): IntakeMaterial {
    return { ...emptyIntakeMaterial(holderLabel), name, royalty, sourceDocNumber };
  }

  // ── 新規登録 ─────────────────────────────────────────────────────
  async function submitNew() {
    for (const n of [1, 2, 4]) {
      const problem = validateStep(n);
      if (problem) { toast.push(problem, "error"); setStep(n); return; }
    }
    setBusy(true);
    try {
      const work = await postJson("/api/v2/works", {
        title: title.trim(),
        kind: kindChoice === "own" ? "own" : "licensed_in",
        ...(businessLine ? { businessLine } : {}),
        ...(kindChoice === "own" ? { isOriginal: true } : {}),
        ...(kindChoice === "co_dev" ? { derivationType: "co_development" } : {}),
        ...(core.vendorId ? { rightsHolderVendorId: core.vendorId } : {}),
        ...(parentWorkId ? { parentWorkId: Number(parentWorkId) } : {}),
        ...(remarks.trim() ? { remarks: remarks.trim() } : {})
      });
      if (!work.ok) { toast.push(work.data.error ?? "作品を登録できませんでした", "error"); return; }
      const workId = Number(work.data.id);
      const workCode: string | null = work.data.workCode ?? null;

      const saved: Array<{ material: IntakeMaterial; materialCode: string | null }> = [];
      const failedMats: string[] = [];
      let rightsFailed = 0;

      // 原作（コアロジック）
      const coreCreated = await postJson("/api/v2/materials", coreCreatePayload(workId));
      if (coreCreated.ok) {
        saved.push({
          material: toIntakeMaterial(core.name.trim(), core.vendorLabel || (kindChoice === "own" ? "当社" : ""), kindChoice !== "own", core.quoteDocNumber),
          materialCode: coreCreated.data.materialCode ?? null
        });
        if (core.quoteDocId && !(await addRightsSource(Number(coreCreated.data.id), core.quoteDocId, kindChoice !== "own", core.vendorId))) rightsFailed += 1;
      } else failedMats.push(`原作: ${core.name.trim()}`);

      // 素材
      for (const m of mats.filter((row) => row.name.trim())) {
        const created = await postJson("/api/v2/materials", matCreatePayload(workId, m));
        if (!created.ok) { failedMats.push(m.name.trim()); continue; }
        saved.push({
          material: toIntakeMaterial(m.name.trim(), m.vendorLabel, m.rights === "license", m.quoteDocNumber),
          materialCode: created.data.materialCode ?? null
        });
        if (m.quoteDocId && !(await addRightsSource(Number(created.data.id), m.quoteDocId, m.rights === "license", m.vendorId))) rightsFailed += 1;
      }

      const documents = await uploadDocs(workCode);

      const summary = `作品 ${workCode ?? `#${workId}`} を登録しました（素材${saved.length}件・文書${documents.uploaded.length}件）`
        + (failedMats.length ? `／素材の失敗: ${failedMats.join("、")}` : "")
        + (rightsFailed ? `／根拠文書の紐づけ失敗: ${rightsFailed}件` : "")
        + (documents.failed.length ? `／文書の失敗: ${documents.failed.join("、")}` : "");
      toast.push(summary, failedMats.length || documents.failed.length ? "info" : "success");
      setDoneInfo({ workId, workCode, saved, uploadedDocs: documents.uploaded });
      setStep(6); setMaxStep(6);
    } catch {
      toast.push("通信に失敗しました。", "error");
    } finally { setBusy(false); }
  }

  // ── 編集の保存 ───────────────────────────────────────────────────
  async function saveEdit() {
    if (editWorkId == null) return;
    const problem = validateStep(1) ?? validateStep(2) ?? validateStep(4);
    if (problem) { toast.push(problem, "error"); return; }
    setBusy(true);
    try {
      const patch: Record<string, unknown> = { title: title.trim(), remarks: remarks.trim() || null };
      if (initial && kindChoice !== initial.kind) {
        patch.kind = kindChoice === "own" ? "own" : "licensed_in";
        patch.isOriginal = kindChoice === "own";
        // co_development の付け外しのみ操作（他の派生種別のレガシー値は温存）。
        if (kindChoice === "co_dev") patch.derivationType = "co_development";
        else if (initial.derivation === "co_development") patch.derivationType = null;
      }
      if (initial && parentWorkId !== initial.parent) {
        patch.parentWorkId = parentWorkId ? Number(parentWorkId) : null;
      }
      if (initial && businessLine !== initial.businessLine) patch.businessLine = businessLine;
      if (core.vendorId) patch.rightsHolderVendorId = core.vendorId;
      const workSaved = await postJson(`/api/v2/works/${editWorkId}`, patch, "PATCH");
      if (!workSaved.ok) { toast.push(workSaved.data.error ?? "作品を保存できませんでした", "error"); return; }

      const failures: string[] = [];
      let rightsFailed = 0;

      // 原作：既存は PATCH・無ければ新規作成。
      if (core.materialId != null) {
        const patchCore: Record<string, unknown> = { materialName: core.name.trim(), materialRole: "core_logic" };
        if (core.vendorId) { patchCore.rightsHolderVendorId = core.vendorId; patchCore.rightsHolderLabel = core.vendorLabel.trim() || null; }
        const saved = await postJson(`/api/v2/materials/${core.materialId}`, patchCore, "PATCH");
        if (!saved.ok) failures.push(`原作: ${core.name.trim()}`);
        else if (core.quoteDocId && !(await addRightsSource(core.materialId, core.quoteDocId, kindChoice !== "own", core.vendorId))) rightsFailed += 1;
      } else if (core.name.trim()) {
        const created = await postJson("/api/v2/materials", coreCreatePayload(editWorkId));
        if (!created.ok) failures.push(`原作: ${core.name.trim()}`);
        else if (core.quoteDocId && !(await addRightsSource(Number(created.data.id), core.quoteDocId, kindChoice !== "own", core.vendorId))) rightsFailed += 1;
      }

      // 素材：新規行は POST・変更のあった既存行は PATCH。
      for (const m of mats.filter((row) => row.name.trim())) {
        if (m.materialId == null) {
          const created = await postJson("/api/v2/materials", matCreatePayload(editWorkId, m));
          if (!created.ok) { failures.push(m.name.trim()); continue; }
          if (m.quoteDocId && !(await addRightsSource(Number(created.data.id), m.quoteDocId, m.rights === "license", m.vendorId))) rightsFailed += 1;
        } else {
          if (m.dirty) {
            const patchMat: Record<string, unknown> = {
              materialName: m.name.trim(),
              rightsType: m.rights,
              acquisitionType: m.rights === "license" ? "license" : "buyout_commission",
              isRoyaltyBearing: m.rights === "license"
            };
            if (m.vendorId) { patchMat.rightsHolderVendorId = m.vendorId; patchMat.rightsHolderLabel = m.vendorLabel.trim() || null; }
            const saved = await postJson(`/api/v2/materials/${m.materialId}`, patchMat, "PATCH");
            if (!saved.ok) { failures.push(m.name.trim()); continue; }
          }
          if (m.quoteDocId && !(await addRightsSource(m.materialId, m.quoteDocId, m.rights === "license", m.vendorId))) rightsFailed += 1;
        }
      }

      const documents = await uploadDocs(loaded?.workCode ?? null);
      const summary = `作品 ${loaded?.workCode ?? `#${editWorkId}`} を保存しました`
        + (documents.uploaded.length ? `（文書${documents.uploaded.length}件を追加）` : "")
        + (failures.length ? `／素材の失敗: ${failures.join("、")}` : "")
        + (rightsFailed ? `／根拠文書の紐づけ失敗: ${rightsFailed}件` : "")
        + (documents.failed.length ? `／文書の失敗: ${documents.failed.join("、")}` : "");
      toast.push(summary, failures.length || documents.failed.length ? "info" : "success");
      onOpenWork?.(editWorkId);
    } catch {
      toast.push("通信に失敗しました。", "error");
    } finally { setBusy(false); }
  }

  // ── 「この作品から作る文書」（完了帯・編集モード共通）──────────────────
  // 個別条件書V3は素材マトリクスの展開が必要なので既存の橋（buildLicenseTermsSeed）、
  // 出版条件書・出版基本契約・発注書は App 側で取引先・作品の対応表から初期値を作る。
  function pickDocument(choice: WorkDocumentChoice) {
    const workId = doneInfo?.workId ?? editWorkId;
    const workCode = doneInfo?.workCode ?? loaded?.workCode ?? null;
    if (workId == null) return;
    if (choice.templateKey === "individual_license_terms_v3") {
      const materials = doneInfo
        ? doneInfo.saved
        : (loaded?.materials ?? []).map((m) => ({
          material: {
            ...emptyIntakeMaterial(m.rightsHolderLabel), name: m.materialName, royalty: m.isRoyaltyBearing,
            region: m.territory ?? "全世界", language: m.language ?? "全言語"
          },
          materialCode: m.materialCode
        }));
      onCreateLicenseTerms(
        buildLicenseTermsSeed(
          { workCode, title: title.trim(), holderLabel: core.vendorLabel || loaded?.rightsHolderName || "" },
          materials),
        workCode);
      return;
    }
    onCreateDocumentFromWork?.(choice.templateKey, {
      workId, workCode, title: title.trim(),
      vendorId: core.vendorId ?? loaded?.rightsHolderVendorId ?? null
    });
  }

  if (!canRegister) {
    return <section className="page"><div className="page-title"><div>
      <p>WORK INTAKE</p><h1>作品登録</h1>
      <small>作品・素材の書込権限（works / materials）が無効のため利用できません。</small>
    </div></div></section>;
  }

  const kindLabel = kindChoice === "own" ? "自社オリジナル" : kindChoice === "licensed_in" ? "ライセンスイン" : "共同開発";
  const namedMats = mats.filter((m) => m.name.trim());
  const docCount = docs.filter((d) => d.files.length).length;
  const rewrapCount = docs.filter((d) => d.files.length > 1).length;

  // ステップ枠：新規は順番制御・編集は全展開。
  function stepCard(n: number, heading: string, summary: string, body: ReactNode) {
    const state = editMode || step === 6 ? "done" : n === step ? "current" : n <= maxStep ? "done" : "locked";
    const open = editMode || n === step;
    return <section className={`wz-step ${state}${open ? " open" : ""}`}>
      <div className="wz-dot">{state === "done" && !open ? "✓" : n}</div>
      <div className="panel wz-card">
        <button type="button" className="wz-head" disabled={state === "locked"}
          onClick={() => { if (!editMode && n <= maxStep) setStep(n); }}>
          <span className="wz-title">{heading}</span>
          {!open && <span className="wz-summary">{summary}</span>}
          <span className="wz-state">{state === "done" && !open ? "完了 ✔" : state === "locked" ? "未入力" : ""}</span>
        </button>
        {open && <div className="wz-body">{body}</div>}
      </div>
    </section>;
  }

  return <section className="page work-intake">
    <div className="page-title"><div>
      <p>WORK INTAKE</p>
      <h1>{editMode ? `作品の編集${loaded ? ` — ${loaded.workCode ?? ""} ${loaded.title}` : ""}` : "作品の登録"}</h1>
      <small>原作と素材をこの画面で一括登録します。条件（料率・MG/AG・地域言語）はここでは扱いません — 登録後に文書作成（個別条件書・発注書）または過去文書の取込で入力します。</small>
    </div></div>
    {loadError && <div className="async-error">{loadError}</div>}
    <input ref={fileInput} type="file" multiple style={{ display: "none" }}
      onChange={(e) => onFilesChosen(e.target.files)} />

    <div className="wz-flow">
      {stepCard(1, "① 作品の基本情報",
        [title || "未入力", kindLabel, businessLine ? `展開: ${businessLineLabel(businessLine)}` : ""].filter(Boolean).join("｜"),
        <>
          <div className="wi-grid">
            <label className="wi-span2">作品名（製品1つ＝作品1行）*<input value={title}
              onChange={(e) => setTitle(e.target.value)} maxLength={1000}
              placeholder="例: このエピローグは終わらない" /></label>
          </div>
          <div className="wz-choice">
            {([["own", "自社オリジナル", "権利は当社。原作の権利元は当社になります"],
              ["licensed_in", "ライセンスイン", "他社の原作を許諾を受けて使う"],
              ["co_dev", "共同開発", "他社と共同で権利を持つ"]] as const).map(([value, label, hint]) =>
              <label key={value} className={kindChoice === value ? "on" : ""}>
                <input type="radio" name="wz-kind" checked={kindChoice === value}
                  onChange={() => setKindChoice(value)} />
                <b>{label}</b><small>{hint}</small>
              </label>)}
          </div>
          <p className="wz-hint">この作品の展開区分 *（作品から作れる文書の種類が決まります）</p>
          <div className="wz-line">
            {BUSINESS_LINE_OPTIONS.map((option) =>
              <label key={option.value} className={`wz-choice-item${businessLine === option.value ? " on" : ""}`}>
                <input type="radio" name="wz-line" checked={businessLine === option.value}
                  onChange={() => setBusinessLine(option.value)} />
                <b>{option.label}</b><small>{option.hint}</small>
              </label>)}
          </div>
          <div className="wi-grid">
            <SearchableLedgerSelect type="works" value={parentWorkId}
              label="派生元の作品（任意）" placeholder="続編・移植のときだけ、登録済み作品から検索…"
              helper={editMode && initial?.parent && parentWorkId === initial.parent ? `現在の派生元 ID: ${initial.parent}` : "新規タイトルなら空のまま"}
              filter={(item) => !item.id.startsWith("source_ip:")}
              onChange={(value) => setParentWorkId(value)} />
            <label>メモ（社内向け・任意）<input value={remarks} maxLength={4000}
              onChange={(e) => setRemarks(e.target.value)} /></label>
          </div>
          {!editMode && <div className="wz-next">
            <button type="button" className="primary" onClick={() => next(1)}>次へ：原作を登録</button>
            <small>作品コードは登録時に自動採番されます</small>
          </div>}
        </>)}

      {stepCard(2, "② 原作の登録",
        [core.name || "未入力", core.vendorLabel ? `権利元: ${core.vendorLabel}` : kindChoice === "own" ? "権利元: 当社" : ""].filter(Boolean).join("｜"),
        <>
          <p className="wz-hint">原作＝この作品の<b>コアロジック素材</b>です。作品につき1件、必ず登録します。
            {kindChoice === "own" ? "自社オリジナルのため、権利元は当社になります。"
              : kindChoice === "licensed_in" ? "ライセンスインのため、権利元（許諾元）を指定してください。"
                : "共同開発のため、相手方の取引先を指定してください。"}</p>
          <div className="wi-grid">
            <label className="wi-span2">原作（コアロジック）の名称 *<input value={core.name} maxLength={300}
              onChange={(e) => setCore({ ...core, name: e.target.value })}
              placeholder="例: コアロジック「エピローグ」" /></label>
            {kindChoice !== "own" && <SearchableLedgerSelect type="vendors"
              value={core.vendorId != null ? String(core.vendorId) : ""}
              label="権利元（取引先を検索）*" placeholder="名称・コードで検索…"
              helper={editMode && !core.vendorId && core.vendorLabel ? `現在の権利元: ${core.vendorLabel}` : undefined}
              onChange={(value, item) => setCore({ ...core, vendorId: value ? Number(value) : null, vendorLabel: item?.title ?? core.vendorLabel })} />}
          </div>
          <DocQuotePicker note="根拠文書を既存契約書から引用（任意・発注書/利用許諾/取込文書すべて対象）"
            quoteNumber={core.quoteDocNumber}
            onPick={(hit) => setCore({ ...core, quoteDocId: hit?.id ?? null, quoteDocNumber: hit?.documentNumber ?? "" })} />
          {!editMode && <div className="wz-next">
            <button type="button" className="primary" onClick={() => next(2)}>次へ：素材を登録</button>
            <button type="button" onClick={() => setStep(1)}>戻る</button>
          </div>}
        </>)}

      {stepCard(3, "③ 素材の登録",
        namedMats.length ? `${namedMats.length} 件の素材` : "素材なし",
        <>
          <p className="wz-hint">イラスト・シナリオ・音楽など、原作以外の素材を必要な数だけ。<b>0件でも進めます</b>（あとから追加できます）。</p>
          {mats.map((m, index) => <article className="wz-mat" key={m.materialId ?? `new-${index}`}>
            <div className="wz-mat-head">
              <span className="wz-tag">素材</span>
              {m.materialId != null && <small>登録済み #{m.materialId}</small>}
              <span className="wi-spacer"></span>
              {m.materialId == null &&
                <button type="button" className="link-button" onClick={() => setMats((c) => c.filter((_, i) => i !== index))}>削除</button>}
            </div>
            <div className="wi-grid">
              <label className="wi-span2">素材名 *<input value={m.name} maxLength={300}
                onChange={(e) => updateMat(index, { name: e.target.value })}
                placeholder="例: メインビジュアルイラスト" /></label>
              <label>種別<select value={m.materialType} disabled={m.materialId != null}
                onChange={(e) => updateMat(index, { materialType: e.target.value })}>
                {MATERIAL_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <label>権利形態<select value={m.rights}
                onChange={(e) => updateMat(index, { rights: e.target.value as MatRow["rights"] })}>
                <option value="owned">買取・自社保有</option>
                <option value="license">許諾を受けて使用</option>
              </select></label>
              <SearchableLedgerSelect type="vendors" value={m.vendorId != null ? String(m.vendorId) : ""}
                label="権利元（取引先を検索）" placeholder="空欄＝当社"
                helper={m.materialId != null && !m.vendorId && m.vendorLabel ? `現在の権利元: ${m.vendorLabel}` : undefined}
                onChange={(value, item) => updateMat(index, { vendorId: value ? Number(value) : null, vendorLabel: item?.title ?? m.vendorLabel })} />
            </div>
            <DocQuotePicker note="既存契約書から引用（発注書・利用許諾・取込文書すべて対象）"
              quoteNumber={m.quoteDocNumber}
              onPick={(hit) => updateMat(index, { quoteDocId: hit?.id ?? null, quoteDocNumber: hit?.documentNumber ?? "" })} />
          </article>)}
          <div className="wi-add-row">
            <button type="button" className="wi-add" onClick={() => setMats((c) => [...c, emptyMat()])}>＋ 素材を追加</button>
          </div>
          {!editMode && <div className="wz-next">
            <button type="button" className="primary" onClick={() => next(3)}>次へ：既存文書をアップロード</button>
            <button type="button" onClick={() => setStep(2)}>戻る</button>
          </div>}
        </>)}

      {stepCard(4, editMode ? "④ 既存文書と条件明細" : "④ 既存文書のアップロード",
        docCount ? `${docCount} 件の文書${rewrapCount ? `（巻き直し ${rewrapCount} 組）` : ""}` : "文書なし",
        <>
          {editMode && <div className="wz-docstatus">
            <strong>この作品に紐づく文書（条件明細の登録状況）</strong>
            {workDocs.length === 0 && <p className="wz-hint">まだ文書が紐づいていません。下からアップロードするか、文書一覧の「過去文書取込」で登録してください。</p>}
            {workDocs.length > 0 && <ul>
              {workDocs.map((doc) => <li key={doc.id} className={doc.supersededBy ? "old" : ""}>
                <b>{doc.documentNumber ?? `#${doc.id}`}</b>
                <span>{DOC_KIND_LABELS[doc.templateType ?? ""] ?? doc.templateType ?? "—"}</span>
                <span className="wz-doctitle">{doc.title ?? ""}</span>
                {doc.supersededBy
                  ? <span className="wz-tag">旧版（→ {doc.supersededBy}）</span>
                  : doc.conditionCount > 0
                    ? <span className="wz-tag eff">条件明細 {doc.conditionCount}件</span>
                    : <span className="wz-tag warn">条件未登録</span>}
                {!doc.supersededBy && doc.templateVersionId == null && onRegisterDocDetails &&
                  <button type="button" className="link-button"
                    onClick={() => onRegisterDocDetails(doc.id)}>
                    {doc.conditionCount > 0 ? "条件明細を編集 →" : "条件明細を登録 →"}</button>}
              </li>)}
            </ul>}
            <small className="wz-hint">「条件未登録」の取込文書は「条件明細を登録 →」から入れます（文書は新しく作られません・保存で台帳へ同期）。システムで発行した文書の条件は確定時に同期済みです。</small>
          </div>}
          <p className="wz-hint">この作品に関係する契約書・発注書などをまとめて登録します（Drive格納・<b>複数可・0件でも進めます</b>）。
            同じ契約を締結し直した<b>巻き直し文書</b>は、元の文書の「＋巻き直し版を追加」から版として積んでください — 最後に追加した版が有効になります。</p>
          <div className="wz-drop">
            <button type="button" onClick={() => pickFiles(null)}>ファイルを選択（複数可）</button>
            <small>1ファイル30MBまで。条件明細の登録は、登録後に文書一覧の「詳細を編集」から行えます。</small>
          </div>
          {docs.map((d) => <article className="wz-doc" key={d.key}>
            <div className="wz-doc-file">
              <span className="wz-tag eff">{d.files.length > 1 ? `有効版: ${d.files[d.files.length - 1].name}` : d.files[0]?.name ?? ""}</span>
              <span className="wi-spacer"></span>
              <button type="button" className="link-button" onClick={() => setDocs((c) => c.filter((x) => x.key !== d.key))}>この文書を削除</button>
            </div>
            {d.files.length > 1 && <ul className="wz-vers">
              {d.files.slice(0, -1).map((f, i) => <li key={i}>
                第{i + 1}版（旧版・{`${d.docNumber || "番号"}-v${i + 1}`} で登録）: {f.name}
                <button type="button" className="link-button"
                  onClick={() => updateDoc(d.key, { files: d.files.filter((_, j) => j !== i) })}>削除</button>
              </li>)}
            </ul>}
            <div className="wi-grid">
              <label>種別<select value={d.templateType} onChange={(e) => updateDoc(d.key, { templateType: e.target.value })}>
                {INTAKE_DOC_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select></label>
              <label>文書番号 *<input value={d.docNumber} maxLength={100}
                onChange={(e) => updateDoc(d.key, { docNumber: e.target.value })} placeholder="例: PO-2025-0083" /></label>
              <SearchableLedgerSelect type="vendors" value={d.vendorId != null ? String(d.vendorId) : ""}
                label="相手先（取引先を検索）" placeholder="名称・コードで検索…"
                onChange={(value, item) => updateDoc(d.key, { vendorId: value ? Number(value) : null, vendorLabel: item?.title ?? "" })} />
              <label>締結日<input type="date" value={d.date} onChange={(e) => updateDoc(d.key, { date: e.target.value })} /></label>
            </div>
            <button type="button" className="link-button" onClick={() => pickFiles(d.key)}>＋ 巻き直し版を追加（同じ契約の締結し直し）</button>
          </article>)}
          {!editMode && <div className="wz-next">
            <button type="button" className="primary" onClick={() => next(4)}>次へ：内容を確認</button>
            <button type="button" onClick={() => setStep(3)}>戻る</button>
          </div>}
        </>)}

      {!editMode && stepCard(5, "⑤ 確認して登録", "", <>
        <dl className="wz-confirm">
          <dt>作品名</dt><dd>{title || "—"}</dd>
          <dt>区分</dt><dd>{kindLabel}</dd>
          <dt>派生元</dt><dd>{parentWorkId ? `作品 #${parentWorkId}` : "なし（新規タイトル）"}</dd>
          <dt>原作</dt><dd>{core.name || "—"}／権利元: {core.vendorLabel || (kindChoice === "own" ? "当社" : "未指定")}
            {core.quoteDocNumber ? `／根拠: ${core.quoteDocNumber}` : ""}</dd>
          <dt>素材</dt><dd>{namedMats.length
            ? namedMats.map((m) => `${m.name}（${m.rights === "license" ? "許諾" : "買取"}・${m.vendorLabel || "当社"}）`).join("、")
            : "なし（あとから追加可）"}</dd>
          <dt>既存文書</dt><dd>{docCount
            ? docs.filter((d) => d.files.length).map((d) => `${d.docNumber || d.files[0].name}${d.files.length > 1 ? `（巻き直し${d.files.length}版）` : ""}`).join("、")
            : "なし（あとから取込可）"}</dd>
        </dl>
        <div className="wz-warn">条件（料率・MG/AG・地域言語）はまだ入っていません。登録後に「個別条件書を作成」または「過去文書の取込 → 詳細を編集」で入力します。</div>
        <div className="wz-next">
          <button type="button" className="primary" disabled={busy} onClick={() => void submitNew()}>
            {busy ? "登録中…" : "この内容で作品を登録"}</button>
          <button type="button" onClick={() => setStep(4)}>戻る</button>
        </div>
      </>)}
    </div>

    {doneInfo && <div className="panel wz-doneband">
      <h2>✔ 作品を登録しました（{doneInfo.workCode ?? `#${doneInfo.workId}`}）</h2>
      {doneInfo.uploadedDocs.length > 0 && onRegisterDocDetails && <>
        <p><b>アップロードした文書の条件は、文書を新しく作らずここから登録します</b>（条件台帳へ自動同期されます）。</p>
        <div className="wz-next">
          {doneInfo.uploadedDocs.map((doc) =>
            <button type="button" className="primary" key={doc.id} onClick={() => onRegisterDocDetails(doc.id)}>
              {doc.documentNumber} に条件明細を登録 →</button>)}
        </div>
      </>}
      <WorkDocumentLauncher businessLine={businessLine} onPick={pickDocument} />
      <div className="wz-next">
        {onOpenImport && <button type="button" onClick={onOpenImport}>過去文書を取込む</button>}
        <button type="button" onClick={() => onOpenWork?.(doneInfo.workId)}>作品詳細を開く</button>
      </div>
    </div>}

    {editMode && loaded && <div className="panel wd-launcher">
      <WorkDocumentLauncher businessLine={businessLine} onPick={pickDocument} compact />
    </div>}

    {editMode && <div className="wz-savebar">
      <span>全ステップをその場で修正できます。素材の種別変更と削除はできません（付け替えは新しい素材として追加してください）。</span>
      <button type="button" onClick={() => onOpenWork?.(editWorkId!)}>キャンセル</button>
      <button type="button" className="primary" disabled={busy} onClick={() => void saveEdit()}>
        {busy ? "保存中…" : "変更を保存"}</button>
    </div>}
  </section>;
}
