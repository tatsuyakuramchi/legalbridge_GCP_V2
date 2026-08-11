import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  SearchableLedgerSelect,
  isCanonicalWork,
  type SearchableLedgerItem
} from "./SearchableLedgerSelect";

type WorkInput = {
  mode: "existing" | "new";
  existingWorkId: string;
  selectedTitle: string;
  title: string;
  workType: "board_game" | "trpg_book" | "other";
  status: "" | "planning" | "in_production" | "released";
};

type MaterialInput = {
  mode: "new" | "existing";
  existingMaterialId: string;
  selectedTitle: string;
  materialName: string;
  materialType: "game_design" | "illustration" | "scenario" | "manuscript" | "other";
  materialRole: "core_logic" | "sub_component";
  acquisitionType: "license" | "buyout_commission" | "in_house";
  rightsType: "owned" | "license";
  isDefault: boolean;
  isRoyaltyBearing: boolean;
};

type ConditionInput = {
  conditionName: string;
  transactionKind: "license" | "product" | "service";
  materialIndex: string;
  territory: string;
  languages: string;
  exclusivity: "exclusive" | "non_exclusive" | "sole";
  sublicenseAllowed: boolean;
  termStart: string;
  termEnd: string;
  currency: string;
  paymentScheme: "royalty" | "per_unit" | "lump_sum" | "installment" | "subscription";
  ratePct: string;
  amountExTax: string;
  mgAmount: string;
  advanceAmount: string;
  reportingCycle: string;
  paymentTerms: string;
  royaltyBase: string;
  deductibleCosts: string;
  withholdingTaxTreatment: string;
  minimumQuantity: string;
  sellOffMonths: string;
  incoterms: string;
  notes: string;
};

type OutboundCondition = ConditionInput & { parentInboundIndex: string };

type OutboundRow = {
  id: string;
  counterpartyVendorId: string;
  counterpartyName: string;
  condition: ConditionInput;
};

type OutboundView = {
  conditionLineId: number;
  conditionName: string;
  counterpartyName: string;
  territory: string;
  languages: string[];
  paymentScheme: string;
  ratePct?: number;
};

type ContractForm = {
  documentNumber: string;
  contractTitle: string;
  primaryVendorId: string;
  primaryVendorName: string;
  contractType: string;
  executedAt: string;
  effectiveDate: string;
  expirationDate: string;
  autoRenewal: boolean;
  renewalNoticeMonths: string;
  scope: string;
  documentUrl: string;
};

type PreparedDraft = {
  issueKey: string;
  templateType: string;
  label: string;
  counterpartyName: string;
  created: boolean;
};

type RegisteredIntake = {
  documentId: number;
  contractId: number;
  documentNumber: string;
  contractTitle: string;
  contractType: string;
  primaryVendorName: string;
  sourceWorkTitle: string;
  ownWorkTitle: string;
  executedAt: string;
  inboundConditionCount: number;
  outboundConditionCount: number;
};

const steps = ["イン契約", "取得権利", "自社作品", "文書・登録"];

const numberField = (value: string) => value === "" ? undefined : Number(value);
const textField = (value: string) => value.trim() || undefined;

function conditionToPayload(value: ConditionInput) {
  return {
    conditionName: value.conditionName.trim(),
    transactionKind: value.transactionKind,
    materialIndex: numberField(value.materialIndex),
    territory: value.territory.trim(),
    languages: value.languages.split(/[,、]/).map((item) => item.trim()).filter(Boolean),
    exclusivity: value.exclusivity,
    sublicenseAllowed: value.sublicenseAllowed,
    termStart: textField(value.termStart),
    termEnd: textField(value.termEnd),
    currency: value.currency.trim().toUpperCase(),
    paymentScheme: value.paymentScheme,
    ratePct: numberField(value.ratePct),
    amountExTax: numberField(value.amountExTax),
    mgAmount: numberField(value.mgAmount),
    advanceAmount: numberField(value.advanceAmount),
    reportingCycle: textField(value.reportingCycle),
    paymentTerms: textField(value.paymentTerms),
    royaltyBase: textField(value.royaltyBase),
    deductibleCosts: textField(value.deductibleCosts),
    withholdingTaxTreatment: textField(value.withholdingTaxTreatment),
    minimumQuantity: numberField(value.minimumQuantity),
    sellOffMonths: numberField(value.sellOffMonths),
    incoterms: textField(value.incoterms),
    notes: textField(value.notes)
  };
}

const initialWork = (kind: "source" | "own"): WorkInput => ({
  mode: "new",
  existingWorkId: "",
  selectedTitle: "",
  title: "",
  workType: "board_game",
  status: kind === "own" ? "planning" : ""
});

const initialMaterial = (): MaterialInput => ({
  mode: "new",
  existingMaterialId: "",
  selectedTitle: "",
  materialName: "",
  materialType: "game_design",
  materialRole: "core_logic",
  acquisitionType: "license",
  rightsType: "license",
  isDefault: true,
  isRoyaltyBearing: true
});

