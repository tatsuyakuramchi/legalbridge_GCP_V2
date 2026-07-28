import { useEffect, useState } from "react";
import type {
  DashboardSummary,
  DocumentDraft,
  DocumentFormData,
  DocumentFormSchema
} from "../types";

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
  const [view, setView] = useState<"home" | "templates" | "document">("home");
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    fetch("/api/v2/dashboard").then((response) => response.ok && response.json()).then((data) => data && setDashboard(data)).catch(() => undefined);
    fetch("/api/v2/runtime")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((runtime) => setReadOnly(runtime.accessMode === "readonly"))
      .catch(() => undefined);
    fetch("/api/v2/document-templates")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setTemplates(data.templates ?? []))
      .catch(() => undefined);
  }, []);

  async function openDocumentForm(templateKey: string) {
    const response = await fetch(
      `/api/v2/document-templates/${encodeURIComponent(templateKey)}/form-schema`
    );
    if (!response.ok) return;
    setSchema(await response.json());
    setView("document");
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">LegalBridge <span>V2</span></div>
        <nav>
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>ホーム</button>
          <button>案件</button>
          <button
            className={view === "templates" || view === "document" ? "active" : ""}
            onClick={() => setView("templates")}
          >
            文書
          </button>
          <button>台帳</button>
          <button>管理</button>
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
          <input aria-label="グローバル検索" placeholder="案件、文書、契約、作品を検索" />
          <div className="profile">法務担当</div>
        </header>

        {view === "home" && (
          <Dashboard dashboard={dashboard} onCreateDocument={() => setView("templates")} />
        )}
        {view === "templates" && (
          <TemplateCatalog templates={templates} onSelect={openDocumentForm} />
        )}
        {view === "document" && (
          <DocumentForm
            schema={schema}
            readOnly={readOnly}
            onBack={() => setView("templates")}
          />
        )}
      </main>
    </div>
  );
}

function TemplateCatalog({
  templates,
  onSelect
}: {
  templates: DocumentFormSchema[];
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
  onBack
}: {
  schema: DocumentFormSchema | null;
  readOnly: boolean;
  onBack: () => void;
}) {
  const issueKey = "LOCAL-1";
  const [formData, setFormData] = useState<DocumentFormData>({});
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [notice, setNotice] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");

  useEffect(() => {
    if (!schema) return;
    fetch(`/api/v2/document-form-context?template_key=${encodeURIComponent(schema.templateKey)}&issue_key=${issueKey}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("context load failed")))
      .then((context) => {
        setFormData(context.formData ?? {});
        setDraft(context.draft ?? null);
      })
      .catch(() => setNotice("初期値を取得できませんでした"));
  }, [schema]);

  if (!schema) return <section className="page"><h1>文書作成</h1><p>フォーム定義を読み込んでいます。</p></section>;
  const groups = [...new Set(schema.fields.map((field) => field.group ?? "基本情報"))];

  function updateValue(name: string, value: unknown) {
    setFormData((current) => ({ ...current, [name]: value }));
    setNotice("未保存の変更があります");
  }

  async function saveDraft() {
    if (readOnly) {
      setNotice("読取専用環境のため下書きは保存されません");
      return;
    }
    const response = await fetch(`/api/v2/document-drafts/${issueKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateType: schema!.templateKey,
        formData,
        updatedBy: "local@example.com",
        expectedUpdatedAt: draft?.updatedAt ?? null
      })
    });
    const result = await response.json();
    if (response.status === 409) {
      setDraft(result.current);
      setNotice("別の画面で更新されています。内容を再確認してください");
      return;
    }
    if (!response.ok) {
      setNotice("下書き保存に失敗しました");
      return;
    }
    setDraft(result.draft);
    setNotice("下書きを保存しました");
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
      <div className="page-title">
        <div>
          <button className="text-button" onClick={onBack}>← template一覧</button>
          <p>DOCUMENT COMMAND</p>
          <h1>{schema.label}</h1>
          <small>{schema.templateKey}・{schema.fields.length}項目 {notice && `・${notice}`}</small>
        </div>
        <div className="actions">
          <button onClick={validate}>入力確認</button>
          <button
            className="primary"
            onClick={saveDraft}
            disabled={readOnly}
            title={readOnly ? "読取専用環境では保存できません" : undefined}
          >
            {readOnly ? "下書き保存（停止中）" : "下書き保存"}
          </button>
        </div>
      </div>
      <div className="form-layout">
        <nav className="form-nav">{groups.map((group, index) => <a key={group} href={`#group-${index}`}>{group}</a>)}</nav>
        <form className="form-panel">
          {groups.map((group, index) => <section id={`group-${index}`} key={group}><h2>{group}</h2>
            <div className="field-grid">{schema.fields.filter((field) => (field.group ?? "基本情報") === group && field.type !== "hidden").map((field) => <label key={field.name}><span>{field.label ?? field.name}{field.required && <em>必須</em>}</span>{field.type === "textarea" ? <textarea value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)} placeholder={field.placeholder} /> : field.type === "select" ? <select value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, event.target.value)}><option value="">選択してください</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : field.type === "boolean" ? <input type="checkbox" checked={Boolean(formData[field.name])} onChange={(event) => updateValue(field.name, event.target.checked)} /> : <input value={String(formData[field.name] ?? "")} onChange={(event) => updateValue(field.name, field.type === "number" ? Number(event.target.value) : event.target.value)} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} placeholder={field.placeholder} />}<small>{field.helpText}{field.dbField && ` 自動補完: ${field.dbField}`}</small></label>)}</div>
          </section>)}
        </form>
        <aside className="preview"><strong>文書プレビュー</strong>{previewHtml ? <iframe title="文書プレビュー" sandbox="" srcDoc={previewHtml} /> : <div>「入力確認」でDB templateによるプレビューを生成します。</div>}<small>Template version: {schema.templateVersionId}</small></aside>
      </div>
    </section>
  );
}
