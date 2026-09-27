import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  DEFAULT_MAIL_TEMPLATES, MAIL_TEMPLATE_FIELDS, MAIL_TEMPLATE_KINDS, MAIL_TEMPLATES_KEY,
  parseMailTemplates, readMailTemplates, renderMail, type MailTemplateKind, type MailTemplates
} from "../server/ops/mail-templates.js";

/**
 * 文書を送るメールの文面。担当者への確認・取引先への内容確認・検収書・利用許諾計算書・
 * その他の書類の 5 通りと、共通の署名をここで変える。
 *
 * 定義はサーバと同じもの（ops/mail-templates.ts）を読む。保存前に同じ規則で確かめ、
 * サーバでももう一度確かめる。
 */

const SAMPLE: Record<string, string> = {
  相手先: "株式会社サンプル", 宛名: "山田 太郎", 文書番号: "ARC-IC-2026-1001", 文書名: "検収書",
  案件番号: "MTR-2026-00012", 案件名: "イラスト制作", 金額: "¥110,000", 発行日: "2026年9月27日",
  会社名: "株式会社アークライト"
};

export function MailTemplatesForm({ value, onSaved }: { value: unknown; onSaved: () => void }) {
  const [draft, setDraft] = useState<MailTemplates>(DEFAULT_MAIL_TEMPLATES);
  const [kind, setKind] = useState<MailTemplateKind>("owner_check");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showSample, setShowSample] = useState(false);

  useEffect(() => { setDraft(readMailTemplates(value)); }, [JSON.stringify(value)]);

  const current = draft.templates[kind];
  const setCurrent = (patch: Partial<{ subject: string; body: string }>) => {
    setDraft({ ...draft, templates: { ...draft.templates, [kind]: { ...current, ...patch } } });
    setSaved(false);
  };

  async function save() {
    const parsed = parseMailTemplates(draft);
    if (parsed.errors.length) { setError(parsed.errors.join(" ／ ")); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/settings/${MAIL_TEMPLATES_KEY}`, { value: parsed.value });
      setSaved(true);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const sample = renderMail(current, draft.signature, SAMPLE);
  const meta = MAIL_TEMPLATE_KINDS.find((k) => k.kind === kind)!;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>メールの文面</h2>
        <span className="faint">文書の「送る」で使う件名と本文。送る画面で下書きになり、送る前に直せます</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}

        <div className="row" style={{ flexWrap: "wrap" }}>
          {MAIL_TEMPLATE_KINDS.map((k) => (
            <button key={k.kind} className="chip" aria-pressed={kind === k.kind} title={k.hint}
                    onClick={() => setKind(k.kind)}>{k.label}</button>
          ))}
        </div>
        <div className="faint">{meta.hint}</div>

        <label className="field wide">
          <span>件名</span>
          <input value={current.subject} onChange={(e) => setCurrent({ subject: e.target.value })} />
        </label>
        <label className="field wide">
          <span>本文</span>
          <textarea rows={16} value={current.body} onChange={(e) => setCurrent({ body: e.target.value })} />
        </label>
        <div className="row">
          <button className="btn" onClick={() => setCurrent(DEFAULT_MAIL_TEMPLATES.templates[kind])}>
            この文面を既定に戻す
          </button>
          <button className="btn" onClick={() => setShowSample(!showSample)}>
            {showSample ? "見本を閉じる" : "見本で見る"}
          </button>
        </div>
        {showSample && (
          <pre className="locked" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {`件名：${sample.subject}\n\n${sample.body}`}
          </pre>
        )}

        <label className="field wide">
          <span>署名（本文の {"{署名}"} に入る。全部の文面で共通）</span>
          <textarea rows={6} value={draft.signature}
                    onChange={(e) => { setDraft({ ...draft, signature: e.target.value }); setSaved(false); }} />
        </label>

        <div className="faint">
          差し込める項目：{MAIL_TEMPLATE_FIELDS.map((f) => (
            <span key={f.name} title={f.label} style={{ marginRight: 8 }}><span className="code">{`{${f.name}}`}</span></span>
          ))}
          <br />値の無い項目は空になります。宛名が分からないときは「◯◯ 様」の行ごと出しません。
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>保存する</button>
          {saved && <span className="faint">保存しました。次に開く送る画面から使われます。</span>}
        </div>
      </div>
    </div>
  );
}
