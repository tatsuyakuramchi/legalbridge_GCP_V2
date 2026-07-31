import { useEffect, useState } from "react";
import type {
  DashboardSummary,
  DocumentDraft,
  DocumentFormData,
  DocumentFormSchema
} from "../types";
import { SpecializedDocumentForms } from "./SpecializedDocumentForms";
import { MasterDataPicker } from "./MasterDataPicker";
import { DocumentRegistry } from "./DocumentRegistry";
import { MatterRegistry } from "./MatterRegistry";
import { LedgerWorkspace } from "./LedgerWorkspace";
import { GlobalSearch } from "./GlobalSearch";
import { AdminOverview } from "./AdminOverview";
import { DraftWorkspace } from "./DraftWorkspace";

type CompatibilityReport = { summary: { total: number; ok: number; warning: number; error: number }; reports: Array<{ templateKey: string; status: "ok" | "warning" | "error"; missingHelpers: string[]; missingPartials: string[]; unmappedVariables: string[]; renderError?: string }> };

const fallback: DashboardSummary = {
  kpis: [
    { label: "対応待ち", value: 12, tone: "warning" },
    { label: "本日期限", value: 4, tone: "danger" },
    { label: "承認待ち", value: 7 },
    { label: "今月完了", value: 38 }
  ],
  stages: [
    { label: "受付", count: 8 },
    { label: "審査", count: 11 },
    { label: "ドラフト", count: 6 },
    { label: "承認・締結", count: 5 },
    { label: "完了", count: 38 }
  ],
  priorities: []
};

