import { useEffect, useState } from "react";

// 案件の Slack 会話履歴（読取専用・admin/legal）。方針 §12。
// - 案件詳細を開いたときだけ取得し、自動ポーリングはしない（Slack のレート制限対策）
// - Slack 側が落ちても案件詳細本体には影響させない（このパネル内だけでエラー表示）
// - 「更新」で明示的に再取得（サーバ側の短期キャッシュを迂回）

interface SlackMessage {
  ts: string;
  authorType: "legalbridge" | "user" | "unknown";
  authorId: string | null;
  authorName: string;
  text: string;
  isRoot: boolean;
}

interface SlackHistory {
  configured: boolean;
  linked: boolean;
  available: boolean;
  reason?: string;
  thread: { channelId: string; rootMessageTs: string; legacyRootCount: number } | null;
  messages: SlackMessage[];
  deliveries: Array<{ headline: string; outcome: string; recordedAt: string }>;
  fetchedAt?: string;
}

const REASON_LABELS: Record<string, string> = {
  rate_limited: "Slack のレート制限に達しました。しばらく待って再試行してください。",
  missing_scope: "Slack アプリに会話履歴の参照権限（im:history）がありません。再インストールが必要です。",
  not_found: "Slack 側でスレッドが見つかりませんでした（削除された可能性があります）。",
  invalid_anchor: "保存されているスレッド情報が不正です。",
  unavailable: "Slack 履歴を取得できませんでした。"
};

// Slack の ts（秒.マイクロ秒）を日時表示へ。
function when(ts: string) {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  const date = new Date(seconds * 1000);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function MatterSlackHistory({ matterId }: { matterId: number }) {
  const [data, setData] = useState<SlackHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  async function load(refresh = false) {
    setLoading(true); setFailed(false);
    try {
      const res = await fetch(
        `/api/v2/matters/${matterId}/slack${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) { setFailed(true); setData(null); return; }
      setData(await res.json());
    } catch { setFailed(true); setData(null); } finally { setLoading(false); }
  }

  useEffect(() => {
    let cancelled = false;
    setData(null); setLoading(true); setFailed(false);
    void (async () => {
      try {
        const res = await fetch(`/api/v2/matters/${matterId}/slack`);
        // 案件を切り替えた後に前の案件のレスポンスを表示しない。
        if (cancelled) return;
        if (!res.ok) { setFailed(true); return; }
        setData(await res.json());
      } catch { if (!cancelled) setFailed(true); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [matterId]);

  if (loading) {
    return <div className="slack-history"><p className="muted-note">Slack 履歴を読み込んでいます…</p></div>;
  }
  if (failed || !data) {
    return <div className="slack-history">
      <p className="muted-note">Slack履歴を取得できませんでした。</p>
      <button type="button" className="link-button" onClick={() => void load(true)}>再試行</button>
    </div>;
  }
  if (!data.linked) {
    return <div className="slack-history">
      <p className="muted-note">この案件には Slack スレッドがまだありません。</p>
    </div>;
  }
  if (!data.configured) {
    return <div className="slack-history">
      <p className="muted-note">Slack 履歴参照は現在無効です（送信履歴のみ表示できます）。</p>
      <DeliveryList deliveries={data.deliveries} />
    </div>;
  }
  if (!data.available) {
    return <div className="slack-history">
      <p className="muted-note">{REASON_LABELS[data.reason ?? "unavailable"] ?? REASON_LABELS.unavailable}</p>
      <button type="button" className="link-button" onClick={() => void load(true)}>再試行</button>
      <DeliveryList deliveries={data.deliveries} />
    </div>;
  }

  return <div className="slack-history">
    <div className="slack-history-head">
      <button type="button" className="link-button" onClick={() => void load(true)}>Slack履歴を更新</button>
      {data.fetchedAt && <small className="muted-note">
        取得: {new Date(data.fetchedAt).toLocaleTimeString("ja-JP")}
      </small>}
    </div>
    {data.thread && data.thread.legacyRootCount > 0 &&
      <p className="muted-note">旧方式で送信された通知が {data.thread.legacyRootCount} 件あります（別メッセージとして残っています）。</p>}
    {data.messages.length === 0
      ? <p className="muted-note">このスレッドにはまだ投稿がありません。</p>
      : <ol className="slack-thread">
          {data.messages.map((message) => <li key={message.ts}
            className={message.authorType === "legalbridge" ? "from-bot" : ""}>
            <div className="slack-msg-head">
              <strong>{message.authorName}</strong>
              <small>{when(message.ts)}</small>
              {message.isRoot && <small className="slack-root-badge">起点</small>}
            </div>
            <p>{message.text}</p>
          </li>)}
        </ol>}
  </div>;
}

function DeliveryList({ deliveries }: { deliveries: SlackHistory["deliveries"] }) {
  if (!deliveries.length) return null;
  return <ul className="slack-deliveries">
    {deliveries.map((delivery, index) => <li key={index}>
      <small>{new Date(delivery.recordedAt).toLocaleString("ja-JP")}</small>
      {" "}{delivery.headline || "（件名なし）"}
      <small className="muted-note">（{delivery.outcome}）</small>
    </li>)}
  </ul>;
}