const initialCondition = (
  transactionKind: ConditionInput["transactionKind"] = "license"
): ConditionInput => ({
  conditionName: transactionKind === "product" ? "製品化許諾条件" : "原作利用許諾条件",
  transactionKind,
  materialIndex: "",
  territory: "",
  languages: "日本語",
  exclusivity: "non_exclusive",
  sublicenseAllowed: false,
  termStart: "",
  termEnd: "",
  currency: "JPY",
  paymentScheme: transactionKind === "product" ? "per_unit" : "royalty",
  ratePct: "",
  amountExTax: "",
  mgAmount: "",
  advanceAmount: "",
  reportingCycle: "",
  paymentTerms: "",
  royaltyBase: "純売上額",
  deductibleCosts: "",
  withholdingTaxTreatment: "",
  minimumQuantity: "",
  sellOffMonths: "",
  incoterms: "",
  notes: ""
});

const initialOutboundRow = (): OutboundRow => ({
  id: globalThis.crypto?.randomUUID?.() ?? `outbound-${Date.now()}`,
  counterpartyVendorId: "",
  counterpartyName: "",
  condition: { ...initialCondition("license"), conditionName: "個別利用許諾条件" }
});

const initialContract = (): ContractForm => ({
  documentNumber: "",
  contractTitle: "",
  primaryVendorId: "",
  primaryVendorName: "",
  contractType: "license_basic",
  executedAt: "",
  effectiveDate: "",
  expirationDate: "",
  autoRenewal: false,
  renewalNoticeMonths: "",
  scope: "",
  documentUrl: ""
});