export function App() {
  const [dashboard, setDashboard] = useState(fallback);
  const [templates, setTemplates] = useState<DocumentFormSchema[]>([]);
  const [schema, setSchema] = useState<DocumentFormSchema | null>(null);
  const [compatibility, setCompatibility] = useState<CompatibilityReport | null>(null);
  const [view, setView] = useState<"home" | "matters" | "documents" | "templates" | "document" | "drafts" | "ledgers" | "admin">("home");
  const [readOnly, setReadOnly] = useState(true);
  const [canFinalizeDocuments, setCanFinalizeDocuments] = useState(false);
  const [searchSelection, setSearchSelection] = useState<{ target: "matter" | "document" | "vendor" | "work"; id: string; title: string } | null>(null);
  const [draftSelection, setDraftSelection] = useState<{ issueKey: string; templateType: string } | null>(null);

  useEffect(() => {
    fetch("/api/v2/dashboard").then((response) => response.ok && response.json()).then((data) => data && setDashboard(data)).catch(() => undefined);
    fetch("/api/v2/runtime")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((runtime) => {
        const capabilities = Array.isArray(runtime.writeCapabilities)
          ? runtime.writeCapabilities as string[]
          : [];
        setReadOnly(!capabilities.includes("drafts"));
        setCanFinalizeDocuments(capabilities.includes("documents"));
      })
      .catch(() => {
        setReadOnly(true);
        setCanFinalizeDocuments(false);
      });
    fetch("/api/v2/document-templates")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setTemplates(data.templates ?? []))
      .catch(() => undefined);
    fetch("/api/v2/document-templates/compatibility-report").then((response) => response.ok ? response.json() : Promise.reject()).then(setCompatibility).catch(() => undefined);
  }, []);

  async function openDocumentForm(templateKey: string) {
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(templateKey)}/form-schema`
    );
    if (!response.ok) return;
    setDraftSelection(null);
    setSchema(await response.json());
    setView("document");
  }

  async function resumeDraft(issueKey: string, templateType: string) {
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(templateType)}/form-schema`
    );
    if (!response.ok) return;
    setDraftSelection({ issueKey, templateType });
    setSchema(await response.json());
    setView("document");
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">LegalBridge <span>V2</span></div>
        <nav>
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>ホーム</button>
          <button className={view === "matters" ? "active" : ""} onClick={() => setView("matters")}>案件</button>
          <button
            className={view === "documents" || view === "templates" || view === "document" ? "active" : ""}
            onClick={() => setView("documents")}
          >
            文書
          </button>
          {!readOnly && (
            <button className={view === "drafts" ? "active" : ""} onClick={() => setView("drafts")}>
              下書き
            </button>
          )}
          <button className={view === "ledgers" ? "active" : ""} onClick={() => setView("ledgers")}>台帳</button>
          <button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}>管理</button>
        </nav>
        <div className="backlog"><strong>Backlog連携</strong><small>参照のみ・変更なし</small></div>
      </aside>

      <main>
        {readOnly && (
          <div className="readonly-banner">
            読取専用プレビュー環境：本番データの保存・更新・削除・外部送信は停止しています
          </div>
        )}
        <header>
          <GlobalSearch onNavigate={(target, id, title) => {
            setSearchSelection({ target, id, title });
            setView(target === "matter" ? "matters" : target === "document" ? "documents" : "ledgers");
          }} />
          <div className="profile">法務担当</div>
        </header>

        {view === "home" && (
          <Dashboard dashboard={dashboard} onCreateDocument={() => setView("templates")} />
        )}
        {view === "matters" && <MatterRegistry templates={templates}
          selectedId={searchSelection?.target === "matter" ? Number(searchSelection.id) : undefined} />}
        {view === "drafts" && !readOnly && (
          <DraftWorkspace templates={templates} onResume={resumeDraft} />
        )}
        {view === "ledgers" && <LedgerWorkspace
          initialType={searchSelection?.target === "work" ? "works" : searchSelection?.target === "vendor" ? "vendors" : undefined}
          initialQuery={searchSelection?.target === "work" || searchSelection?.target === "vendor" ? searchSelection.title : undefined}
          selectedId={searchSelection?.target === "work" || searchSelection?.target === "vendor" ? searchSelection.id : undefined} />}
        {view === "admin" && <AdminOverview />}
        {view === "documents" && (
          <DocumentRegistry templates={templates} onCreate={() => setView("templates")}
            selectedId={searchSelection?.target === "document" ? Number(searchSelection.id) : undefined} />
        )}
        {view === "templates" && (
          <TemplateCatalog templates={templates} compatibility={compatibility} onSelect={openDocumentForm} />
        )}
        {view === "document" && (
          <DocumentForm
            key={`${schema?.templateKey ?? "loading"}:${draftSelection?.issueKey ?? "new"}`}
            schema={schema}
            readOnly={readOnly}
            canFinalizeDocuments={canFinalizeDocuments}
            initialIssueKey={draftSelection?.issueKey ?? "VALIDATION-1"}
            onBack={() => setView(draftSelection ? "drafts" : "templates")}
          />
        )}
      </main>
    </div>
  );
}

