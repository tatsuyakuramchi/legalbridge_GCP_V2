import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

type LedgerItem = {
  id: string;
  code: string;
  title: string;
  subtitle: string;
};

type WorkInput = {
  mode: "existing" | "new";
  existingWorkId: string;
  title: string;
  workType: "board_game" | "trpg_book" | "other";
  status: "" | "planning" | "in_production" | "released";
};

type MaterialInput = {
  mode: "new" | "existing";
  existingMaterialId: string;
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
  notes: string;
};

type OutboundInput = ConditionInput & {
  counterpartyVendorId: string;
  parentInboundIndex: string;
};

type ContractForm = {
  documentNumber: string;
  contractTitle: string;
  primaryVendorId: string;
  contractType: string;
  executedAt: string;
  effectiveDate: string;
  expirationDate: string;
  autoRenewal: boolean;
  renewalNoticeMonths: string;
  scope: string;
  documentUrl: string;
};

const initialWork = (kind: "source" | "own"): WorkInput => ({
  mode: "new",
  existingWorkId: "",
  title: "",
  workType: "board_game",
  status: kind === "own" ? "planning" : ""
});

const initialMaterial = (): MaterialInput => ({
  mode: "new",
  existingMaterialId: "",
  materialName: "",
  materialType: "game_design",
  materialRole: "core_logic",
  acquisitionType: "license",
  rightsType: "license",
  isDefault: true,
  isRoyaltyBearing: true
});

const initialCondition = (): ConditionInput => ({
  conditionName: "原作利用許諾条件",
  transactionKind: "license",
  materialIndex: "0",
  territory: "",
  languages: "日本語",
  exclusivity: "non_exclusive",
  sublicenseAllowed: false,
  termStart: "",
  termEnd: "",
  currency: "JPY",
  paymentScheme: "royalty",
  ratePct: "",
  amountExTax: "",
  mgAmount: "",
  advanceAmount: "",
  reportingCycle: "",
  paymentTerms: "",
  royaltyBase: "純売上額",
  deductibleCosts: "",
  withholdingTaxTreatment: "",
  notes: ""
});

const initialContract = (): ContractForm => ({
  documentNumber: "",
  contractTitle: "",
  primaryVendorId: "",
  contractType: "license_basic",
  executedAt: "",
  effectiveDate: "",
  expirationDate: "",
  autoRenewal: false,
  renewalNoticeMonths: "",
  scope: "",
  documentUrl: ""
});

