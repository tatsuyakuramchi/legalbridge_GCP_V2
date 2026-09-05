import { useEffect, useMemo, useState } from "react";

type DeadlineEvent = {
  id: string;
  eventType: string;
  title: string;
  dueDate: string;
  status: string;
  sourceType: string;
  sourceId: number;
  matterId: number | null;
  matterCode: string | null;
  matterTitle: string | null;
  counterparty: string | null;
  workTitle: string | null;
  documentNumber: string | null;
  amount: number | null;
  currency: string | null;
  ownerName: string | null;
};

const typeLabels: Record<string, string> = {
  matter_due: "案件期限",
  task_due: "タスク期限",
  contract_expiration: "契約終了",
  renewal_notice: "更新通知",
  installment_due: "支払・精算",
  inspection_due: "検収期限",
  payment_due: "支払期限",
  document_due: "文書期限",
  request_due: "法務依頼"
};

export function DeadlineWorkspace({
  onOpenMatter
}: {
  onOpenMatter: (id: number, title: string) => void;
}) {
  const initialFrom = tokyoDate(new Date());
  const initialTo = addDays(initialFrom, 30);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [events, setEvents] = useState<DeadlineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/v2/deadline-events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      signal: controller.signal
    })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setEvents(data.events ?? []))
      .catch((cause) => {
        if (cause?.name !== "AbortError") setError("期限情報を取得できませんでした。");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [from, to]);

  const today = tokyoDate(new Date());
  const overdue = useMemo(
    () => events.filter((event) => event.dueDate < today && !isClosed(event.status)),
    [events, today]
  );
  const dueSoon = useMemo(
    () => events.filter((event) => event.dueDate >= today && !isClosed(event.status)),
    [events, today]
  );

  return <section className="page deadline-page">
    <div className="page-title">
      <div><p>DEADLINES</p><h1>期限</h1>
        <small>案件・契約・検収・支払・文書の期限を横断して確認します。</small></div>
    </div>

    <div className="deadline-toolbar panel">
      <label>開始日<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>終了日<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <span>{loading ? "取得中…" : `${events.length}件`}</span>
    </div>

    {error && <div className="async-error">{error}</div>}

    <div className="kpis">
      <article className={overdue.length ? "danger" : ""}><span>期限超過</span><strong>{overdue.length}</strong></article>
      <article><span>今後30日</span><strong>{dueSoon.length}</strong></article>
      <article><span>契約関連</span><strong>{events.filter((event) => ["contract_expiration","renewal_notice"].includes(event.eventType)).length}</strong></article>
      <article><span>支払・検収</span><strong>{events.filter((event) => ["installment_due","inspection_due","payment_due"].includes(event.eventType)).length}</strong></article>
    </div>

    <section className="panel">
      <div className="panel-head"><h2>期限一覧</h2><span>{events.length}件</span></div>
      {events.length ? <div className="deadline-list">
        {events.map((event) => <button key={event.id}
          className={event.dueDate < today && !isClosed(event.status) ? "deadline-row overdue" : "deadline-row"}
          onClick={() => event.matterId && onOpenMatter(event.matterId, event.matterTitle || event.title)}
          disabled={!event.matterId}>
          <span className="deadline-date">{formatDate(event.dueDate)}</span>
          <div><strong>{event.title}</strong>
            <small>{typeLabels[event.eventType] ?? event.eventType} ・ {event.counterparty || event.workTitle || event.documentNumber || "—"}</small></div>
          <span>{event.matterCode || event.documentNumber || event.status}</span>
        </button>)}
      </div> : !loading && <div className="empty-state">指定期間に期限はありません。</div>}
    </section>
  </section>;
}

function isClosed(status: string) {
  return ["closed","archived","completed","cancelled","paid","settled","inspected"].includes(status);
}

function tokyoDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${year}/${month}/${day}`;
}
