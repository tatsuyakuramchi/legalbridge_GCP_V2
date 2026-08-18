import { useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import { resolveSlackMentions, slackDisplayName } from "../slack-mentions";
import {
  MATTER_SLACK_TEMPLATES, composeTemplateText, filterMentionCandidates,
  templateUsesDocument, type MatterSlackTemplateId, type MentionCandidate
} from "../matter-slack-message";

// 案件詳細の Slack「法務相談」パネル。スレッド作成／メンション付き投稿／定型文／会話表示。
// Slack 連携が無効（未設定）の場合は目立たないヒントのみ表示する。

type Thread = { channelId: string; threadTs: string } | null;
type Reply = { ts: string; user: string | null; text: string; bot: boolean };
type SlackDocument = { id: number; documentNumber: string | null; driveLink: string };

// 0 = 自由入力、1〜3 = 定型文。定型文は「宛先を選んでから送信」なので、
// ボタンを押した瞬間に投稿してしまわないよう、まずモードを切り替える。
type Mode = 0 | MatterSlackTemplateId;

/**
 * メンションの複数選択。候補が増えると一覧から目で探すのは無理なので、
 * 開いて名前で検索する（V1 の MentionPicker と同じ操作）。
 * 選んだ相手は閉じた状態でもチップとして残り、×で外せる。
 */
function MentionPicker({ label, candidates, selected, onToggle }: {
  label: string;
  candidates: MentionCandidate[];
  selected: MentionCandidate[];
  onToggle: (candidate: MentionCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterMentionCandidates(candidates, query), [candidates, query]);
  return <div className="mention-picker">
    <div className="mention-picker-row">
      <button type="button" className="mention-open"
        onClick={() => { setOpen((v) => !v); setQuery(""); }}>
        ＠{label}
      </button>
      {selected.map((m) => <span key={m.id} className="mention-chip active">
        @{m.name}
        <button type="button" title="外す" onClick={() => onToggle(m)}>×</button>
      </span>)}
      {!selected.length && <small className="muted-note">未選択</small>}
    </div>
    {open && <div className="mention-picker-body">
      <input autoFocus value={query} placeholder="名前で検索…"
        onChange={(event) => setQuery(event.target.value)} />
      <div className="mention-picker-list">
        {!filtered.length && <small className="muted-note">該当なし</small>}
        {filtered.map((c) => <button key={c.id} type="button"
          className={`mention-chip ${selected.some((m) => m.id === c.id) ? "active" : ""}`}
          onClick={() => onToggle(c)}>@{c.name}</button>)}
      </div>
    </div>}
  </div>;
}

export function MatterSlackPanel({ matterId, documents = [] }: {
  matterId: number;
  documents?: SlackDocument[];
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [thread, setThread] = useState<Thread>(null);
  const [messages, setMessages] = useState<Reply[]>([]);
  const [to, setTo] = useState<MentionCandidate[]>([]);
  const [cc, setCc] = useState<MentionCandidate[]>([]);
  const [mode, setMode] = useState<Mode>(0);
  const [documentId, setDocumentId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const linkedDocuments = useMemo(
    () => documents.filter((d) => Boolean(d.driveLink)), [documents]);

  useEffect(() => {
    let cancelled = false;
    setTo([]); setCc([]); setText(""); setMode(0); setDocumentId(null);
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

  // 閲覧リンクを載せる定型文へ切り替えたら、未選択なら先頭の文書を既定にする。
  useEffect(() => {
    if (mode !== 0 && templateUsesDocument(mode) && documentId === null && linkedDocuments.length) {
      setDocumentId(linkedDocuments[0].id);
    }
  }, [mode, documentId, linkedDocuments]);

  // 発言者・本文の Slack ユーザーID（U…／<@U…>）は担当者マスタの氏名で表示する。
  const names = useMemo(() => new Map(candidates.map((c) => [c.id, c.name])), [candidates]);

  const toggleIn = (setter: typeof setTo) => (candidate: MentionCandidate) =>
    setter((current) => current.some((m) => m.id === candidate.id)
      ? current.filter((m) => m.id !== candidate.id)
      : [...current, candidate]);

  // 送信前プレビュー。実際の投稿では @氏名 が <@ID> に置き換わる（本文の形は同じ関数）。
  const preview = useMemo(() => {
    if (mode === 0) {
      const prefix = to.map((m) => `@${m.name}`).join(" ");
      return [prefix, text.trim()].filter(Boolean).join(" ");
    }
    const link = templateUsesDocument(mode)
      ? linkedDocuments.find((d) => d.id === documentId)?.driveLink ?? null
      : null;
    return composeTemplateText(mode, {
      to: to.map((m) => `@${m.name}`),
      cc: cc.map((m) => `@${m.name}`),
      driveLink: link
    });
  }, [mode, to, cc, text, documentId, linkedDocuments]);

  async function run(request: Promise<Response>, ok: string) {
    setBusy(true);
    try {
      await toast.run(request.then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), ok);
      setReload((v) => v + 1);
      return true;
    } catch { return false; }
    finally { setBusy(false); }
  }

  async function send() {
    if (mode === 0) {
      if (!preview.trim()) return;
      const done = await run(fetch(`/api/v2/matters/${matterId}/slack/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mentions: to.map((m) => m.id) })
      }), "投稿しました");
      if (done) { setText(""); setTo([]); }
      return;
    }
    // 定型文は宛先が本文の一部（「@誰々 に完了を知らせる」）なので、空では出さない。
    if (!to.length) { toast.push("メンション先を1名以上選択してください", "error"); return; }
    const label = MATTER_SLACK_TEMPLATES.find((t) => t.id === mode)?.label ?? "定型文";
    const done = await run(fetch(`/api/v2/matters/${matterId}/slack/template`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: mode,
        mentions: to.map((m) => m.id),
        cc: cc.map((m) => m.id),
        ...(templateUsesDocument(mode) && documentId !== null ? { documentId } : {})
      })
    }), `定型文（${label}）を投稿しました`);
    if (done) { setTo([]); setCc([]); setMode(0); setDocumentId(null); }
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
      <div className="matter-slack-modes">
        <button type="button" className={mode === 0 ? "active" : ""} onClick={() => setMode(0)}>自由入力</button>
        {MATTER_SLACK_TEMPLATES.map((t) => <button key={t.id} type="button"
          className={mode === t.id ? "active" : ""} onClick={() => setMode(t.id)}>{t.label}</button>)}
      </div>

      <MentionPicker label="宛先" candidates={candidates} selected={to} onToggle={toggleIn(setTo)} />
      {mode !== 0 && <MentionPicker label="CC" candidates={candidates} selected={cc} onToggle={toggleIn(setCc)} />}
      {!candidates.length &&
        <small className="muted-note">メンション候補がありません（担当者マスタに Slack ID を登録してください）。</small>}

      {mode !== 0 && templateUsesDocument(mode) && <label className="matter-slack-doc">閲覧リンク
        <select value={documentId ?? ""} onChange={(event) =>
          setDocumentId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">添付しない</option>
          {linkedDocuments.map((d) => <option key={d.id} value={d.id}>{d.documentNumber ?? `#${d.id}`}</option>)}
        </select>
        {!linkedDocuments.length && <small className="muted-note">Drive 保存済みの文書がありません。</small>}
      </label>}

      {mode === 0 && <textarea value={text} rows={2}
        placeholder="メッセージ（選択した宛先が先頭に付きます）"
        onChange={(event) => setText(event.target.value)} />}

      <div className="matter-slack-compose">
        <pre className="matter-slack-preview" aria-label="送信前プレビュー">{preview || "（送信内容が空です）"}</pre>
        <button className="primary" disabled={busy || !preview.trim()} onClick={() => void send()}>
          {busy ? "送信中…" : "送信"}
        </button>
      </div>

      <div className="matter-slack-thread">
        {messages.map((m) => <article key={m.ts} className={m.bot ? "bot" : ""}>
          <span>{m.bot ? "Bot" : (slackDisplayName(m.user, names) || "—")}</span>
          <p>{resolveSlackMentions(m.text, names)}</p></article>)}
        {!messages.length && <small className="muted-note">まだ投稿はありません。</small>}
      </div>
    </>}
  </div>;
}
