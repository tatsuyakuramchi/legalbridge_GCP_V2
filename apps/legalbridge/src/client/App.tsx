import { useEffect, useState } from "react";
import type { DashboardSummary, DocumentFormSchema } from "../types";

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
  const [schema, setSchema] = useState<DocumentFormSchema | null>(null);
  const [view, setView] = useState<"home" | "document">("home");

  useEffect(() => {
    fetch("/api/v2/dashboard").then((response) => response.ok && response.json()).then((data) => data && setDashboard(data)).catch(() => undefined);
  }, []);

  async function openDocumentForm() {
    const response = await fetch("/api/v2/document-templates/purchase_order/form-schema");
    if (response.ok) setSchema(await response.json());
    setView("document");
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">LegalBridge <span>V2</span></div>
        <nav>
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>ホーム</button>
          <button>案件</button>
          <button className={view === "document" ? "active" : ""} onClick={openDocumentForm}>文書</button>
          <button>台帳</button>
          <button>管理</button>
        </nav>
        <div className="backlog"><strong>Backlog連携</strong><small>参照のみ・変更なし</small></div>
      </aside>

      <main>
        <header>
          <input aria-label="グローバル検索" placeholder="案件、文書、契約、作品を検索" />
          <div className="profile">法務担当</div>
        </header>

        {view === "home" ? (
          <Dashboard dashboard={dashboard} onCreateDocument={openDocumentForm} />
        ) : (
          <DocumentForm schema={schema} />
        )}
      </main>
    </div>
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

function DocumentForm({ schema }: { schema: DocumentFormSchema | null }) {
  if (!schema) return <section className="page"><h1>文書作成</h1><p>フォーム定義を読み込んでいます。</p></section>;
  const groups = [...new Set(schema.fields.map((field) => field.group ?? "基本情報"))];
  return (
    <section className="page">
      <div className="page-title"><div><p>DOCUMENT COMMAND</p><h1>{schema.label}</h1></div><button className="primary">下書き保存</button></div>
      <div className="form-layout">
        <nav className="form-nav">{groups.map((group, index) => <a key={group} href={`#group-${index}`}>{group}</a>)}</nav>
        <form className="form-panel">
          {groups.map((group, index) => <section id={`group-${index}`} key={group}><h2>{group}</h2>
            <div className="field-grid">{schema.fields.filter((field) => (field.group ?? "基本情報") === group && field.type !== "hidden").map((field) => <label key={field.name}><span>{field.label ?? field.name}{field.required && <em>必須</em>}</span>{field.type === "textarea" ? <textarea placeholder={field.placeholder} /> : field.type === "select" ? <select>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} placeholder={field.placeholder} />}<small>{field.helpText}{field.dbField && ` 自動補完: ${field.dbField}`}</small></label>)}</div>
          </section>)}
        </form>
        <aside className="preview"><strong>文書プレビュー</strong><div>入力内容がDB templateへ反映されます。</div><small>Template version: {schema.templateVersionId}</small></aside>
      </div>
    </section>
  );
}