export function ContractChainWizard({
  canCommit,
  onOpenDraft
}: {
  canCommit: boolean;
  onOpenDraft: (issueKey: string, templateType: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [sourceWork, setSourceWork] = useState(() => initialWork("source"));
  const [ownWork, setOwnWork] = useState(() => initialWork("own"));
  const [materials, setMaterials] = useState<MaterialInput[]>([initialMaterial()]);
  const [contract, setContract] = useState<ContractForm>(initialContract);
  const [inbound, setInbound] = useState<ConditionInput[]>([initialCondition()]);
  const [notice, setNotice] = useState("入力検証とDBプリフライトでは本番データを変更しません。");
  const [errors, setErrors] = useState<Array<{ field: string; message: string }>>([]);
  const [preflight, setPreflight] = useState<{
    committable: boolean;
    blockers: Array<{ code: string; field: string; message: string }>;
  } | null>(null);
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  const [preparedDrafts, setPreparedDrafts] = useState<PreparedDraft[]>([]);
  const [registered, setRegistered] = useState<RegisteredIntake[]>([]);
  const [selectedRegistered, setSelectedRegistered] = useState<number | null>(null);
  const [existingOutbound, setExistingOutbound] = useState<OutboundView[]>([]);
  const [outboundRows, setOutboundRows] = useState<OutboundRow[]>([]);
  const [outboundNotice, setOutboundNotice] = useState("");
  const [working, setWorking] = useState(false);

  async function loadRegistered() {
    try {
      const response = await fetch("/api/v2/contract-intakes?limit=100");
      if (!response.ok) {
        setRegistered([]);
        return;
      }
      const result = await response.json();
      setRegistered(result.items ?? []);
    } catch {
      setRegistered([]);
    }
  }

  useEffect(() => {
    loadRegistered();
  }, []);

  function changed(message = "入力内容が変更されました。再度プリフライトしてください。") {
    setPreflight(null);
    setSaved(null);
    setPreparedDrafts([]);
    setErrors([]);
    setNotice(message);
  }

  function updateContract(patch: Partial<ContractForm>) {
    setContract((current) => ({ ...current, ...patch }));
    changed();
  }

  function updateWork(
    setter: Dispatch<SetStateAction<WorkInput>>,
    patch: Partial<WorkInput>
  ) {
    setter((current) => ({ ...current, ...patch }));
    changed();
  }

  function updateMaterial(index: number, patch: Partial<MaterialInput>) {
    setMaterials((current) => current.map((item, candidate) =>
      candidate === index ? { ...item, ...patch } : item
    ));
    changed();
  }

  function updateInbound(index: number, patch: Partial<ConditionInput>) {
    setInbound((current) => current.map((item, candidate) =>
      candidate === index ? { ...item, ...patch } : item
    ));
    changed();
  }

  function payload() {
    const workPayload = (value: WorkInput) => value.mode === "existing"
      ? { existingWorkId: Number(value.existingWorkId) }
      : { title: value.title.trim(), workType: value.workType, status: value.status || undefined };

    return {
      sourceWork: workPayload(sourceWork),
      ownWork: workPayload(ownWork),
      materials: materials.map((value) => value.mode === "existing"
        ? { existingMaterialId: Number(value.existingMaterialId) }
        : {
            materialName: value.materialName.trim(),
            materialType: value.materialType,
            materialRole: value.materialRole,
            acquisitionType: value.acquisitionType,
            rightsType: value.rightsType,
            isDefault: value.isDefault,
            isRoyaltyBearing: value.isRoyaltyBearing
          }),
      contract: {
        documentNumber: contract.documentNumber.trim(),
        contractTitle: contract.contractTitle.trim(),
        primaryVendorId: Number(contract.primaryVendorId),
        contractType: contract.contractType.trim(),
        executedAt: contract.executedAt,
        effectiveDate: textField(contract.effectiveDate),
        expirationDate: textField(contract.expirationDate),
        autoRenewal: contract.autoRenewal,
        renewalNoticeMonths: numberField(contract.renewalNoticeMonths),
        scope: textField(contract.scope),
        documentUrl: textField(contract.documentUrl)
      },
      inboundConditions: inbound.map(conditionToPayload),
      // アウト条件は登録後にレジストリから追記する（イン先確定→アウト後日）。
      outboundConditions: []
    };
  }

  function stepIssue(index: number) {
    if (index === 0) {
      if (!contract.documentNumber.trim()) return "契約書番号を入力してください。";
      if (!contract.contractTitle.trim()) return "契約名を入力してください。";
      if (!contract.primaryVendorId) return "許諾者・イン契約の相手方を選択してください。";
      if (!contract.executedAt) return "締結日を入力してください。";
    }
    if (index === 1) {
      if (sourceWork.mode === "existing" ? !sourceWork.existingWorkId : !sourceWork.title.trim()) {
        return "原作を選択または入力してください。";
      }
      if (!materials.length) return "素材を1件以上追加してください。";
      if (materials.some((item) => item.mode === "existing" ? !item.existingMaterialId : !item.materialName.trim())) {
        return "すべての素材を選択または入力してください。";
      }
      if (!inbound.length || inbound.some((item) => !item.conditionName.trim() || !item.territory.trim() || !item.languages.trim())) {
        return "イン条件の条件名・地域・言語を入力してください。";
      }
    }
    if (index === 2 && (ownWork.mode === "existing" ? !ownWork.existingWorkId : !ownWork.title.trim())) {
      return "自社作品を選択または入力してください。";
    }
    return "";
  }

  function next() {
    const issue = stepIssue(step);
    if (issue) {
      setNotice(issue);
      return;
    }
    const target = Math.min(step + 1, steps.length - 1);
    setFurthestStep((current) => Math.max(current, target));
    setStep(target);
    setNotice(target === steps.length - 1 ? "入力のつながりを確認し、検証とDBプリフライトを実行してください。" : `${steps[target]}を入力してください。`);
  }

  async function validate() {
    setWorking(true);
    setErrors([]);
    setPreflight(null);
    setNotice("入力内容を検証しています。");
    try {
      const response = await fetch("/api/v2/contract-intakes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload())
      });
      const result = await response.json();
      if (!response.ok) {
        setErrors(result.errors ?? result.issues ?? []);
        setNotice("入力内容に修正が必要です。");
        return;
      }
      setNotice(`入力検証OK：素材${materials.length}件・イン条件${inbound.length}件をDBプリフライトできます。`);
    } catch {
      setNotice("入力検証APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function runPreflight() {
    setWorking(true);
    setErrors([]);
    setPreflight(null);
    setNotice("本番DBを読み取り、重複と参照先を確認しています。");
    try {
      const response = await fetch("/api/v2/contract-intakes/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload())
      });
      const result = await response.json();
      if (!response.ok && !result.preview) {
        setErrors(result.issues ?? []);
        setNotice(result.error ?? "DBプリフライトを実行できませんでした。");
        return;
      }
      setPreflight(result.preview);
      setNotice(result.preview?.committable
        ? "DBプリフライトOK：重複・参照エラーはありません。"
        : "DBプリフライトで登録を停止しました。既存データを確認してください。"
      );
    } catch {
      setNotice("DBプリフライトAPIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function commit() {
    if (!preflight?.committable || !canCommit || working) return;
    if (!window.confirm(`${contract.documentNumber} を締結済契約として本番DBへ登録します。登録後の自動削除・上書きは行いません。よろしいですか？`)) return;
    setWorking(true);
    setNotice("本番DBへ登録しています。");
    try {
      const response = await fetch("/api/v2/contract-intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmation: "COMMIT_PRODUCTION_CONTRACT_INTAKE",
          intake: payload()
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setErrors(result.blockers ?? result.preview?.blockers ?? []);
        setNotice(result.error ?? "本番DBへ登録できませんでした。");
        return;
      }
      setSaved(result.intake);
      setPreparedDrafts([]);
      setNotice(`登録完了：契約書番号 ${result.intake.documentNumber}。外部連携は実行されていません。`);
      loadRegistered();
    } catch {
      setNotice("登録APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function prepareDocumentDraft(
    templateType: "individual_license_terms" | "royalty_statement",
    documentId: number
  ) {
    if (!documentId || working) return;
    setWorking(true);
    setErrors([]);
    setNotice("登録済み契約から文書下書きを作成しています。");
    try {
      const response = await fetch(`/api/v2/contract-intakes/${documentId}/document-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateType })
      });
      const result = await response.json();
      if (!response.ok) {
        setErrors([{ field: templateType === "individual_license_terms" ? "アウト契約" : "文書作成", message: result.error ?? "文書下書きを作成できませんでした。" }]);
        setNotice("文書下書きの作成を停止しました。");
        return;
      }
      const created = result.drafts ?? [];
      setPreparedDrafts(created);
      if (created.length === 1) {
        onOpenDraft(created[0].issueKey, created[0].templateType);
        return;
      }
      setNotice(`許諾先ごとに${created.length}件の下書きを準備しました。確認する文書を選択してください。`);
    } catch {
      setNotice("文書下書き作成APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function selectRegistered(documentId: number) {
    setSelectedRegistered(documentId);
    setPreparedDrafts([]);
    setOutboundRows([]);
    setOutboundNotice("");
    setExistingOutbound([]);
    try {
      const response = await fetch(
        `/api/v2/contract-intakes/${documentId}/outbound-conditions`
      );
      if (response.ok) {
        const result = await response.json();
        setExistingOutbound(result.items ?? []);
      }
    } catch {
      setExistingOutbound([]);
    }
  }

  function updateOutboundRow(index: number, patch: Partial<ConditionInput>) {
    setOutboundRows((current) => current.map((row, candidate) =>
      candidate === index ? { ...row, condition: { ...row.condition, ...patch } } : row
    ));
    setOutboundNotice("");
  }

  async function appendOutbound(documentId: number) {
    if (working) return;
    if (!outboundRows.length) {
      setOutboundNotice("アウト条件を1件以上追加してください。");
      return;
    }
    if (outboundRows.some((row) => !row.counterpartyVendorId)) {
      setOutboundNotice("各アウト条件の許諾先を選択してください。");
      return;
    }
    if (!window.confirm(
      `選択した契約へアウト条件を${outboundRows.length}件、本番DBへ追記します。よろしいですか？`
    )) return;

    setWorking(true);
    setOutboundNotice("アウト条件を本番DBへ追記しています。");
    try {
      const response = await fetch(
        `/api/v2/contract-intakes/${documentId}/outbound-conditions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conditions: outboundRows.map((row) => ({
              ...conditionToPayload(row.condition),
              counterpartyVendorId: Number(row.counterpartyVendorId)
            }))
          })
        }
      );
      const result = await response.json();
      if (!response.ok) {
        setOutboundNotice(
          result.error ??
          result.errors?.map((item: { message: string }) => item.message).join("、") ??
          "アウト条件を追記できませんでした。"
        );
        return;
      }
      setOutboundRows([]);
      setOutboundNotice(`アウト条件を${result.appended.length}件追記しました。個別利用許諾条件書を作成できます。`);
      await selectRegistered(documentId);
      await loadRegistered();
    } catch {
      setOutboundNotice("アウト条件追記APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  return <section className="page contract-intake contract-chain-wizard">
    <div className="page-title">
      <div>
        <p>INBOUND CONTRACT INTAKE</p>
        <h1>締結済イン契約の登録</h1>
        <small>原作・素材・自社作品・イン条件を登録します。アウト条件は登録後、下の一覧から後日追加します</small>
      </div>
    </div>

    <div className="intake-safety">
      <strong>本番DB登録</strong>
      <span>入力 → 検証 → DBプリフライト → 管理者確定の順に進みます</span>
      <small>既存データの更新・削除、Slack・Backlog・Drive連携は行いません。</small>
    </div>

    <nav className="contract-chain-steps" aria-label="契約登録ステップ">
      {steps.map((label, index) => <button type="button" key={label}
        className={index === step ? "active" : index < step ? "done" : ""}
        disabled={index > furthestStep}
        onClick={() => setStep(index)}>
        <span>{index + 1}</span><strong>{label}</strong>
      </button>)}
    </nav>

    <div className="contract-chain-map" aria-label="権利と文書の流れ">
      <span>締結済イン契約</span><i>→</i><span>取得権利</span><i>→</i>
      <span>自社作品</span><i>→</i><span>登録・利用許諾料明細</span>
    </div>

    <section className="wizard-panel" hidden={step !== 0}>
      <header><p>STEP 1</p><h2>締結済イン契約</h2><small>当社が権利を取得した契約と、許諾者を最初に確定します。</small></header>
      <fieldset className="intake-contract">
        <legend>契約書・許諾者</legend>
        <div className="intake-fields">
          <label>契約書番号<input value={contract.documentNumber} onChange={(event) => updateContract({ documentNumber: event.target.value })} /></label>
          <label>契約名<input value={contract.contractTitle} onChange={(event) => updateContract({ contractTitle: event.target.value })} /></label>
          <SearchableLedgerSelect type="vendors" value={contract.primaryVendorId}
            label="許諾者・イン契約の相手方" placeholder="会社名・取引先コードで検索"
            helper="本契約で当社へ権利を許諾する相手方"
            onChange={(value, item) => updateContract({ primaryVendorId: value, primaryVendorName: item?.title ?? "" })} />
          <label>契約類型<select value={contract.contractType} onChange={(event) => updateContract({ contractType: event.target.value })}>
            <option value="license_basic">利用許諾契約</option>
            <option value="publication_license">出版利用許諾</option>
            <option value="license_master">ライセンス基本契約</option>
          </select></label>
          <label>締結日<input type="date" value={contract.executedAt} onChange={(event) => updateContract({ executedAt: event.target.value })} /></label>
          <label>効力発生日<input type="date" value={contract.effectiveDate} onChange={(event) => updateContract({ effectiveDate: event.target.value })} /></label>
          <label>契約終了日<input type="date" value={contract.expirationDate} onChange={(event) => updateContract({ expirationDate: event.target.value })} /></label>
          <label>契約書URL<input type="url" value={contract.documentUrl} onChange={(event) => updateContract({ documentUrl: event.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={contract.autoRenewal} onChange={(event) => updateContract({ autoRenewal: event.target.checked })} />自動更新あり</label>
          {contract.autoRenewal && <label>更新拒絶期限（月）<input type="number" min="0" value={contract.renewalNoticeMonths} onChange={(event) => updateContract({ renewalNoticeMonths: event.target.value })} /></label>}
          <label className="wide">許諾範囲・契約概要<textarea value={contract.scope} onChange={(event) => updateContract({ scope: event.target.value })} /></label>
        </div>
      </fieldset>
    </section>

    <section className="wizard-panel" hidden={step !== 1}>
      <header><p>STEP 2</p><h2>取得権利：原作・素材・イン条件</h2><small>何を、どの地域・言語・期間・金銭条件で取得したかを整理します。</small></header>
      <WorkEditor kind="source" value={sourceWork} onChange={(patch) => updateWork(setSourceWork, patch)} />
      <RepeaterHeader title="素材・マテリアル" action="＋ 素材を追加" onAdd={() => {
        setMaterials((current) => [...current, { ...initialMaterial(), isDefault: current.length === 0 }]);
        changed();
      }} />
      {materials.map((material, index) => <MaterialEditor key={index} value={material} index={index}
        removable={materials.length > 1}
        onChange={(patch) => updateMaterial(index, patch)}
        onRemove={() => { setMaterials((current) => current.filter((_, candidate) => candidate !== index)); changed(); }} />)}
      <RepeaterHeader title="イン条件（当社が取得・支払）" action="＋ イン条件を追加" onAdd={() => { setInbound((current) => [...current, initialCondition()]); changed(); }} />
      {inbound.map((condition, index) => <ConditionEditor key={index} value={condition}
        title={`イン条件 ${index + 1}`} materials={materials}
        onChange={(patch) => updateInbound(index, patch)}
        onRemove={inbound.length > 1 ? () => { setInbound((current) => current.filter((_, candidate) => candidate !== index)); changed(); } : undefined} />)}
    </section>

    <section className="wizard-panel" hidden={step !== 2}>
      <header><p>STEP 3</p><h2>自社作品</h2><small>取得した権利を利用して制作・販売する当社作品を紐づけます。</small></header>
      <WorkEditor kind="own" value={ownWork} onChange={(patch) => updateWork(setOwnWork, patch)} />
      <div className="rights-basis-note">
        <strong>権利根拠</strong>
        <span>{contract.contractTitle || "イン契約未入力"}</span>
        <span>{sourceWork.selectedTitle || sourceWork.title || "原作未入力"}</span>
        <span>→ {ownWork.selectedTitle || ownWork.title || "自社作品未入力"}</span>
      </div>
    </section>

    <section className="wizard-panel" hidden={step !== 3}>
      <header><p>STEP 4</p><h2>文書・DB確定</h2><small>権利の流れを確認してから、締結済イン契約を本番DBへ登録します。</small></header>
      <div className="chain-review">
        <article><span>イン契約</span><strong>{contract.documentNumber || "未入力"}</strong><small>{contract.primaryVendorName || "許諾者未選択"} → 当社</small></article>
        <i>→</i>
        <article><span>原作・取得権利</span><strong>{sourceWork.selectedTitle || sourceWork.title || "未入力"}</strong><small>素材 {materials.length}件 ／ イン条件 {inbound.length}件</small></article>
        <i>→</i>
        <article><span>自社作品</span><strong>{ownWork.selectedTitle || ownWork.title || "未入力"}</strong><small>イン契約を権利根拠として紐付け</small></article>
      </div>
      <div className="outbound-review">
        <p>登録後、利用許諾料明細書はイン条件の料率を引き継いで作成できます。アウト条件（許諾先ごとの個別利用許諾条件）は登録後に下の一覧から追加し、個別利用許諾条件書を作成します。</p>
      </div>

      <section className="intake-actions">
        <button type="button" onClick={validate} disabled={working}>1. 入力内容を検証</button>
        <button type="button" onClick={runPreflight} disabled={working}>2. DBプリフライト</button>
        <button type="button" className="primary" onClick={commit}
          disabled={working || !canCommit || !preflight?.committable || Boolean(saved)}>3. 本番DBへ確定登録</button>
        <span>{notice}</span>
      </section>

      {!canCommit && <div className="form-readonly-note">contract-intake専用書込ゲートが無効です。検証とDBプリフライトだけ利用できます。</div>}
      {(errors.length > 0 || preflight?.blockers.length) && <section className="panel intake-errors">
        <h2>確認事項</h2><ul>{(errors.length ? errors : preflight?.blockers ?? []).map((error, index) =>
          <li key={index}><strong>{error.field || "入力"}</strong><span>{error.message}</span></li>)}</ul>
      </section>}

      {saved && <section className="panel intake-result">
        <h2>登録結果</h2>
        <dl>
          <dt>契約書番号</dt><dd>{String(saved.documentNumber)}</dd>
          <dt>契約ID</dt><dd>{String(saved.contractId)}</dd>
          <dt>登録文書ID</dt><dd>{String(saved.documentId)}</dd>
          <dt>原作ID</dt><dd>{String(saved.sourceWorkId)}</dd>
          <dt>自社作品ID</dt><dd>{String(saved.ownWorkId)}</dd>
          <dt>素材ID</dt><dd>{(saved.materialIds as number[]).join("、")}</dd>
          <dt>イン条件ID</dt><dd>{(saved.inboundConditionIds as number[]).join("、")}</dd>
        </dl>
        <div className="intake-document-actions">
          <button type="button" onClick={() => prepareDocumentDraft("royalty_statement", Number(saved.documentId))} disabled={working}>利用許諾料明細書の下書きを作成</button>
          <small>個別利用許諾条件書は、下の「登録済み契約から文書を作成」でアウト条件を追加してから作成します。利用許諾料明細書の実績売上額・利用許諾料・控除・源泉徴収は、下書き画面で入力してください。</small>
        </div>
        {preparedDrafts.length > 1 && <div className="intake-prepared-drafts">
          {preparedDrafts.map((draft) => <button type="button" key={draft.issueKey} onClick={() => onOpenDraft(draft.issueKey, draft.templateType)}>
            <strong>{draft.label}</strong><span>{draft.counterpartyName}</span><small>{draft.created ? "新規作成" : "既存下書き"}</small>
          </button>)}
        </div>}
      </section>}
    </section>

    <footer className="wizard-navigation">
      <button type="button" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>← 前へ</button>
      <span>{notice}</span>
      {step < steps.length - 1 && <button type="button" className="primary" onClick={next}>次へ：{steps[step + 1]} →</button>}
    </footer>

    {registered.length > 0 && <section className="panel intake-registry">
      <div className="intake-registry-head">
        <h2>登録済み契約から文書を作成</h2>
        <button type="button" onClick={loadRegistered} disabled={working}>再読み込み</button>
      </div>
      <p>確定登録済みの契約を選択し、個別利用許諾条件書・利用許諾料明細書の下書きを作成できます。新規登録を完了しなくても既存契約から再作成できます。既存データの更新・削除は行いません。</p>
      <div className="intake-registry-list">
        {registered.map((item) => <button type="button" key={item.documentId}
          className={selectedRegistered === item.documentId ? "active" : ""}
          onClick={() => selectRegistered(item.documentId)}>
          <strong>{item.documentNumber}</strong>
          <span>{item.contractTitle}</span>
          <small>{[item.ownWorkTitle || item.sourceWorkTitle, item.primaryVendorName].filter(Boolean).join(" ／ ")}</small>
          <em>締結日 {item.executedAt}・イン{item.inboundConditionCount}／アウト{item.outboundConditionCount}</em>
        </button>)}
      </div>
      {(() => {
        const item = registered.find((candidate) => candidate.documentId === selectedRegistered);
        if (!item) return null;
        return <div className="intake-registry-detail">
          <div className="outbound-existing">
            <h3>登録済みアウト条件（許諾先ごと）</h3>
            {existingOutbound.length ? <ul>
              {existingOutbound.map((row) => <li key={row.conditionLineId}>
                <strong>{row.counterpartyName || "許諾先"}</strong>
                <span>{row.conditionName}</span>
                <small>{[row.territory, row.languages.join("・")].filter(Boolean).join(" ／ ")}
                  {row.ratePct !== undefined ? ` ／ 料率 ${row.ratePct}%` : ""}</small>
              </li>)}
            </ul> : <div className="inline-empty">
              アウト条件はまだありません。追加すると個別利用許諾条件書を作成できます。
            </div>}
          </div>

          <RepeaterHeader title="アウト条件を追加（許諾先ごと）"
            action="＋ アウト条件を追加"
            onAdd={() => setOutboundRows((current) => [...current, initialOutboundRow()])} />
          {outboundRows.map((row, index) => <fieldset className="outbound-agreement" key={row.id}>
            <legend>追加アウト条件 {index + 1}</legend>
            <div className="repeat-actions"><button type="button"
              onClick={() => setOutboundRows((current) =>
                current.filter((_, candidate) => candidate !== index))}>削除</button></div>
            <SearchableLedgerSelect type="vendors" value={row.counterpartyVendorId}
              label="許諾先（被許諾者・買主）" placeholder="会社名・取引先コードで検索"
              helper="このアウト条件の文書相手方"
              onChange={(value, vendor) => setOutboundRows((current) =>
                current.map((candidate, candidateIndex) => candidateIndex === index
                  ? { ...candidate, counterpartyVendorId: value, counterpartyName: vendor?.title ?? "" }
                  : candidate))} />
            <ConditionEditor value={row.condition} title="アウト条件" materials={[]}
              onChange={(patch) => updateOutboundRow(index, patch)} />
          </fieldset>)}

          {outboundRows.length > 0 && <div className="outbound-append-actions">
            <button type="button" className="primary"
              onClick={() => appendOutbound(item.documentId)}
              disabled={working || !canCommit}>本番DBへアウト条件を追記</button>
            {!canCommit && <small>contract-intake書込ゲートが無効のため追記できません。</small>}
          </div>}
          {outboundNotice && <p className="outbound-notice">{outboundNotice}</p>}

          <div className="intake-document-actions">
            <button type="button"
              onClick={() => prepareDocumentDraft("individual_license_terms", item.documentId)}
              disabled={working || item.outboundConditionCount === 0}
              title={item.outboundConditionCount === 0 ? "アウト条件を追加すると作成できます" : undefined}>個別利用許諾条件書の下書きを作成</button>
            <button type="button"
              onClick={() => prepareDocumentDraft("royalty_statement", item.documentId)}
              disabled={working}>利用許諾料明細書の下書きを作成</button>
            <small>利用許諾料明細書の実績売上額・利用許諾料・控除・源泉徴収は、下書き画面で確認して入力してください。</small>
          </div>
        </div>;
      })()}
      {selectedRegistered && preparedDrafts.length > 1 && <div className="intake-prepared-drafts">
        {preparedDrafts.map((draft) => <button type="button" key={draft.issueKey} onClick={() => onOpenDraft(draft.issueKey, draft.templateType)}>
          <strong>{draft.label}</strong><span>{draft.counterpartyName}</span><small>{draft.created ? "新規作成" : "既存下書き"}</small>
        </button>)}
      </div>}
    </section>}
  </section>;
}

function ModeSelect({ value, onChange, existingLabel = "登録済みから選択", newLabel = "新規登録" }: {
  value: "existing" | "new";
  onChange: (value: "existing" | "new") => void;
  existingLabel?: string;
  newLabel?: string;
}) {
  return <div className="intake-mode">
    <button type="button" className={value === "existing" ? "active" : ""} onClick={() => onChange("existing")}>{existingLabel}</button>
    <button type="button" className={value === "new" ? "active" : ""} onClick={() => onChange("new")}>{newLabel}</button>
  </div>;
}

function WorkEditor({ kind, value, onChange }: {
  kind: "source" | "own";
  value: WorkInput;
  onChange: (patch: Partial<WorkInput>) => void;
}) {
  const isSource = kind === "source";
  const filter = (item: SearchableLedgerItem) => isCanonicalWork(item) && (
    isSource ? /原作・ライセンスイン/.test(item.subtitle) : /自社作品/.test(item.subtitle)
  );
  return <fieldset className="work-editor">
    <legend>{isSource ? "原作・ライセンスイン作品" : "自社作品"}</legend>
    <ModeSelect value={value.mode} onChange={(mode) => onChange({ mode, existingWorkId: "", selectedTitle: "", title: "" })} />
    {value.mode === "existing" ? <SearchableLedgerSelect type="works" value={value.existingWorkId}
      label={isSource ? "登録済み原作" : "登録済み自社作品"}
      placeholder="作品名・作品コードで検索" filter={filter}
      onChange={(existingWorkId, item) => onChange({ existingWorkId, selectedTitle: item?.title ?? "" })} /> : <div className="intake-fields">
      <label>{isSource ? "原作名" : "作品名"}<input value={value.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <WorkType value={value.workType} onChange={(workType) => onChange({ workType })} />
      {!isSource && <label>進行状態<select value={value.status} onChange={(event) => onChange({ status: event.target.value as WorkInput["status"] })}>
        <option value="">未設定</option><option value="planning">企画中</option><option value="in_production">制作中</option><option value="released">発売済み</option>
      </select></label>}
    </div>}
  </fieldset>;
}

function WorkType({ value, onChange }: { value: WorkInput["workType"]; onChange: (value: WorkInput["workType"]) => void }) {
  return <label>作品種別<select value={value} onChange={(event) => onChange(event.target.value as WorkInput["workType"])}>
    <option value="board_game">ボードゲーム</option><option value="trpg_book">TRPG・書籍</option><option value="other">その他</option>
  </select></label>;
}

function MaterialEditor({ value, index, removable, onChange, onRemove }: {
  value: MaterialInput;
  index: number;
  removable: boolean;
  onChange: (patch: Partial<MaterialInput>) => void;
  onRemove: () => void;
}) {
  return <fieldset className="intake-repeat">
    <legend>素材 {index + 1}</legend>
    {removable && <div className="repeat-actions"><button type="button" onClick={onRemove}>削除</button></div>}
    <ModeSelect value={value.mode} existingLabel="登録済み素材" newLabel="新規素材" onChange={(mode) => onChange({ mode, existingMaterialId: "", selectedTitle: "", materialName: "" })} />
    {value.mode === "existing" ? <SearchableLedgerSelect type="materials" value={value.existingMaterialId}
      label="登録済み素材" placeholder="素材名・素材コード・作品名で検索"
      onChange={(existingMaterialId, item) => onChange({ existingMaterialId, selectedTitle: item?.title ?? "" })} /> : <div className="intake-fields">
      <label>素材名<input value={value.materialName} onChange={(event) => onChange({ materialName: event.target.value })} /></label>
      <label>素材類型<select value={value.materialType} onChange={(event) => onChange({ materialType: event.target.value as MaterialInput["materialType"] })}>
        <option value="game_design">ゲームデザイン</option><option value="illustration">イラスト</option><option value="scenario">シナリオ</option><option value="manuscript">原稿</option><option value="other">その他</option>
      </select></label>
      <label>構成上の役割<select value={value.materialRole} onChange={(event) => onChange({ materialRole: event.target.value as MaterialInput["materialRole"] })}>
        <option value="core_logic">中核要素</option><option value="sub_component">追加構成要素</option>
      </select></label>
      <label>取得区分<select value={value.acquisitionType} onChange={(event) => onChange({ acquisitionType: event.target.value as MaterialInput["acquisitionType"] })}>
        <option value="license">利用許諾</option><option value="buyout_commission">買取・委託</option><option value="in_house">自社制作</option>
      </select></label>
      <label>権利区分<select value={value.rightsType} onChange={(event) => onChange({ rightsType: event.target.value as MaterialInput["rightsType"] })}>
        <option value="license">許諾</option><option value="owned">自社保有</option>
      </select></label>
      <label className="check"><input type="checkbox" checked={value.isDefault} onChange={(event) => onChange({ isDefault: event.target.checked })} />代表素材</label>
      <label className="check"><input type="checkbox" checked={value.isRoyaltyBearing} onChange={(event) => onChange({ isRoyaltyBearing: event.target.checked })} />ロイヤリティ対象</label>
    </div>}
  </fieldset>;
}

function RepeaterHeader({ title, action, onAdd }: { title: string; action: string; onAdd: () => void }) {
  return <div className="repeater-title intake-repeater-title"><h2>{title}</h2><button type="button" onClick={onAdd}>{action}</button></div>;
}

function ConditionEditor({ value, title, materials, inbound, fixedTransactionKind, onChange, onRemove }: {
  value: ConditionInput | OutboundCondition;
  title: string;
  materials: MaterialInput[];
  inbound?: ConditionInput[];
  fixedTransactionKind?: "license" | "product";
  onChange: (patch: Partial<ConditionInput & OutboundCondition>) => void;
  onRemove?: () => void;
}) {
  const outbound = "parentInboundIndex" in value;
  return <fieldset className="intake-repeat intake-condition">
    <legend>{title}</legend>
    {onRemove && <div className="repeat-actions"><button type="button" onClick={onRemove}>削除</button></div>}
    <div className="intake-fields">
      <label>条件名<input value={value.conditionName} onChange={(event) => onChange({ conditionName: event.target.value })} /></label>
      {outbound && <label>根拠イン条件<select value={value.parentInboundIndex} onChange={(event) => onChange({ parentInboundIndex: event.target.value })}>
        {inbound?.map((condition, index) => <option key={index} value={index}>{index + 1}. {condition.conditionName || "名称未入力"}</option>)}
      </select></label>}
      <label>対象素材<select value={value.materialIndex} onChange={(event) => onChange({ materialIndex: event.target.value })}>
        <option value="">素材を指定しない</option>
        {materials.map((material, index) => <option key={index} value={index}>{index + 1}. {material.mode === "existing" ? material.selectedTitle || `既存素材ID ${material.existingMaterialId || "未入力"}` : material.materialName || "名称未入力"}</option>)}
      </select></label>
      {fixedTransactionKind ? <label>取引類型<input value={fixedTransactionKind === "license" ? "ライセンス" : "製品"} readOnly /></label> : <label>取引類型<select value={value.transactionKind} onChange={(event) => onChange({ transactionKind: event.target.value as ConditionInput["transactionKind"] })}>
        <option value="license">ライセンス</option><option value="product">製品</option><option value="service">役務</option>
      </select></label>}
      <label>地域<input value={value.territory} onChange={(event) => onChange({ territory: event.target.value })} placeholder="例：日本国内" /></label>
      <label>言語<input value={value.languages} onChange={(event) => onChange({ languages: event.target.value })} placeholder="カンマ区切り" /></label>
      <label>独占性<select value={value.exclusivity} onChange={(event) => onChange({ exclusivity: event.target.value as ConditionInput["exclusivity"] })}>
        <option value="non_exclusive">非独占</option><option value="exclusive">独占</option><option value="sole">ソール</option>
      </select></label>
      <label className="check"><input type="checkbox" checked={value.sublicenseAllowed} onChange={(event) => onChange({ sublicenseAllowed: event.target.checked })} />再許諾可</label>
      <label>開始日<input type="date" value={value.termStart} onChange={(event) => onChange({ termStart: event.target.value })} /></label>
      <label>終了日<input type="date" value={value.termEnd} onChange={(event) => onChange({ termEnd: event.target.value })} /></label>
      <label>通貨<input value={value.currency} maxLength={3} onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })} /></label>
      <label>金額方式<select value={value.paymentScheme} onChange={(event) => onChange({ paymentScheme: event.target.value as ConditionInput["paymentScheme"] })}>
        <option value="royalty">ロイヤリティ</option><option value="per_unit">単価</option><option value="lump_sum">一括金額</option><option value="installment">分割払い</option><option value="subscription">定額払い</option>
      </select></label>
      {value.paymentScheme === "royalty" ? <>
        <label>料率（%）<input type="number" min="0" max="100" step="0.01" value={value.ratePct} onChange={(event) => onChange({ ratePct: event.target.value })} /></label>
        <label>MG<input type="number" min="0" value={value.mgAmount} onChange={(event) => onChange({ mgAmount: event.target.value })} /></label>
        <label>Advance<input type="number" min="0" value={value.advanceAmount} onChange={(event) => onChange({ advanceAmount: event.target.value })} /></label>
        <label>算定基礎<input value={value.royaltyBase} onChange={(event) => onChange({ royaltyBase: event.target.value })} /></label>
        <label>控除費用<input value={value.deductibleCosts} onChange={(event) => onChange({ deductibleCosts: event.target.value })} /></label>
      </> : <label>税抜金額<input type="number" min="0" value={value.amountExTax} onChange={(event) => onChange({ amountExTax: event.target.value })} /></label>}
      {fixedTransactionKind === "product" && <>
        <label>最低数量<input type="number" min="0" value={value.minimumQuantity} onChange={(event) => onChange({ minimumQuantity: event.target.value })} /></label>
        <label>Sell-Off（月）<input type="number" min="0" value={value.sellOffMonths} onChange={(event) => onChange({ sellOffMonths: event.target.value })} /></label>
        <label>Incoterms<input value={value.incoterms} onChange={(event) => onChange({ incoterms: event.target.value })} /></label>
      </>}
      <label>報告周期<input value={value.reportingCycle} onChange={(event) => onChange({ reportingCycle: event.target.value })} /></label>
      <label>支払条件<input value={value.paymentTerms} onChange={(event) => onChange({ paymentTerms: event.target.value })} /></label>
      <label>海外源泉税<input value={value.withholdingTaxTreatment} onChange={(event) => onChange({ withholdingTaxTreatment: event.target.value })} /></label>
      <label className="wide">備考<textarea value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label>
    </div>
  </fieldset>;
}
