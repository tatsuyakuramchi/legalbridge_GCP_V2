import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  DEFAULT_MAIL_TEMPLATES, MAIL_TEMPLATE_FIELDS, MAIL_TEMPLATE_KINDS, MAIL_TEMPLATES_KEY,
  parseMailTemplates, readMailTemplates, renderMail, type CustomMailTemplate, type MailTemplateKind, type MailTemplates
} from "../server/ops/mail-templates.js";

/**
 * 設定 › メールの文面。
 *
 * 決まった文面（担当者への確認・取引先への内容確認・契約書の統一・検収書・計算書・その他）に加えて、
 * 文面を足せる（例：計算書の送付＋契約書のお取り交わしのお願い、契約未締結の締結案内）。
 * 足した文面は、文書の「送る」・まとめて送る・未送付の一覧の「文面」に並ぶ。
 */

const SAMPLE: Record<string, string> = {
  相手先: "株式会社サンプル", 宛名: "山田 太郎", 文書番号: "ARC-ROY-2026-1001", 文書名: "利用許諾料計算書",
  案件番号: "MTR-2026-00012", 案件名: "イラスト制作", 金額: "¥110,000", 発行日: "2026年9月27日",
  会社名: "株式会社アークライト", 担当者名: "倉持", 対象期間: "2026年上期", 支払予定日: "2026年11月30日"
};

type Pick = { kind: MailTemplateKind } | { custom: number };

