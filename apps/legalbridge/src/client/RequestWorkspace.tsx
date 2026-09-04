import { useEffect, useMemo, useState } from "react";

type RequestSummary = {
  id: number;
  issueKey: string;
  summary: string;
  contractType: string | null;
  counterparty: string | null;
  deadline: string | null;
  notes: string | null;
  createdAt: string | null;
  matterCount: number;
  documentCount: number;
  legalResponseCount: number;
  disposition: "received" | "matter_linked" | "document_created" | "completed";
};
type RequestDetail = RequestSummary & {
  matters: Array<{
    id: number; matterCode: string | null; title: string; status: string;
    relation: string; primary: boolean;
  }>;
  documents: Array<{
    id: number; documentNumber: string | null; templateType: string;
    driveLink: string; createdAt: string | null;
  }>;
};
type MatterOption = {
  id: number; matterCode: string | null; title: string; status: string; counterparty: string;
};

export function RequestWorkspace({
  canEditMatters,
  onLegalResponse,
  onStandaloneDocument,
  onLicenseContract,
  onLicenseSettlement,
  onOpenMatter
}: {
  canEditMatters: boolean;
  onLegalResponse: (issueKey: string) => void;
  onStandaloneDocument: (issueKey: string) => void;
  onLicenseContract: (issueKey: string) => void;
  onLicenseSettlement: (issueKey: string) => void;
  onOpenMatter: (id: number, title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [matterPicker, setMatterPicker] = useState(false);
  const [matterQuery, setMatterQuery] = useState("");
  const [matters, setMatters] = useState<MatterOption[]>([]);
  const [newMatter, setNewMatter] = useState(false);
  const [newMatterTitle, setNewMatterTitle] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/v2/requests?q=${encodeURIComponent(query)}&limit=200`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => {
          const rows = data.requests ?? [];
          setRequests(rows);
          setSelectedId((current) => current ?? rows[0]?.id ?? null);
        })
        .catch((error) => { if (error?.name !== "AbortError") setNotice("依頼を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    fetch(`/api/v2/requests/${selectedId}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        setDetail(data);
        setNewMatterTitle(data.summary || data.issueKey);
      })
      .catch((error) => { if (error?.name !== "AbortError") setNotice("依頼詳細を取得できませんでした。"); });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    if (!matterPicker) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/v2/matters?q=${encodeURIComponent(matterQuery)}&limit=100`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setMatters(data.matters ?? []))
        .catch(() => setMatters([]));
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [matterPicker, matterQuery]);

  const selected = detail ?? requests.find((row) => row.id === selectedId) ?? null;
  const licenseLike = useMemo(() => {
    const hay = `${selected?.contractType ?? ""} ${selected?.summary ?? ""}`.toLowerCase();
    return hay.includes("license") || hay.includes("ライセンス") || hay.includes("利用許諾") || hay.includes("sublicense") || hay.includes("サブライセンス");
  }, [selected]);

  async function linkMatter(matterId: number, primary = false) {
    if (!detail) return;
    setNotice("案件へ紐付けています…");
    const response = await fetch(`/api/v2/requests/${detail.id}/link-matter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matterId, primary })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(result.error ?? "案件へ紐付けできませんでした。");
      return;
    }
    setDetail(result);
    setMatterPicker(false);
    setNewMatter(false);
    setNotice("依頼を案件へ紐付けました。");
    refreshList();
  }

  async function createMatterAndLink() {
    if (!detail || !newMatterTitle.trim()) return;
    setNotice("案件を作成しています…");
    const response = await fetch("/api/v2/matters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newMatterTitle.trim(),
        status: "open",
        lifecycleStage: "intake",
        counterparty: detail.counterparty,
        primaryIssueKey: detail.issueKey,
        targetDueDate: detail.deadline ? detail.deadline.slice(0, 10) : null,
        remarks: `法務依頼 ${detail.issueKey} から作成`
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(result.error ?? "案件を作成できませんでした。");
      return;
    }
    const matterId = Number(result.id ?? result.matter?.id);
    if (!matterId) {
      setNotice("案件IDを取得できませんでした。");
      return;
    }
    await linkMatter(matterId, true);
  }

  function refreshList() {
    fetch(`/api/v2/requests?q=${encodeURIComponent(query)}&limit=200`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setRequests(data.requests ?? []))
      .catch(() => undefined);
  }

  return <section className="page request-workspace">
    <div className="page-title">
      <div><p>LEGAL REQUEST INBOX</p><h1>依頼</h1>
        <small>依頼は「単発完結」または「案件化して継続管理」に振り分けます。</small>
      </div>
    </div>

    <div className="request-disposition-guide">
      <article><span>QUICK LEGAL REVIEW</span><strong>法務相談</strong><small>評価書・回答書を作成 → 共有 → Request完了。Matter不要。</small></article>
      <article><span>STANDALONE DOCUMENT</span><strong>単発文書</strong><small>覚書・通知書・合意書等を作成 → 共有 → Request完了。</small></article>
      <article><span>MATTER WORKFLOW</span><strong>継続案件</strong><small>契約・発注・権利・支払・期限が続く場合のみMatterへ接続。</small></article>
    </div>

    {notice && <div className="context-banner">{notice}</div>}

    <div className="request-layout">
      <aside className="panel request-inbox">
        <div className="ledger-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="課題キー・依頼内容・取引先を検索" />
          <span>{loading ? "取得中…" : `${requests.length}件`}</span>
        </div>
        <div className="request-items">
          {requests.map((row) => <button key={row.id}
            className={selectedId === row.id ? "selected" : ""}
            onClick={() => setSelectedId(row.id)}>
            <div><span className="mono">{row.issueKey}</span><Status value={row.disposition} /></div>
            <strong>{row.summary || "依頼内容未入力"}</strong>
            <small>{row.counterparty || "相手方未設定"} ・ {deadlineLabel(row.deadline)}</small>
          </button>)}
          {!loading && !requests.length && <div className="empty-state">依頼がありません。</div>}
        </div>
      </aside>

      <div className="request-detail">
        {!selected && <div className="panel empty-detail">一覧から依頼を選択してください。</div>}
        {selected && <div className="panel">
          <div className="request-detail-head">
            <div><span className="detail-kicker">{selected.issueKey}</span>
              <h2>{selected.summary || "法務依頼"}</h2>
              <p>{selected.counterparty || "相手方未設定"}　{deadlineLabel(selected.deadline)}</p>
            </div>
            <Status value={selected.disposition} />
          </div>

          <div className="request-facts">
            <div><span>依頼種別</span><strong>{selected.contractType || "未分類"}</strong></div>
            <div><span>案件</span><strong>{selected.matterCount}件</strong></div>
            <div><span>関連文書</span><strong>{selected.documentCount}件</strong></div>
          </div>
          {selected.notes && <div className="request-notes">{selected.notes}</div>}

          <section className="request-action-section">
            <h3>この依頼を処理</h3>
            <div className="request-action-grid">
              <button onClick={() => onLegalResponse(selected.issueKey)}>
                <span>単発完結</span><strong>法務相談 → 評価書/回答書</strong>
                <small>legal_responseを作成し、Drive・Slack/Email共有後に終了</small>
              </button>
              <button onClick={() => onStandaloneDocument(selected.issueKey)}>
                <span>単発完結</span><strong>覚書・通知書等を作成</strong>
                <small>Templateを選択。継続管理が不要ならMatterを作らない</small>
              </button>
              {licenseLike && <button onClick={() => onLicenseContract(selected.issueKey)}>
                <span>ライセンス</span><strong>新規ライセンス契約</strong>
                <small>作品 → 権利ソース → IN/OUT条件 → 契約書作成</small>
              </button>}
              {licenseLike && <button onClick={() => onLicenseSettlement(selected.issueKey)}>
                <span>ライセンス精算</span><strong>利用許諾計算書を作成</strong>
                <small>製造・販売・サブライセンス料入金をトリガーに自動計算</small>
              </button>}
              <button className="primary-action" onClick={() => setMatterPicker(true)}>
                <span>継続管理</span><strong>既存案件へ紐付け</strong>
                <small>契約・期限・履行が続く場合に利用</small>
              </button>
              {canEditMatters && <button onClick={() => setNewMatter(true)}>
                <span>継続管理</span><strong>新規案件を作成</strong>
                <small>依頼を主依頼としてMatterを作成</small>
              </button>}
            </div>
          </section>

          {detail?.matters?.length ? <section className="request-related">
            <h3>関連案件</h3>
            {detail.matters.map((matter) => <button key={matter.id}
              onClick={() => onOpenMatter(matter.id, matter.title)}>
              <span>{matter.matterCode || `Matter #${matter.id}`}</span>
              <strong>{matter.title}</strong>
              <small>{matter.primary ? "主案件" : matter.relation} ・ {matter.status}</small>
            </button>)}
          </section> : null}

          {detail?.documents?.length ? <section className="request-related">
            <h3>関連文書</h3>
            {detail.documents.slice(0, 8).map((document) => <div key={document.id} className="request-document-row">
              <span>{document.documentNumber || `Document #${document.id}`}</span>
              <strong>{document.templateType}</strong>
              {document.driveLink && <a href={document.driveLink} target="_blank" rel="noreferrer">Drive ↗</a>}
            </div>)}
          </section> : null}
        </div>}
      </div>
    </div>

    {matterPicker && detail && <div className="request-modal-backdrop" onClick={() => setMatterPicker(false)}>
      <div className="request-modal" onClick={(event) => event.stopPropagation()}>
        <div className="request-modal-head"><div><span>LINK MATTER</span><h2>既存案件へ紐付け</h2></div>
          <button onClick={() => setMatterPicker(false)}>×</button></div>
        <input value={matterQuery} onChange={(event) => setMatterQuery(event.target.value)}
          placeholder="案件名・案件番号・取引先で検索" />
        <div className="request-modal-list">
          {matters.map((matter) => <button key={matter.id} onClick={() => linkMatter(matter.id, false)}>
            <span>{matter.matterCode || `#${matter.id}`}</span><strong>{matter.title}</strong>
            <small>{matter.counterparty || "相手方未設定"} ・ {matter.status}</small>
          </button>)}
        </div>
      </div>
    </div>}

    {newMatter && detail && <div className="request-modal-backdrop" onClick={() => setNewMatter(false)}>
      <div className="request-modal compact" onClick={(event) => event.stopPropagation()}>
        <div className="request-modal-head"><div><span>NEW MATTER</span><h2>新規案件を作成</h2></div>
          <button onClick={() => setNewMatter(false)}>×</button></div>
        <label>案件名<input value={newMatterTitle} onChange={(event) => setNewMatterTitle(event.target.value)} /></label>
        <dl><div><dt>主依頼</dt><dd>{detail.issueKey}</dd></div>
          <div><dt>取引先</dt><dd>{detail.counterparty || "—"}</dd></div></dl>
        <div className="request-modal-actions"><button onClick={() => setNewMatter(false)}>キャンセル</button>
          <button className="primary" onClick={createMatterAndLink}>案件作成＋紐付け</button></div>
      </div>
    </div>}
  </section>;
}

function Status({ value }: { value: RequestSummary["disposition"] }) {
  const labels = {
    received: "案件未設定",
    matter_linked: "案件紐付済",
    document_created: "文書作成済",
    completed: "法務回答済"
  };
  return <span className={`request-status ${value}`}>{labels[value]}</span>;
}
function deadlineLabel(value: string | null) {
  if (!value) return "期限未設定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `期限 ${new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" }).format(date)}`;
}
