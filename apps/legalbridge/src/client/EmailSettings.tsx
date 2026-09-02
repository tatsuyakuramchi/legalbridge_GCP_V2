import { useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { StaffEmailSearch } from "./StaffEmailSearch";

// メール設定（文面テンプレート・既定CC・テスト送信）。V1 の loadEmailCfg 設定群の編集画面。
// プレースホルダーは手打ちさせず「挿入」ボタンから入れる（トークン名間違い防止）。
// プレビューはサーバが返す架空サンプル値でその場描画する。

type Kind = "inspection" | "royalty" | "general";
const KIND_LABELS: Record<Kind, string> = {
  inspection: "検収書", royalty: "利用許諾料計算書", general: "その他の文書"
};
const KINDS: Kind[] = ["inspection", "royalty", "general"];

type Token = { token: string; label: string; sample: string };
type Template = { subject: string; body: string };

type Loaded = {
  cc: string;
  custom: Record<string, string>;
  defaults: Record<Kind, Template>;
  tokens: Token[];
  sampleVars: Record<string, string>;
  writeEnabled: boolean;
};

function applyTokens(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole);
}
function cleanupBody(body: string): string {
  return body.split("\n")
    .filter((line) => !/^(■ .+：|文書URL：|TEL：)$/.test(line.trim()))
    .join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

export function EmailSettings() {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>("inspection");
  const [cc, setCc] = useState("");
  const [templates, setTemplates] = useState<Record<Kind, Template> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState("");
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  // 直近フォーカスされた入力（挿入ボタンの入れ先）。既定は本文。
  const focusTarget = useRef<"subject" | "body">("body");

  useEffect(() => {
    fetch("/api/v2/email-settings")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("load failed")))
      .then((d: Loaded) => {
        setLoaded(d);
        setCc(d.cc ?? "");
        const initial = {} as Record<Kind, Template>;
        for (const k of KINDS) {
          initial[k] = {
            subject: String(d.custom[`email_subject_${k}`] ?? "").trim() || d.defaults[k].subject,
            body: String(d.custom[`email_body_${k}`] ?? "").trim() ? String(d.custom[`email_body_${k}`]) : d.defaults[k].body
          };
        }
        setTemplates(initial);
      })
      .catch(() => setError("メール設定を読み込めませんでした（管理者のみ表示できます）。"));
  }, []);

  if (error) return <section className="page"><h1>メール設定</h1><div className="async-error">{error}</div></section>;
  if (!loaded || !templates) return <section className="page"><h1>メール設定</h1><p>読み込み中…</p></section>;

  const current = templates[kind];
  const isDefault = current.subject === loaded.defaults[kind].subject && current.body.trim() === loaded.defaults[kind].body.trim();

  function update(patch: Partial<Template>) {
    setTemplates((prev) => prev ? { ...prev, [kind]: { ...prev[kind], ...patch } } : prev);
    setDirty(true);
  }

  // 挿入: 直近フォーカスの入力のカーソル位置へトークンを差し込む。
  function insertToken(token: string) {
    const isSubject = focusTarget.current === "subject";
    const el = isSubject ? subjectRef.current : bodyRef.current;
    const value = isSubject ? current.subject : current.body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    update(isSubject ? { subject: next } : { body: next });
    // カーソルをトークン直後へ戻す
    requestAnimationFrame(() => {
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; }
    });
  }

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/v2/email-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cc, templates })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "保存に失敗しました", "error"); return; }
      setDirty(false);
      toast.push("メール設定を保存しました", "success");
    } catch { toast.push("通信に失敗しました", "error"); } finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setTestResult("");
    try {
      const response = await fetch("/api/v2/email-settings/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo, kind, subject: current.subject, body: current.body })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTestResult(`✗ ${data.error ?? "送信に失敗しました"}${data.blockers ? `（${data.blockers.join("／")}）` : ""}`);
        return;
      }
      setTestResult(`✓ テストメールを ${testTo} へ送信しました（編集中の文面・架空データ）`);
    } catch { setTestResult("✗ 通信に失敗しました"); } finally { setBusy(false); }
  }

  const previewSubject = applyTokens(current.subject, loaded.sampleVars);
  const previewBody = cleanupBody(applyTokens(current.body, loaded.sampleVars));

  return <section className="page">
    <div className="page-title"><div><p>EMAIL SETTINGS</p><h1>メール設定</h1>
      <small>文書メール送信の文面テンプレート・既定CC・テスト送信</small></div></div>

    {!loaded.writeEnabled && <div className="async-error">
      設定の保存は現在有効化されていません（表示・テスト送信のみ可能）。
    </div>}

    <div className="doc-integration-card">
      <strong>既定CC（全送信に自動で追加）</strong>
      <label>CCアドレス<input value={cc} onChange={(e) => { setCc(e.target.value); setDirty(true); }}
        placeholder="keiri@example.co.jp（複数はカンマ区切り・空欄=なし）" /></label>
      <StaffEmailSearch label="当社担当者を検索して既定CCに追加" onPick={(email) => {
        setCc((prev) => {
          const list = prev.split(",").map((s) => s.trim()).filter(Boolean);
          if (list.some((e) => e.toLowerCase() === email.toLowerCase())) return prev;
          return [...list, email].join(", ");
        });
        setDirty(true);
      }} />
      <small className="settings-effective">送信のたびに都度入力するCCとマージされ、重複と宛先かぶりは自動で除外されます。</small>
    </div>

    <div className="doc-integration-card">
      <strong>文面テンプレート</strong>
      <div style={{ margin: "6px 0" }}>
        {KINDS.map((k) => <button key={k} type="button"
          className={`matter-chip ${kind === k ? "active" : ""}`}
          onClick={() => setKind(k)}>{KIND_LABELS[k]}</button>)}
        {isDefault
          ? <small className="settings-effective">（既定の文面を使用中）</small>
          : <button type="button" className="link-button"
              onClick={() => { if (window.confirm("この種別の文面を既定に戻しますか？")) update({ ...loaded.defaults[kind] }); }}>
              既定の文面に戻す</button>}
      </div>

      <small className="settings-effective">プレースホルダー（クリックでカーソル位置に挿入・送信時に実際の値へ置き換わります）：</small>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "4px 0 10px" }}>
        {loaded.tokens.map((t) => <button key={t.token} type="button" className="link-button"
          title={`例: ${t.sample}`} onClick={() => insertToken(t.token)}>＋{t.label}</button>)}
      </div>

      <label>件名
        <input ref={subjectRef} value={current.subject}
          onFocus={() => { focusTarget.current = "subject"; }}
          onChange={(e) => update({ subject: e.target.value })} maxLength={200} />
      </label>
      <label>本文
        <textarea ref={bodyRef} value={current.body} rows={18}
          onFocus={() => { focusTarget.current = "body"; }}
          onChange={(e) => update({ body: e.target.value })} maxLength={4000}
          style={{ fontFamily: "inherit", width: "100%" }} />
      </label>
      <small className="settings-effective">
        値が空のプレースホルダーを含む行（■ 金額：／文書URL：／TEL：）は送信時に自動で省かれます。
      </small>
    </div>

    <div className="doc-integration-card">
      <strong>プレビュー（架空データで表示）</strong>
      <div className="doc-integration-preview">
        <div><b>件名：</b>{previewSubject}</div>
        <pre>{previewBody}</pre>
      </div>
    </div>

    <div className="doc-integration-card">
      <strong>テスト送信</strong>
      <label>送信先（自分のアドレス推奨）<input value={testTo} onChange={(e) => setTestTo(e.target.value)}
        placeholder="you@arclight.co.jp" /></label>
      <div className="doc-integration-actions">
        <button onClick={() => void sendTest()} disabled={busy || !testTo.trim()}>
          この文面でテスト送信（{KIND_LABELS[kind]}）</button>
      </div>
      {testResult && <small className={testResult.startsWith("✓") ? "settings-effective" : "doc-integration-blocked"}>{testResult}</small>}
      <small className="settings-effective">編集中の文面を架空データで描画して送ります（保存前でも試せます）。件名に【テスト送信】が付き、送信履歴には記録されません。</small>
    </div>

    <div className="doc-integration-actions" style={{ marginTop: "12px" }}>
      <button className="primary" onClick={() => void save()} disabled={busy || !dirty || !loaded.writeEnabled}>保存</button>
      {dirty && <small className="settings-effective">未保存の変更があります</small>}
    </div>
  </section>;
}
