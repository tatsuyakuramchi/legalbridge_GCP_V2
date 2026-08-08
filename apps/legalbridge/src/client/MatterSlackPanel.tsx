import { useEffect, useState } from "react";
import { useToast } from "./Toast";

// 案件詳細の Slack「法務相談」パネル。スレッド作成／メンション付き投稿／定型文／会話表示。
// Slack 連携が無効（未設定）の場合は目立たないヒントのみ表示する。

type Candidate = { name: string; id: string };
type Thread = { channelId: string; threadTs: string } | null;
type Reply = { ts: string; user: string | null; text: string; bot: boolean };

const TEMPLATES: Array<{ id: 1 | 2 | 3; label: string }> = [
  { id: 1, label: "クラウドサイン送信済" },
  { id: 2, label: "文書作成完了" },
  { id: 3, label: "評価完了" }
];

export function MatterSlackPanel({ matterId }: { matterId: number }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [thread, setThread] = useState<Thread>(null);
  const [messages, setMessages] = useState<Reply[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSelected([]); setText("");
    void (async () => {
      const [cRes, rRes] = await Promise.all([
        fetch("/api/v2/matters/slack/mention-candidates"),
        fetch(`/api/v2/matters/${matterId}/slack/replies`)
      ]);
      if (cancelled) return;
      if (cRes.ok) {
        const body = await cRes.json();
        setEnabled(Boolean(body.enabled));
        setCandidates(Array.isArray(body.candidates) ? body.candidates : []);
      }
      if (rRes.ok) {
        const body = await rRes.json();
        setThread(body.thread ? { channelId: body.thread.channelId, threadTs: body.thread.threadTs } : null);
        setMessages(Array.isArray(body.messages) ? body.messages : []);
      }
    })();
    return () => { cancelled = true; };
  }, [matterId, reload]);

  function toggle(id: string) {
    setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }
  async function run(request: Promise<Response>, ok: string) {
    setBusy(true);
    try {
      await toast.run(request.then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), ok);
      setReload((v) => v + 1);
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }

  if (enabled === false) {
    return <div className="matter-slack muted"><span className="detail-kicker">SLACK 法務相談</span>
      <p className="muted-note">Slack 連携が未設定のため利用できません。</p></div>;
  }
  if (enabled === null) return <div className="matter-slack"><span className="detail-kicker">SLACK 法務相談</span><p className="muted-note">読み込み中…</p></div>;

  return <div className="matter-slack">
    <div className="matter-slack-head"><span className="detail-kicker">SLACK 法務相談</span>
      {!thread && <button className="primary" disabled={busy}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/slack/thread`, { method: "POST" }), "スレッドを作成しました")}>スレッド作成</button>}
    </div>

    {thread && <>
      <div className="matter-slack-mentions">
        {candidates.map((c) => <button key={c.id} type="button"
          className={`mention-chip ${selected.includes(c.id) ? "active" : ""}`}
          onClick={() => toggle(c.id)}>@{c.name}</button>)}
        {!candidates.length && <small className="muted-note">メンション候補（staff の Slack ID）がありません。</small>}
      </div>
      <div className="matter-slack-compose">
        <textarea value={text} placeholder="メッセージ（選択したメンションが先頭に付きます）"
          onChange={(e) => setText(e.target.value)} rows={2} />
        <button className="primary" disabled={busy || !text.trim()}
          onClick={() => run(fetch(`/api/v2/matters/${matterId}/slack/messages`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, mentions: selected })
          }), "投稿しました").then(() => setText(""))}>投稿</button>
      </div>
      <div className="matter-slack-templates">
        {TEMPLATES.map((t) => <button key={t.id} type="button" disabled={busy}
          onClick={() => run(fetch(`/api/v2/matters/${matterId}/slack/template`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ template: t.id, mentions: selected })
          }), `定型文（${t.label}）を投稿しました`)}>{t.label}</button>)}
      </div>
      <div className="matter-slack-thread">
        {messages.map((m) => <article key={m.ts} className={m.bot ? "bot" : ""}>
          <span>{m.bot ? "Bot" : (m.user ?? "—")}</span><p>{m.text}</p></article>)}
        {!messages.length && <small className="muted-note">まだ投稿はありません。</small>}
      </div>
    </>}
  </div>;
}