function TemplateCatalog({
  templates,
  compatibility,
  onSelect
}: {
  templates: DocumentFormSchema[];
  compatibility: CompatibilityReport | null;
  onSelect: (templateKey: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("すべて");
  const categories = [
    "すべて",
    ...new Set(templates.map((template) => template.category ?? "未分類"))
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTemplates = templates.filter((template) => {
    const matchesCategory =
      category === "すべて" || (template.category ?? "未分類") === category;
    const matchesQuery =
      !normalizedQuery ||
      template.label.toLowerCase().includes(normalizedQuery) ||
      template.templateKey.toLowerCase().includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  });

  return (
    <section className="page template-catalog">
      <div className="page-title">
        <div>
          <p>DOCUMENT TEMPLATES</p>
          <h1>文書を作成</h1>
          <small>DB登録済みの有効な文書template {templates.length}件</small>
        </div>
      </div>
      <div className="template-toolbar">
        <input
          aria-label="templateを検索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="文書名またはtemplate keyで検索"
        />
        <select
          aria-label="カテゴリ"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {categories.map((item) => <option key={item}>{item}</option>)}
        </select>
        <span>{visibleTemplates.length}件</span>
      </div>
      {compatibility && <div className="compatibility-summary"><strong>Template互換性検査</strong><span className="compat-ok">正常 {compatibility.summary.ok}</span><span className="compat-warning">要確認 {compatibility.summary.warning}</span><span className="compat-error">エラー {compatibility.summary.error}</span></div>}
      {visibleTemplates.length ? (
        <div className="template-grid">
          {visibleTemplates.map((template) => (
            <button
              className="template-card"
              key={template.templateKey}
              onClick={() => onSelect(template.templateKey)}
            >
              <span>{template.category ?? "未分類"}</span>
              <strong>{template.label}</strong>
              <small>{template.templateKey}</small>
              <em>{template.fields.length}項目</em>
              {(() => { const result = compatibility?.reports.find((item) => item.templateKey === template.templateKey); return result && <i className={`compat-badge ${result.status}`} title={[result.renderError, result.missingHelpers.length ? `helper: ${result.missingHelpers.join(", ")}` : "", result.missingPartials.length ? `partial: ${result.missingPartials.join(", ")}` : "", result.unmappedVariables.length ? `未マッピング: ${result.unmappedVariables.join(", ")}` : ""].filter(Boolean).join("\n")}>{result.status === "ok" ? "互換" : result.status === "warning" ? "要確認" : "エラー"}</i>; })()}
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">条件に一致する文書templateがありません。</div>
      )}
    </section>
  );
}

function Dashboard({ dashboard, onCreateDocument }: { dashboard: DashboardSummary; onCreateDocument: () => void }) {
  return (
    <section className="page">
      <div className="page-title">
        <div><p>LEGAL OPERATIONS</p><h1>法務オペレーション</h1></div>
        <button className="primary" onClick={onCreateDocument}>文書を作成</button>
      </div>
      <div className="kpis">
        {dashboard.kpis.map((kpi) => <article key={kpi.label} className={kpi.tone ?? ""}><span>{kpi.label}</span><strong>{kpi.value}</strong></article>)}
      </div>
      <section className="panel">
        <div className="panel-head"><h2>案件工程</h2><span>全案件 68</span></div>
        <div className="stages">
          {dashboard.stages.map((stage, index) => <article key={stage.label}><small>0{index + 1}</small><strong>{stage.count}</strong><span>{stage.label}</span></article>)}
        </div>
      </section>
      <div className="content-grid">
        <section className="panel">
          <div className="panel-head"><h2>優先対応案件</h2><button>すべて表示</button></div>
          <table><thead><tr><th>案件</th><th>相手方</th><th>工程</th><th>期限</th><th>状態</th></tr></thead>
            <tbody>
              {(dashboard.priorities.length ? dashboard.priorities : [
                { id: "LB-2026-0148", title: "海外ライセンス契約更新", counterparty: "North Star Games", stage: "審査", dueDate: "7/28", status: "要確認", owner: "" },
                { id: "LB-2026-0144", title: "制作業務委託基本契約", counterparty: "青空スタジオ", stage: "ドラフト", dueDate: "7/30", status: "作成中", owner: "" }
              ]).map((matter) => <tr key={matter.id}><td><b>{matter.id}</b><br />{matter.title}</td><td>{matter.counterparty}</td><td>{matter.stage}</td><td>{matter.dueDate}</td><td><span className="status">{matter.status}</span></td></tr>)}
            </tbody>
          </table>
        </section>
        <aside className="panel alerts"><div className="panel-head"><h2>本日の対応</h2><span>4件</span></div><p><b>契約レビュー期限</b><br />海外ライセンス契約更新</p><p><b>承認待ち</b><br />出版契約書 第3稿</p></aside>
      </div>
    </section>
  );
}

function DocumentForm({
  schema,
  readOnly,
  canFinalizeDocuments,
  initialIssueKey,
  onBack
}: {
  schema: DocumentFormSchema | null;
  readOnly: boolean;
  canFinalizeDocuments: boolean;
  initialIssueKey: string;
  onBack: () => void;
}) {
  const [issueKey, setIssueKey] = useState(initialIssueKey);
  const [formData, setFormData] = useState<DocumentFormData>({});
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [notice, setNotice] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [finalizedDocument, setFinalizedDocument] = useState<{
    id: number;
    documentNumber: string;
    integrations: { pdf: string; drive: string; backlog: string };
  } | null>(null);
  const [draftStatus, setDraftStatus] = useState<
    "loading" | "clean" | "dirty" | "saving" | "saved" | "error"
  >("loading");

  useEffect(() => {
    if (!schema || !issueKey.trim()) return;
    const controller = new AbortController();
    setDraftStatus("loading");
    setNotice("");
    setFinalizedDocument(null);

    fetch(
      `/api/v2/document-form-context?template_key=${encodeURIComponent(schema.templateKey)}&issue_key=${encodeURIComponent(issueKey.trim())}`,
      { signal: controller.signal }
    )
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("context load failed"))
      )
      .then((context) => {
        const restoredDraft = context.draft ?? null;
        setFormData(context.formData ?? {});
        setDraft(restoredDraft);
        setDraftStatus(restoredDraft ? "saved" : "clean");
        setNotice(
          restoredDraft
            ? `保存済みの下書きを復元しました（${formatDraftTime(restoredDraft.updatedAt)}）`
            : "新しい文書として入力できます"
        );
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDraftStatus("error");
        setNotice("初期値または下書きを取得できませんでした");
      });

    return () => controller.abort();
  }, [schema, issueKey]);

  if (!schema) {
    return <section className="page"><h1>文書作成</h1><p>フォーム定義を読み込んでいます。</p></section>;
  }
  const groups = [...new Set(schema.fields.map((field) => field.group ?? "基本情報"))];

  function updateValue(name: string, value: unknown) {
    setFormData((current) => ({ ...current, [name]: value }));
    setDraftStatus("dirty");
    setNotice("未保存の変更があります");
  }

  async function saveDraft() {
    if (readOnly) return;
    if (!issueKey.trim()) {
      setDraftStatus("error");
      setNotice("案件キーを入力してください");
      return;
    }

    setDraftStatus("saving");
    setNotice("下書きを保存しています");
    try {
      const response = await fetch(`/api/v2/document-drafts/${encodeURIComponent(issueKey.trim())}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateType: schema!.templateKey,
          formData,
          expectedUpdatedAt: draft?.updatedAt ?? null
        })
      });
      const result = await response.json();
      if (response.status === 409) {
        setDraft(result.current);
        setDraftStatus("error");
        setNotice("別の画面で更新されています。案件キーを再入力して最新の下書きを復元してください");
        return;
      }
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "下書き保存に失敗しました");
        return;
      }
      setDraft(result.draft);
      setDraftStatus("saved");
      setNotice(`下書きを保存しました（${formatDraftTime(result.draft.updatedAt)}）`);
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより下書きを保存できませんでした");
    }
  }

  async function discardDraft() {
    if (readOnly || !draft) return;
    if (!window.confirm("保存済みの下書きを破棄します。元に戻せません。よろしいですか？")) return;

    setDraftStatus("saving");
    setNotice("下書きを破棄しています");
    try {
      const query = new URLSearchParams({ template_type: schema!.templateKey });
      const response = await fetch(
        `/api/v2/document-drafts/${encodeURIComponent(issueKey.trim())}?${query.toString()}`,
        { method: "DELETE" }
      );
      const result = await response.json();
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "下書きを破棄できませんでした");
        return;
      }

      const contextQuery = new URLSearchParams({
        template_key: schema!.templateKey,
        issue_key: issueKey.trim()
      });
      const contextResponse = await fetch(`/api/v2/document-form-context?${contextQuery.toString()}`);
      const context = contextResponse.ok ? await contextResponse.json() : { formData: {} };
      setDraft(null);
      setFormData(context.formData ?? {});
      setPreviewHtml("");
      setDraftStatus("clean");
      setNotice("下書きを破棄しました");
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより下書きを破棄できませんでした");
    }
  }

  async function finalizeDocument() {
    if (!canFinalizeDocuments || !draft || draftStatus !== "saved") return;
    if (!window.confirm(
      "保存済みの下書きを文書として確定します。確定後はこの下書きを編集できません。よろしいですか？"
    )) return;

    setDraftStatus("saving");
    setNotice("文書を確定しています");
    try {
      const response = await fetch("/api/v2/documents/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueKey: issueKey.trim(),
          templateType: schema!.templateKey,
          templateVersionId: schema!.templateVersionId,
          formData,
          expectedDraftUpdatedAt: draft.updatedAt
        })
      });
      const result = await response.json();
      if (response.status === 409) {
        setDraftStatus("error");
        setNotice("下書きが別の画面で更新されています。再読み込みしてから確定してください");
        return;
      }
      if (!response.ok) {
        setDraftStatus("error");
        setNotice(result.error ?? "文書を確定できませんでした");
        return;
      }

      setFinalizedDocument({
        id: result.document.id,
        documentNumber: result.document.documentNumber,
        integrations: result.integrations
      });
      setDraft(null);
      setDraftStatus("clean");
      setNotice(`文書 ${result.document.documentNumber} を確定しました`);
    } catch {
      setDraftStatus("error");
      setNotice("通信エラーにより文書を確定できませんでした");
    }
  }

  async function validate() {
    const response = await fetch("/api/v2/documents/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: schema!.templateKey,
        templateVersionId: schema!.templateVersionId,
        formData
      })
    });
    const result = await response.json();
    if (!response.ok) {
      setNotice(result.errors?.map((item: { message: string }) => item.message).join("、") ?? result.error);
      return;
    }
    const previewResponse = await fetch("/api/v2/documents/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: schema!.templateKey,
        templateVersionId: schema!.templateVersionId,
        formData
      })
    });
    const preview = await previewResponse.json();
    setPreviewHtml(previewResponse.ok ? preview.html : "");
    setNotice(previewResponse.ok ? "入力検証とプレビュー生成が完了しました" : preview.error);
  }

  return (
    <section className="page">
      <div className="page-title document-form-title">
        <div>
          <button className="text-button" onClick={onBack}>← template一覧</button>
          <p>DOCUMENT COMMAND</p>
          <h1>{schema.label}</h1>
          <div className="draft-summary" aria-live="polite">
            <span className={`draft-status ${draftStatus}`}>
              {draftStatus === "loading" ? "読込中" :
                draftStatus === "clean" ? "未保存" :
                draftStatus === "dirty" ? "変更あり" :
                draftStatus === "saving" ? "処理中" :
                draftStatus === "saved" ? "保存済み" : "要確認"}
            </span>
            <small>{schema.templateKey}・{schema.fields.length}項目</small>
            {notice && <small>{notice}</small>}
          </div>
          <label className="draft-key">案件キー
            <input
              value={issueKey}
              onChange={(event) => {
                setIssueKey(event.target.value);
                setDraft(null);
                setDraftStatus("loading");
              }}
              disabled={draftStatus === "saving"}
              placeholder="VALIDATION-1"
            />
          </label>
        </div>
        <div className="actions">
          <button onClick={validate}>入力確認</button>
          {!readOnly && (
            <>
              {draft && (
                <button
                  className="danger-button"
                  onClick={discardDraft}
                  disabled={draftStatus === "saving"}
                >
                  下書きを破棄
                </button>
              )}
              <button
                className="primary"
                onClick={saveDraft}
                disabled={draftStatus === "saving" || draftStatus === "loading" || !issueKey.trim()}
              >
                {draftStatus === "saving" ? "処理中…" : draft ? "下書きを更新" : "下書きを保存"}
              </button>
              {canFinalizeDocuments && (
                <button
                  className="finalize-button"
                  onClick={finalizeDocument}
                  disabled={!draft || draftStatus !== "saved"}
                  title={!draft || draftStatus !== "saved" ? "保存済みで未変更の下書きが必要です" : undefined}
                >
                  文書を確定
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {finalizedDocument && (
        <div className="finalization-result" role="status">
          <div>
            <span>DOCUMENT FINALIZED</span>
            <strong>{finalizedDocument.documentNumber}</strong>
            <small>文書ID: {finalizedDocument.id}</small>
          </div>
          <dl>
            <div><dt>PDF</dt><dd>{formatIntegrationStatus(finalizedDocument.integrations.pdf)}</dd></div>
            <div><dt>Drive</dt><dd>{formatIntegrationStatus(finalizedDocument.integrations.drive)}</dd></div>
            <div><dt>Backlog</dt><dd>{formatIntegrationStatus(finalizedDocument.integrations.backlog)}</dd></div>
          </dl>
          <p>外部連携は実行していません。文書番号の発番とDB確定のみ完了しています。</p>
        </div>
      )}
      {readOnly && (
        <div className="form-readonly-note">
          読取専用環境では入力確認とプレビューのみ利用できます。下書きは保存されません。
        </div>
      )}
      <div className="form-layout">
        <nav className="form-nav">
          {groups.map((group, index) => <a key={group} href={`#group-${index}`}>{group}</a>)}
          {hasSpecializedForm(schema.templateKey) && <a href="#specialized-fields">明細・条件</a>}
        </nav>
        <form className="form-panel">
          <MasterDataPicker schema={schema} formData={formData}
            onApply={(patch, message) => {
              setFormData((current) => ({ ...current, ...patch }));
              setDraftStatus("dirty");
              setNotice(message);
            }} />
          {groups.map((group, index) => <section id={`group-${index}`} key={group}><h2>{group}</h2>
            <div className="field-grid">{schema.fields.filter((field) => (field.group ?? "基本情報") === group && field.type !== "hidden").map((field) => <label key={field.name}><span>{field.label ?? field.name}{field.required && <em>必須</em>}</span>{field.type === "textarea" ? <textarea value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)} placeholder={field.placeholder} /> : field.type === "select" ? <select value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)}><option value="">選択してください</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : field.type === "boolean" ? <input type="checkbox" checked={Boolean(formData[field.name])} onChange={(event) => updateValue(field.name, event.target.checked)} /> : <input value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, field.type === "number" ? Number(event.target.value) : event.target.value)} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} placeholder={field.placeholder} />}<small>{field.helpText}{field.dbField && ` 自動補完: ${field.dbField}`}</small></label>)}</div>
          </section>)}
          {schema.templateKey === "individual_license_terms_v3" && (
            <IndividualLicenseV3Form formData={formData} onChange={updateValue} />
          )}
          <SpecializedDocumentForms templateKey={schema.templateKey} formData={formData} onChange={updateValue} />
        </form>
        <aside className="preview"><strong>文書プレビュー</strong>{previewHtml ? <iframe title="文書プレビュー" sandbox="" srcDoc={previewHtml} /> : <div>「入力確認」でDB templateによるプレビューを生成します。</div>}<small>Template version: {schema.templateVersionId}</small></aside>
      </div>
    </section>
  );
}