export function MailTemplatesForm({ value, onSaved }: { value: unknown; onSaved: () => void }) {
  const [draft, setDraft] = useState<MailTemplates>(DEFAULT_MAIL_TEMPLATES);
  const [pick, setPick] = useState<Pick>({ kind: "owner_check" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const [ccText, setCcText] = useState("");

  useEffect(() => {
    const v = readMailTemplates(value);
    setDraft(v); setCcText(v.partyCc.join(", "));
  }, [JSON.stringify(value)]);

  const touch = (next: MailTemplates) => { setDraft(next); setSaved(false); };
  const customAt = "custom" in pick ? draft.custom[pick.custom] ?? null : null;
  const current = "kind" in pick ? draft.templates[pick.kind] : customAt ?? { subject: "", body: "" };
  const setCurrent = (patch: Partial<{ subject: string; body: string }>) => {
    if ("kind" in pick) touch({ ...draft, templates: { ...draft.templates, [pick.kind]: { ...current, ...patch } } });
    else touch({ ...draft, custom: draft.custom.map((c, i) => (i === pick.custom ? { ...c, ...patch } : c)) });
  };
  const setCustom = (patch: Partial<CustomMailTemplate>) => {
    if (!("custom" in pick)) return;
    touch({ ...draft, custom: draft.custom.map((c, i) => (i === pick.custom ? { ...c, ...patch } : c)) });
  };

  function addCustom() {
    const key = `c${Date.now().toString(36)}`;
    const entry: CustomMailTemplate = {
      key, label: "新しい文面", hint: "", audience: "party",
      subject: "【{会社名}】{文書名}のご送付（{文書番号}）",
      body: "{相手先} 御中\n{宛名} 様\n\nいつもお世話になっております。\n{会社名}でございます。\n\n{文書名}（{文書番号}）を添付のとおりお送りいたします。\n\n今後ともどうぞよろしくお願い申し上げます。\n\n{署名}"
    };
    touch({ ...draft, custom: [...draft.custom, entry] });
    setPick({ custom: draft.custom.length });
  }
  function removeCustom() {
    if (!("custom" in pick) || !customAt) return;
    if (!window.confirm(`「${customAt.label}」を消します。送る画面の文面からも消えます。`)) return;
    touch({ ...draft, custom: draft.custom.filter((_, i) => i !== pick.custom) });
    setPick({ kind: "owner_check" });
  }

  async function save() {
    const parsed = parseMailTemplates({ ...draft, partyCc: ccText });
    if (parsed.errors.length) { setError(parsed.errors.join(" ／ ")); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/settings/${MAIL_TEMPLATES_KEY}`, { value: parsed.value });
      setSaved(true);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const sample = renderMail(current, draft.signature || "", SAMPLE);
  const meta = "kind" in pick ? MAIL_TEMPLATE_KINDS.find((k) => k.kind === pick.kind)! : null;

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
            <button key={k.kind} className="chip" aria-pressed={"kind" in pick && pick.kind === k.kind} title={k.hint}
                    onClick={() => setPick({ kind: k.kind })}>{k.label}</button>
          ))}
        </div>
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <span className="faint">足した文面：</span>
          {draft.custom.map((c, i) => (
            <button key={c.key} className="chip" aria-pressed={"custom" in pick && pick.custom === i} title={c.hint}
                    onClick={() => setPick({ custom: i })}>{c.label}</button>
          ))}
          <button className="btn btn-sm" onClick={addCustom}>＋ 文面を足す</button>
        </div>
        {meta && <div className="faint">{meta.hint}</div>}

        {customAt && (
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ minWidth: 260 }}>
              <span>名前（送る画面の「文面」に出る）</span>
              <input value={customAt.label} onChange={(e) => setCustom({ label: e.target.value })} />
            </label>
            <label className="field" style={{ minWidth: 320 }}>
              <span>説明（押したときの補足）</span>
              <input value={customAt.hint} onChange={(e) => setCustom({ hint: e.target.value })} />
            </label>
            <label className="field">
              <span>誰に</span>
              <select value={customAt.audience} onChange={(e) => setCustom({ audience: e.target.value as "party" | "owner" })}>
                <option value="party">取引先（主担当へ）</option>
                <option value="owner">社内の担当者（依頼者へ）</option>
              </select>
            </label>
            <span className="faint">鍵：<span className="code">custom:{customAt.key}</span></span>
            <button className="linky" onClick={removeCustom}>この文面を消す</button>
          </div>
        )}

        <label className="field wide">
          <span>件名</span>
          <input value={current.subject} onChange={(e) => setCurrent({ subject: e.target.value })} />
        </label>
        <label className="field wide">
          <span>本文</span>
          <textarea rows={16} value={current.body} onChange={(e) => setCurrent({ body: e.target.value })} />
        </label>
        <div className="row">
          {"kind" in pick && (
            <button className="btn" onClick={() => setCurrent(DEFAULT_MAIL_TEMPLATES.templates[pick.kind])}>
              この文面を既定に戻す
            </button>
          )}
          {customAt && DEFAULT_MAIL_TEMPLATES.custom.some((d) => d.key === customAt.key) && (
            <button className="btn" onClick={() => {
              const d = DEFAULT_MAIL_TEMPLATES.custom.find((x) => x.key === customAt.key)!;
              setCustom({ subject: d.subject, body: d.body, label: d.label, hint: d.hint, audience: d.audience });
            }}>この文面を既定に戻す</button>
          )}
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
                    onChange={(e) => touch({ ...draft, signature: e.target.value })} />
        </label>


        <label className="field wide">
          <span>取引先へのメール（内容確認・送付）にいつも cc で入れる宛先（カンマ区切り。経理など）</span>
          <input value={ccText} placeholder="keiri@example.com"
                 onChange={(e) => { setCcText(e.target.value); setSaved(false); }} />
        </label>

        <div className="faint">
          差し込める項目：{MAIL_TEMPLATE_FIELDS.map((f) => (
            <span key={f.name} title={f.label} style={{ marginRight: 8 }}><span className="code">{`{${f.name}}`}</span></span>
          ))}
          <br />値の無い項目は空になります。宛名が分からないときは「◯◯ 様」の行ごと出しません。
          担当者名は通知条項の当社担当者（無ければ送る画面で入れる）。対象期間・支払予定日は利用許諾計算書に載っている値です。
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>保存する</button>
          {saved && <span className="faint">保存しました。次に開く送る画面から使われます。</span>}
        </div>
      </div>
    </div>
  );
}
