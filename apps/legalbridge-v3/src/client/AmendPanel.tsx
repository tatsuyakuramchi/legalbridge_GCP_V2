import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 管理者が記録を直す欄（A-041）。
 *
 * 支払と実績は自動で立つ（文書・計算書から）ので、間違いに気づいたときの
 * 直し方は「取り消してもう一度」しかなかった。日付を1日ずらす・数量を
 * 打ち直す、のたびに番号を捨てるのは重いし、繋がっている文書があると
 * 取り消せず手が無くなる。
 *
 * 直せるのは中身だけで、必ず理由を書かせ、前後の値と一緒に監査に残す。
 * 同じ画面でその履歴も読めるようにする（残したものを読めなければ、
 * 残している意味がない）。
 */

export interface AmendField {
  name: string;
  label: string;
  type?: "text" | "date" | "number" | "textarea";
  /** いまの値。空は空欄で出す。 */
  value: string;
  hint?: string;
}

interface AuditRow {
  id: number;
  occurredAt: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "（空）" : String(v));

/**
 * 監査に残した before / after を「欄：前 → 後」の形で読む。
 *
 * 監査に入っているのは欄の名前（英語のキー）なので、画面に出すときは
 * 入力欄と同じ日本語に直す。直した本人以外が読むところなので、
 * ここで key のまま出すと何を直したのか伝わらない。
 */
function diffLines(detail: Record<string, unknown>, labels: Record<string, string>): string[] {
  const before = (detail.before ?? {}) as Record<string, unknown>;
  const after = (detail.after ?? {}) as Record<string, unknown>;
  return Object.keys(after).map(
    (key) => `${labels[key] ?? key}：${show(before[key])} → ${show(after[key])}`);
}

export function AmendPanel(
  { title, path, fields, targetType, targetId, actionPrefix, detailMatch, note, onDone, onCancel }: {
    title: string;
    /** PATCH の宛先。 */
    path: string;
    fields: AmendField[];
    /** 履歴を引く先。監査の target_type と target_id。 */
    targetType: string;
    targetId: number;
    /** 履歴のうちこの操作だけを出す（payment.amend など）。 */
    actionPrefix: string;
    /**
     * 履歴をさらに絞る条件。監査の宛先が親（条件）で、直した先が子（実績）の
     * ときに使う。detail のこの欄がこの値の行だけを出す。
     */
    detailMatch?: { key: string; value: number };
    /** 欄の上に出す注意書き。 */
    note?: string;
    /** 直した欄（画面に出す日本語の名前）。保存できたときだけ呼ぶ。 */
    onDone: (changedLabels: string[]) => void;
    onCancel: () => void;
  }
) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AuditRow[]>([]);
  const [version, setVersion] = useState(0);

  const labels = Object.fromEntries(fields.map((f) => [f.name, f.label]));
  const matchKey = detailMatch?.key ?? "";
  const matchValue = detailMatch?.value ?? 0;
  useEffect(() => {
    const params = new URLSearchParams({ targetType, targetId: String(targetId), action: actionPrefix });
    api.get<{ events: AuditRow[] }>(`/audit-events?${params}`)
      .then((r) => setHistory(r.events.filter((e) => {
        // 監査の宛先が親のときは、detail の欄で直した先まで絞る。
        if (!matchKey) return true;
        return Number((e.detail as Record<string, unknown>)[matchKey]) === matchValue;
      })))
      .catch(() => setHistory([]));
  }, [targetType, targetId, actionPrefix, matchKey, matchValue, version]);

  /** 直した欄だけ送る。触っていない欄は送らない（意図しない上書きを防ぐ）。 */
  async function save() {
    setBusy(true); setError(null);
    try {
      const patch: Record<string, unknown> = { reason: reason.trim() };
      for (const f of fields) {
        const next = values[f.name] ?? "";
        if (next === f.value) continue;
        patch[f.name] = next.trim() === "" ? null : next.trim();
      }
      if (Object.keys(patch).length <= 1) {
        setError("直した欄がありません"); setBusy(false); return;
      }
      const r = await api.patch<{ changed: string[] }>(path, patch);
      setVersion((v) => v + 1);
      onDone((r.changed ?? []).map((k) => labels[k] ?? k));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel fsec" style={{ marginBottom: 10 }}>
      <div className="panel-hd">
        <h2>{title}</h2>
        <span className="faint">管理者だけ。理由と前後の値を監査に残します</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        {note && <div className="note">{note}</div>}
        {error && <div className="alert">{error}</div>}
        <div className="form-grid">
          {fields.map((f) => (
            <label key={f.name} className="field">
              <span>{f.label}</span>
              {f.type === "textarea"
                ? <textarea rows={2} value={values[f.name] ?? ""}
                            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                : <input type={f.type === "date" ? "date" : "text"}
                         inputMode={f.type === "number" ? "numeric" : undefined}
                         value={values[f.name] ?? ""}
                         onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
              {/* 補足は欄の幅いっぱいに出す。.field は 110px ＋ 入力欄の2列なので、
                  そのままだと左の 110px に落ちて1文字ずつ折り返す。 */}
              {f.hint && <small className="faint" style={{ gridColumn: "1 / -1" }}>{f.hint}</small>}
            </label>
          ))}
        </div>
        <label className="field">
          <span>修正の理由<em className="req"> 必須</em></span>
          <input value={reason} placeholder="先方の納品書と突き合わせた／請求書の金額に合わせた"
                 onChange={(e) => setReason(e.target.value)} />
          <small className="faint" style={{ gridColumn: "1 / -1" }}>
            あとから読む人が「なぜ直したか」を辿れるようにします
          </small>
        </label>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" disabled={busy || !reason.trim()} onClick={() => void save()}>
            直して記録する
          </button>
          <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
        </div>

        <div className="stack" style={{ gap: 4 }}>
          <b className="faint">修正履歴</b>
          {history.length === 0 && <span className="faint">まだありません</span>}
          {history.map((h) => (
            <div key={h.id} className="faint" style={{ fontSize: 12 }}>
              <span className="code">{h.occurredAt.slice(0, 16).replace("T", " ")}</span>
              {"　"}{h.actor}
              {"　"}{String((h.detail as { reason?: unknown }).reason ?? "")}
              {diffLines(h.detail, labels).map((line) => (
                <div key={line} style={{ marginLeft: "1.2em" }}>{line}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