function formatIntegrationStatus(value: string) {
  if (value === "pending") return "未実行";
  if (value === "disabled") return "停止";
  return value;
}

function formatDraftTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function hasSpecializedForm(templateKey: string) {
  return [
    "purchase_order",
    "intl_purchase_order",
    "individual_license_terms",
    "royalty_statement",
    "inspection_certificate"
  ].includes(templateKey);
}

type V3Row = Record<string, unknown>;

function IndividualLicenseV3Form({ formData, onChange }: { formData: DocumentFormData; onChange: (name: string, value: unknown) => void }) {
  const rows = (key: string): V3Row[] => Array.isArray(formData[key]) ? formData[key] as V3Row[] : [];
  const conditions = rows("v3_conds");
  const materials = rows("v3_lcs");
  const replaceRow = (key: string, index: number, patch: V3Row) => onChange(key, rows(key).map((row, i) => i === index ? { ...row, ...patch } : row));
  const addRow = (key: string, row: V3Row) => onChange(key, [...rows(key), row]);
  const removeRow = (key: string, index: number) => onChange(key, rows(key).filter((_, i) => i !== index));
  const field = (label: string, value: unknown, set: (value: string) => void, type: "text" | "number" = "text") =>
    <label><span>{label}</span><input type={type} value={String(value ?? "")} onChange={(event) => set(event.target.value)} /></label>;
  return <div className="v3-editor">
    <section>
      <div className="repeater-title"><div><h2>V. 取引形態</h2><small>製造販売、サブライセンス等の条件を追加します。</small></div><button type="button" onClick={() => addRow("v3_conds", { id: String(Date.now()), addon: true, cur: "JPY", qty: "1", ag: "0", mg: "0" })}>＋ 取引形態</button></div>
      {!conditions.length && <p className="inline-empty">取引形態を追加してください。</p>}
      {conditions.map((condition, index) => <article className="repeater-card" key={String(condition.id ?? index)}>
        <div className="repeater-card-head"><strong>条件{index + 1}</strong><button type="button" onClick={() => removeRow("v3_conds", index)}>削除</button></div>
        <div className="field-grid">
          {field("取引形態名", condition.name, (value) => replaceRow("v3_conds", index, { name: value }))}
          <label><span>料率方式</span><select value={condition.addon ? "addon" : "fixed"} onChange={(event) => replaceRow("v3_conds", index, { addon: event.target.value === "addon" })}><option value="addon">加算型（構成要素の料率合計）</option><option value="fixed">非加算型（実効料率）</option></select></label>
          {!condition.addon && field("実効料率（%）", condition.fixedRate, (value) => replaceRow("v3_conds", index, { fixedRate: value }), "number")}
          <label><span>計算モデル</span><select value={String(condition.calc_type ?? "")} onChange={(event) => replaceRow("v3_conds", index, { calc_type: event.target.value })}><option value="">選択してください</option><option value="BASE_QTY_RATE">基準価格×個数×料率</option><option value="BASE_RATE">実効料率</option><option value="FIXED">固定額</option><option value="SUBSCRIPTION">サブスク</option><option value="SUPPLY_QTY">供給価格×個数×料率</option></select></label>
          {field("製造者", condition.manufacturer, (v) => replaceRow("v3_conds", index, { manufacturer: v }))}
          {field("販売者", condition.seller, (v) => replaceRow("v3_conds", index, { seller: v }))}
          {field("基準価格", condition.basePrice, (v) => replaceRow("v3_conds", index, { basePrice: v }))}
          {field("今回地域", condition.reg, (v) => replaceRow("v3_conds", index, { reg: v }))}
          {field("今回言語", condition.lang, (v) => replaceRow("v3_conds", index, { lang: v }))}
          {field("数量", condition.qty, (v) => replaceRow("v3_conds", index, { qty: v }))}
          {field("AG", condition.ag, (v) => replaceRow("v3_conds", index, { ag: v }), "number")}
          {field("MG", condition.mg, (v) => replaceRow("v3_conds", index, { mg: v }), "number")}
          {field("通貨", condition.cur, (v) => replaceRow("v3_conds", index, { cur: v }))}
        </div>
      </article>)}
    </section>
    <section>
      <div className="repeater-title"><div><h2>VI. 構成要素・料率マトリクス</h2><small>権利台帳の構成要素と取引形態別料率を入力します。</small></div><button type="button" onClick={() => addRow("v3_lcs", { rates: {} })}>＋ 構成要素</button></div>
      {!materials.length && <p className="inline-empty">構成要素を追加してください。</p>}
      {materials.map((material, index) => {
        const rates = material.rates && typeof material.rates === "object" ? material.rates as V3Row : {};
        return <article className="repeater-card" key={index}>
          <div className="repeater-card-head"><strong>構成要素{index + 1}</strong><button type="button" onClick={() => removeRow("v3_lcs", index)}>削除</button></div>
          <div className="field-grid">
            {field("素材コード", material.material_code, (v) => replaceRow("v3_lcs", index, { material_code: v }))}
            {field("構成要素名", material.name, (v) => replaceRow("v3_lcs", index, { name: v }))}
            {field("権利元", material.holder, (v) => replaceRow("v3_lcs", index, { holder: v }))}
            {field("根拠文書番号", material.source_doc, (v) => replaceRow("v3_lcs", index, { source_doc: v }))}
            {field("許諾地域", material.region, (v) => replaceRow("v3_lcs", index, { region: v }))}
            {field("許諾言語", material.language, (v) => replaceRow("v3_lcs", index, { language: v }))}
            {conditions.filter((condition) => Boolean(condition.addon)).map((condition, ci) => {
              const key = String(condition.id ?? ci);
              return field(`${String(condition.name || `条件${ci + 1}`)} 料率（%）`, rates[key], (v) => replaceRow("v3_lcs", index, { rates: { ...rates, [key]: v } }), "number");
            })}
          </div>
        </article>;
      })}
    </section>
    <SimpleRepeater title="VII. サブライセンシー" itemLabel="サブライセンシー" rows={rows("v3_sublicensees")} fields={[["slPartner","相手方"],["slRegion","地域"],["slLang","言語"],["slCond","条件"],["slRate","料率"],["slDate","開始日"],["slNote","備考"]]} onAdd={() => addRow("v3_sublicensees", {})} onChange={(i,p) => replaceRow("v3_sublicensees",i,p)} onRemove={(i) => removeRow("v3_sublicensees",i)} />
    <SimpleRepeater title="VIII. 計算基準日" itemLabel="基準日" rows={rows("v3_calc_base_rows")} fields={[["edition","版"],["trigger","起点事由"],["note","備考"]]} onAdd={() => addRow("v3_calc_base_rows", {})} onChange={(i,p) => replaceRow("v3_calc_base_rows",i,p)} onRemove={(i) => removeRow("v3_calc_base_rows",i)} />
    <SimpleRepeater title="IX. 特記事項" itemLabel="特記事項" rows={rows("v3_special_extras")} fields={[["seId","項番"],["seText","内容"]]} onAdd={() => addRow("v3_special_extras", {})} onChange={(i,p) => replaceRow("v3_special_extras",i,p)} onRemove={(i) => removeRow("v3_special_extras",i)} />
  </div>;
}
function SimpleRepeater({ title, itemLabel, rows, fields, onAdd, onChange, onRemove }: { title: string; itemLabel: string; rows: V3Row[]; fields: string[][]; onAdd: () => void; onChange: (index: number, patch: V3Row) => void; onRemove: (index: number) => void }) {
  return <section><div className="repeater-title"><h2>{title}</h2><button type="button" onClick={onAdd}>＋ 追加</button></div>{rows.map((row,index) => <article className="repeater-card" key={index}><div className="repeater-card-head"><strong>{itemLabel}{index+1}</strong><button type="button" onClick={() => onRemove(index)}>削除</button></div><div className="field-grid">{fields.map(([name,label]) => <label key={name}><span>{label}</span><input value={String(row[name] ?? "")} onChange={(event) => onChange(index,{[name]:event.target.value})} /></label>)}</div></article>)}</section>;
}