export function ContractIntakeWorkspace({
  canCommit,
  onOpenDraft
}: {
  canCommit: boolean;
  onOpenDraft: (issueKey: string, templateType: string) => void;
}) {
  const [sourceWork, setSourceWork] = useState(() => initialWork("source"));
  const [ownWork, setOwnWork] = useState(() => initialWork("own"));
  const [materials, setMaterials] = useState<MaterialInput[]>([initialMaterial()]);
  const [contract, setContract] = useState<ContractForm>(initialContract);
  const [inbound, setInbound] = useState<ConditionInput[]>([initialCondition()]);
  const [outbound, setOutbound] = useState<OutboundInput[]>([]);
  const [works, setWorks] = useState<LedgerItem[]>([]);
  const [vendors, setVendors] = useState<LedgerItem[]>([]);
  const [notice, setNotice] = useState(
    "入力検証とDBプリフライトでは本番データを変更しません。"
  );
  const [errors, setErrors] = useState<Array<{ field: string; message: string }>>([]);
  const [preflight, setPreflight] = useState<{
    committable: boolean;
    blockers: Array<{ code: string; field: string; message: string }>;
  } | null>(null);
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  const [preparedDrafts, setPreparedDrafts] = useState<Array<{
    issueKey: string;
    templateType: string;
    label: string;
    counterpartyName: string;
    created: boolean;
  }>>([]);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/v2/ledgers/works?limit=500").then((response) =>
        response.ok ? response.json() : Promise.reject()
      ),
      fetch("/api/v2/ledgers/vendors?limit=500").then((response) =>
        response.ok ? response.json() : Promise.reject()
      )
    ]).then(([workData, vendorData]) => {
      setWorks(workData.items ?? []);
      setVendors(vendorData.items ?? []);
    }).catch(() => {
      setNotice("作品または取引先の候補を取得できませんでした。");
    });
  }, []);

  const sourceWorks = useMemo(
    () => works.filter((item) =>
      /原作|licensed_in/i.test(item.subtitle)
    ),
    [works]
  );
  const ownWorks = useMemo(
    () => works.filter((item) =>
      /自社作品|\bown\b/i.test(item.subtitle)
    ),
    [works]
  );

  function changed(message = "入力内容が変更されました。再度プリフライトしてください。") {
    setPreflight(null);
    setSaved(null);
    setPreparedDrafts([]);
    setErrors([]);
    setNotice(message);
  }

  function updateWork(
    setter: Dispatch<SetStateAction<WorkInput>>,
    patch: Partial<WorkInput>
  ) {
    setter((current) => ({ ...current, ...patch }));
    changed();
  }

  function updateMaterial(index: number, patch: Partial<MaterialInput>) {
    setMaterials((current) =>
      current.map((item, candidate) =>
        candidate === index ? { ...item, ...patch } : item
      )
    );
    changed();
  }

  function updateCondition(
    direction: "inbound" | "outbound",
    index: number,
    patch: Partial<ConditionInput & OutboundInput>
  ) {
    if (direction === "inbound") {
      setInbound((current) =>
        current.map((item, candidate) =>
          candidate === index ? { ...item, ...patch } : item
        )
      );
    } else {
      setOutbound((current) =>
        current.map((item, candidate) =>
          candidate === index ? { ...item, ...patch } : item
        )
      );
    }
    changed();
  }

  function payload() {
    const number = (value: string) => value === "" ? undefined : Number(value);
    const text = (value: string) => value.trim() || undefined;
    const workPayload = (value: WorkInput) => value.mode === "existing"
      ? { existingWorkId: Number(value.existingWorkId) }
      : {
          title: value.title.trim(),
          workType: value.workType,
          status: value.status || undefined
        };
    const conditionPayload = (value: ConditionInput) => ({
      conditionName: value.conditionName.trim(),
      transactionKind: value.transactionKind,
      materialIndex: number(value.materialIndex),
      territory: value.territory.trim(),
      languages: value.languages
        .split(/[,、]/)
        .map((item) => item.trim())
        .filter(Boolean),
      exclusivity: value.exclusivity,
      sublicenseAllowed: value.sublicenseAllowed,
      termStart: text(value.termStart),
      termEnd: text(value.termEnd),
      currency: value.currency.trim().toUpperCase(),
      paymentScheme: value.paymentScheme,
      ratePct: number(value.ratePct),
      amountExTax: number(value.amountExTax),
      mgAmount: number(value.mgAmount),
      advanceAmount: number(value.advanceAmount),
      reportingCycle: text(value.reportingCycle),
      paymentTerms: text(value.paymentTerms),
      royaltyBase: text(value.royaltyBase),
      deductibleCosts: text(value.deductibleCosts),
      withholdingTaxTreatment: text(value.withholdingTaxTreatment),
      notes: text(value.notes)
    });

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
        effectiveDate: text(contract.effectiveDate),
        expirationDate: text(contract.expirationDate),
        autoRenewal: contract.autoRenewal,
        renewalNoticeMonths: number(contract.renewalNoticeMonths),
        scope: text(contract.scope),
        documentUrl: text(contract.documentUrl)
      },
      inboundConditions: inbound.map(conditionPayload),
      outboundConditions: outbound.map((value) => ({
        ...conditionPayload(value),
        counterpartyVendorId: Number(value.counterpartyVendorId),
        parentInboundIndex: Number(value.parentInboundIndex)
      }))
    };
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
      setNotice(
        `入力検証OK：原作・作品・素材${materials.length}件・イン条件${inbound.length}件をDBプリフライトできます。`
      );
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
    if (!window.confirm(
      `${contract.documentNumber} を締結済契約として本番DBへ登録します。登録後の自動削除・上書きは行いません。よろしいですか？`
    )) return;

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
        const blockers = result.blockers ?? result.preview?.blockers ?? [];
        setErrors(blockers);
        setNotice(result.error ?? "本番DBへ登録できませんでした。");
        return;
      }
      setSaved(result.intake);
      setPreparedDrafts([]);
      setNotice(
        `登録完了：契約書番号 ${result.intake.documentNumber}。外部連携は実行されていません。`
      );
    } catch {
      setNotice("登録APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function prepareDocumentDraft(
    templateType: "individual_license_terms" | "royalty_statement"
  ) {
    if (!saved || working) return;
    setWorking(true);
    setErrors([]);
    setNotice("登録済み契約から文書下書きを作成しています。");
    try {
      const response = await fetch(
        `/api/v2/contract-intakes/${Number(saved.documentId)}/document-drafts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateType })
        }
      );
      const result = await response.json();
      if (!response.ok) {
        setErrors([{
          field: templateType === "individual_license_terms"
            ? "アウト条件"
            : "文書作成",
          message: result.error ?? "文書下書きを作成できませんでした。"
        }]);
        setNotice("文書下書きの作成を停止しました。");
        return;
      }
      const created = result.drafts ?? [];
      setPreparedDrafts(created);
      if (created.length === 1) {
        onOpenDraft(created[0].issueKey, created[0].templateType);
        return;
      }
      setNotice(
        `許諾先ごとに${created.length}件の下書きを準備しました。確認する文書を選択してください。`
      );
    } catch {
      setNotice("文書下書き作成APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  return <section className="page contract-intake">
    <div className="page-title">
      <div>
        <p>CONCLUDED CONTRACT INTAKE</p>
        <h1>締結済利用許諾契約の登録</h1>
        <small>原作・自社作品・素材・権利根拠・イン条件を一括登録します</small>
      </div>
    </div>

    <div className="intake-safety">
      <strong>本番DB登録</strong>
      <span>検証 → DBプリフライト → 管理者による確定の順に進みます</span>
      <small>既存データの更新・削除、Slack・Backlog・Drive連携は行いません。</small>
    </div>

    <div className="intake-grid">
      <fieldset>
        <legend>1. 原作</legend>
        <ModeSelect value={sourceWork.mode}
          onChange={(mode) => updateWork(setSourceWork, {
            mode, existingWorkId: "", title: ""
          })} />
        {sourceWork.mode === "existing"
          ? <label>登録済み原作
              <select value={sourceWork.existingWorkId}
                onChange={(event) => updateWork(setSourceWork, {
                  existingWorkId: event.target.value
                })}>
                <option value="">選択してください</option>
                {sourceWorks.map((item) =>
                  <option key={item.id} value={item.id}>
                    {item.code} {item.title}
                  </option>)}
              </select>
            </label>
          : <>
              <label>原作名
                <input value={sourceWork.title}
                  onChange={(event) => updateWork(setSourceWork, {
                    title: event.target.value
                  })} />
              </label>
              <WorkType value={sourceWork.workType}
                onChange={(workType) => updateWork(setSourceWork, { workType })} />
            </>}
      </fieldset>

      <fieldset>
        <legend>2. 自社作品</legend>
        <ModeSelect value={ownWork.mode}
          onChange={(mode) => updateWork(setOwnWork, {
            mode, existingWorkId: "", title: ""
          })} />
        {ownWork.mode === "existing"
          ? <label>登録済み自社作品
              <select value={ownWork.existingWorkId}
                onChange={(event) => updateWork(setOwnWork, {
                  existingWorkId: event.target.value
                })}>
                <option value="">選択してください</option>
                {ownWorks.map((item) =>
                  <option key={item.id} value={item.id}>
                    {item.code} {item.title}
                  </option>)}
              </select>
            </label>
          : <>
              <label>作品名
                <input value={ownWork.title}
                  onChange={(event) => updateWork(setOwnWork, {
                    title: event.target.value
                  })} />
              </label>
              <WorkType value={ownWork.workType}
                onChange={(workType) => updateWork(setOwnWork, { workType })} />
              <label>進行状態
                <select value={ownWork.status}
                  onChange={(event) => updateWork(setOwnWork, {
                    status: event.target.value as WorkInput["status"]
                  })}>
                  <option value="">未設定</option>
                  <option value="planning">企画中</option>
                  <option value="in_production">制作中</option>
                  <option value="released">発売済み</option>
                </select>
              </label>
            </>}
      </fieldset>
    </div>

    <fieldset className="intake-contract">
      <legend>3. 締結済契約書</legend>
      <div className="intake-fields">
        <label>契約書番号
          <input value={contract.documentNumber}
            onChange={(event) => {
              setContract((current) => ({
                ...current, documentNumber: event.target.value
              }));
              changed();
            }} />
        </label>
        <label>契約名
          <input value={contract.contractTitle}
            onChange={(event) => {
              setContract((current) => ({
                ...current, contractTitle: event.target.value
              }));
              changed();
            }} />
        </label>
        <label>許諾者・契約相手
          <select value={contract.primaryVendorId}
            onChange={(event) => {
              setContract((current) => ({
                ...current, primaryVendorId: event.target.value
              }));
              changed();
            }}>
            <option value="">選択してください</option>
            {vendors.map((item) => <option key={item.id} value={item.id}>
              {item.code} {item.title}
            </option>)}
          </select>
        </label>
        <label>契約類型
          <select value={contract.contractType}
            onChange={(event) => {
              setContract((current) => ({
                ...current, contractType: event.target.value
              }));
              changed();
            }}>
            <option value="license_basic">利用許諾契約</option>
            <option value="publication_license">出版利用許諾</option>
            <option value="license_master">ライセンス基本契約</option>
          </select>
        </label>
        <label>締結日
          <input type="date" value={contract.executedAt}
            onChange={(event) => {
              setContract((current) => ({
                ...current, executedAt: event.target.value
              }));
              changed();
            }} />
        </label>
        <label>効力発生日
          <input type="date" value={contract.effectiveDate}
            onChange={(event) => {
              setContract((current) => ({
                ...current, effectiveDate: event.target.value
              }));
              changed();
            }} />
        </label>
        <label>契約終了日
          <input type="date" value={contract.expirationDate}
            onChange={(event) => {
              setContract((current) => ({
                ...current, expirationDate: event.target.value
              }));
              changed();
            }} />
        </label>
        <label>契約書URL
          <input type="url" value={contract.documentUrl}
            onChange={(event) => {
              setContract((current) => ({
                ...current, documentUrl: event.target.value
              }));
              changed();
            }} />
        </label>
        <label className="wide">許諾範囲・契約概要
          <textarea value={contract.scope}
            onChange={(event) => {
              setContract((current) => ({
                ...current, scope: event.target.value
              }));
              changed();
            }} />
        </label>
      </div>
    </fieldset>

    <RepeaterHeader title="4. マテリアル"
      action="＋ 素材を追加"
      onAdd={() => {
        setMaterials((current) => [...current, {
          ...initialMaterial(), isDefault: current.length === 0
        }]);
        changed();
      }} />
    {materials.map((material, index) =>
      <fieldset className="intake-repeat" key={index}>
        <legend>素材 {index + 1}</legend>
        <div className="repeat-actions">
          {materials.length > 1 && <button type="button"
            onClick={() => {
              setMaterials((current) => current.filter((_, i) => i !== index));
              changed();
            }}>削除</button>}
        </div>
        <ModeSelect value={material.mode}
          existingLabel="既存素材ID"
          newLabel="新規素材"
          onChange={(mode) => updateMaterial(index, {
            mode, existingMaterialId: "", materialName: ""
          })} />
        {material.mode === "existing"
          ? <label>既存素材ID
              <input type="number" min="1" value={material.existingMaterialId}
                onChange={(event) => updateMaterial(index, {
                  existingMaterialId: event.target.value
                })} />
            </label>
          : <div className="intake-fields">
              <label>素材名
                <input value={material.materialName}
                  onChange={(event) => updateMaterial(index, {
                    materialName: event.target.value
                  })} />
              </label>
              <label>素材類型
                <select value={material.materialType}
                  onChange={(event) => updateMaterial(index, {
                    materialType: event.target.value as MaterialInput["materialType"]
                  })}>
                  <option value="game_design">ゲームデザイン</option>
                  <option value="illustration">イラスト</option>
                  <option value="scenario">シナリオ</option>
                  <option value="manuscript">原稿</option>
                  <option value="other">その他</option>
                </select>
              </label>
              <label>構成上の役割
                <select value={material.materialRole}
                  onChange={(event) => updateMaterial(index, {
                    materialRole: event.target.value as MaterialInput["materialRole"]
                  })}>
                  <option value="core_logic">中核要素</option>
                  <option value="sub_component">追加構成要素</option>
                </select>
              </label>
              <label>取得区分
                <select value={material.acquisitionType}
                  onChange={(event) => updateMaterial(index, {
                    acquisitionType: event.target.value as MaterialInput["acquisitionType"]
                  })}>
                  <option value="license">利用許諾</option>
                  <option value="buyout_commission">買取・委託</option>
                  <option value="in_house">自社制作</option>
                </select>
              </label>
              <label>権利区分
                <select value={material.rightsType}
                  onChange={(event) => updateMaterial(index, {
                    rightsType: event.target.value as MaterialInput["rightsType"]
                  })}>
                  <option value="license">許諾</option>
                  <option value="owned">自社保有</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={material.isDefault}
                  onChange={(event) => updateMaterial(index, {
                    isDefault: event.target.checked
                  })} />
                代表素材
              </label>
              <label className="check">
                <input type="checkbox" checked={material.isRoyaltyBearing}
                  onChange={(event) => updateMaterial(index, {
                    isRoyaltyBearing: event.target.checked
                  })} />
                ロイヤリティ対象
              </label>
            </div>}
      </fieldset>)}

    <RepeaterHeader title="5. イン条件"
      action="＋ イン条件を追加"
      onAdd={() => {
        setInbound((current) => [...current, initialCondition()]);
        changed();
      }} />
    {inbound.map((condition, index) =>
      <ConditionEditor key={index} value={condition}
        title={`イン条件 ${index + 1}（当社支払）`}
        materials={materials}
        onChange={(patch) => updateCondition("inbound", index, patch)}
        onRemove={inbound.length > 1 ? () => {
          setInbound((current) => current.filter((_, i) => i !== index));
          changed();
        } : undefined} />)}

    <RepeaterHeader title="6. アウト条件（任意）"
      action="＋ アウト条件を追加"
      onAdd={() => {
        setOutbound((current) => [...current, {
          ...initialCondition(),
          conditionName: "個別利用許諾条件",
          counterpartyVendorId: "",
          parentInboundIndex: "0"
        }]);
        changed();
      }} />
    {!outbound.length &&
      <div className="inline-empty">アウト条件は後から個別利用許諾条件書で追加できます。</div>}
    {outbound.map((condition, index) =>
      <ConditionEditor key={index} value={condition}
        title={`アウト条件 ${index + 1}（当社受取）`}
        materials={materials}
        vendors={vendors}
        inboundCount={inbound.length}
        onChange={(patch) => updateCondition("outbound", index, patch)}
        onRemove={() => {
          setOutbound((current) => current.filter((_, i) => i !== index));
          changed();
        }} />)}

    <section className="intake-actions">
      <button type="button" onClick={validate} disabled={working}>
        1. 入力内容を検証
      </button>
      <button type="button" onClick={runPreflight} disabled={working}>
        2. DBプリフライト
      </button>
      <button type="button" className="primary" onClick={commit}
        disabled={working || !canCommit || !preflight?.committable || Boolean(saved)}>
        3. 本番DBへ確定登録
      </button>
      <span>{notice}</span>
    </section>

    {!canCommit &&
      <div className="form-readonly-note">
        contract-intake専用書込ゲートが無効です。検証とDBプリフライトだけ利用できます。
      </div>}

    {(errors.length > 0 || preflight?.blockers.length) &&
      <section className="panel intake-errors">
        <h2>確認事項</h2>
        <ul>
          {(errors.length ? errors : preflight?.blockers ?? []).map((error, index) =>
            <li key={index}>
              <strong>{error.field || "入力"}</strong>
              <span>{error.message}</span>
            </li>)}
        </ul>
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
        <dt>文書化待ちアウト条件</dt>
        <dd>{String(saved.outboundConditionsPendingDocument)}件</dd>
      </dl>
      <p>
        原契約・作品・素材・イン条件は登録済みです。個別利用許諾条件書は
        アウト条件を許諾先ごとに分割し、利用許諾料明細書は契約条件と料率を
        引き継いだ下書きを作成します。
      </p>
      <div className="intake-document-actions">
        <button type="button"
          onClick={() => prepareDocumentDraft("individual_license_terms")}
          disabled={working}>
          個別利用許諾条件書の下書きを作成
        </button>
        <button type="button"
          onClick={() => prepareDocumentDraft("royalty_statement")}
          disabled={working}>
          利用許諾料明細書の下書きを作成
        </button>
        <small>
          利用許諾料明細書の実績売上額・利用許諾料・控除・源泉徴収は、
          下書き画面で確認して入力してください。
        </small>
      </div>
      {preparedDrafts.length > 1 && (
        <div className="intake-prepared-drafts">
          {preparedDrafts.map((draft) => (
            <button type="button" key={draft.issueKey}
              onClick={() => onOpenDraft(draft.issueKey, draft.templateType)}>
              <strong>{draft.label}</strong>
              <span>{draft.counterpartyName}</span>
              <small>{draft.created ? "新規作成" : "既存下書き"}</small>
            </button>
          ))}
        </div>
      )}
    </section>}
  </section>;
}

function ModeSelect({
  value,
  onChange,
  existingLabel = "登録済みから選択",
  newLabel = "新規登録"
}: {
  value: "existing" | "new";
  onChange: (value: "existing" | "new") => void;
  existingLabel?: string;
  newLabel?: string;
}) {
  return <div className="intake-mode">
    <button type="button" className={value === "existing" ? "active" : ""}
      onClick={() => onChange("existing")}>{existingLabel}</button>
    <button type="button" className={value === "new" ? "active" : ""}
      onClick={() => onChange("new")}>{newLabel}</button>
  </div>;
}

function WorkType({
  value,
  onChange
}: {
  value: WorkInput["workType"];
  onChange: (value: WorkInput["workType"]) => void;
}) {
  return <label>作品種別
    <select value={value}
      onChange={(event) => onChange(event.target.value as WorkInput["workType"])}>
      <option value="board_game">ボードゲーム</option>
      <option value="trpg_book">TRPG・書籍</option>
      <option value="other">その他</option>
    </select>
  </label>;
}

function RepeaterHeader({
  title,
  action,
  onAdd
}: {
  title: string;
  action: string;
  onAdd: () => void;
}) {
  return <div className="repeater-title intake-repeater-title">
    <h2>{title}</h2>
    <button type="button" onClick={onAdd}>{action}</button>
  </div>;
}

function ConditionEditor({
  value,
  title,
  materials,
  vendors,
  inboundCount,
  onChange,
  onRemove
}: {
  value: ConditionInput | OutboundInput;
  title: string;
  materials: MaterialInput[];
  vendors?: LedgerItem[];
  inboundCount?: number;
  onChange: (patch: Partial<ConditionInput & OutboundInput>) => void;
  onRemove?: () => void;
}) {
  const outbound = "counterpartyVendorId" in value;
  return <fieldset className="intake-repeat intake-condition">
    <legend>{title}</legend>
    {onRemove && <div className="repeat-actions">
      <button type="button" onClick={onRemove}>削除</button>
    </div>}
    <div className="intake-fields">
      <label>条件名
        <input value={value.conditionName}
          onChange={(event) => onChange({ conditionName: event.target.value })} />
      </label>
      {outbound && <>
        <label>許諾先
          <select value={value.counterpartyVendorId}
            onChange={(event) => onChange({
              counterpartyVendorId: event.target.value
            })}>
            <option value="">選択してください</option>
            {vendors?.map((item) => <option key={item.id} value={item.id}>
              {item.code} {item.title}
            </option>)}
          </select>
        </label>
        <label>根拠イン条件
          <select value={value.parentInboundIndex}
            onChange={(event) => onChange({
              parentInboundIndex: event.target.value
            })}>
            {Array.from({ length: inboundCount ?? 0 }, (_, index) =>
              <option key={index} value={index}>イン条件 {index + 1}</option>)}
          </select>
        </label>
      </>}
      <label>対象素材
        <select value={value.materialIndex}
          onChange={(event) => onChange({ materialIndex: event.target.value })}>
          <option value="">素材を指定しない</option>
          {materials.map((material, index) =>
            <option key={index} value={index}>
              {index + 1}. {material.mode === "existing"
                ? `既存素材ID ${material.existingMaterialId || "未入力"}`
                : material.materialName || "名称未入力"}
            </option>)}
        </select>
      </label>
      <label>取引類型
        <select value={value.transactionKind}
          onChange={(event) => onChange({
            transactionKind: event.target.value as ConditionInput["transactionKind"]
          })}>
          <option value="license">ライセンス</option>
          <option value="product">製品</option>
          <option value="service">役務</option>
        </select>
      </label>
      <label>地域
        <input value={value.territory}
          onChange={(event) => onChange({ territory: event.target.value })} />
      </label>
      <label>言語
        <input value={value.languages}
          onChange={(event) => onChange({ languages: event.target.value })}
          placeholder="カンマ区切り" />
      </label>
      <label>独占性
        <select value={value.exclusivity}
          onChange={(event) => onChange({
            exclusivity: event.target.value as ConditionInput["exclusivity"]
          })}>
          <option value="non_exclusive">非独占</option>
          <option value="exclusive">独占</option>
          <option value="sole">ソール</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.sublicenseAllowed}
          onChange={(event) => onChange({
            sublicenseAllowed: event.target.checked
          })} />
        再許諾可
      </label>
      <label>開始日
        <input type="date" value={value.termStart}
          onChange={(event) => onChange({ termStart: event.target.value })} />
      </label>
      <label>終了日
        <input type="date" value={value.termEnd}
          onChange={(event) => onChange({ termEnd: event.target.value })} />
      </label>
      <label>通貨
        <input value={value.currency} maxLength={3}
          onChange={(event) => onChange({
            currency: event.target.value.toUpperCase()
          })} />
      </label>
      <label>金額方式
        <select value={value.paymentScheme}
          onChange={(event) => onChange({
            paymentScheme: event.target.value as ConditionInput["paymentScheme"],
            ratePct: "",
            amountExTax: "",
            mgAmount: "",
            advanceAmount: ""
          })}>
          <option value="royalty">ロイヤリティ</option>
          <option value="per_unit">単価</option>
          <option value="lump_sum">一括金額</option>
          <option value="installment">分割払い</option>
          <option value="subscription">定額払い</option>
        </select>
      </label>
      {value.paymentScheme === "royalty" ? <>
        <label>料率（%）
          <input type="number" min="0" max="100" step="0.01"
            value={value.ratePct}
            onChange={(event) => onChange({ ratePct: event.target.value })} />
        </label>
        <label>MG
          <input type="number" min="0" value={value.mgAmount}
            onChange={(event) => onChange({ mgAmount: event.target.value })} />
        </label>
        <label>Advance
          <input type="number" min="0" value={value.advanceAmount}
            onChange={(event) => onChange({ advanceAmount: event.target.value })} />
        </label>
        <label>算定基礎
          <input value={value.royaltyBase}
            onChange={(event) => onChange({ royaltyBase: event.target.value })} />
        </label>
        <label>控除費用
          <input value={value.deductibleCosts}
            onChange={(event) => onChange({
              deductibleCosts: event.target.value
            })} />
        </label>
      </> : <label>税抜金額
        <input type="number" min="0" value={value.amountExTax}
          onChange={(event) => onChange({ amountExTax: event.target.value })} />
      </label>}
      <label>報告周期
        <input value={value.reportingCycle}
          onChange={(event) => onChange({
            reportingCycle: event.target.value
          })} />
      </label>
      <label>支払条件
        <input value={value.paymentTerms}
          onChange={(event) => onChange({ paymentTerms: event.target.value })} />
      </label>
      <label>海外源泉税
        <input value={value.withholdingTaxTreatment}
          onChange={(event) => onChange({
            withholdingTaxTreatment: event.target.value
          })} />
      </label>
      <label className="wide">備考
        <textarea value={value.notes}
          onChange={(event) => onChange({ notes: event.target.value })} />
      </label>
    </div>
  </fieldset>;
}
