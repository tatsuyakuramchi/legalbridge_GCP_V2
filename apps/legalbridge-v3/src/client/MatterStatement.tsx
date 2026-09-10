import { useEffect, useState } from "react";
import type { MatterDetail } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 案件の条件をまたいだ利用許諾計算書。
 *
 * 作品ひとつに取引モデルが何本もある（自社製造・自社販売、再許諾…）とき、
 * 相手先に出す計算書は1枚で、中は取引モデルごとの内訳になる。条件ごとに
 * 1枚ずつ出すのは実務と合わない（V1・V2 も1枚に束ねていた）。
 *
 * 計算は条件ごと。料率も MG・AG も条件ごとに違うので、合算してから
 * 1回計算すると数字が合わない。束ねるのは印字と支払のまとめ方だけ。
 */

interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  quantity: number | null; grossAmount: number | null; amount: number;
  status: string; documentId: number | null; note: string | null;
}
interface Line {
  conditionId: number | null; contractTitle: string; contractNumber: string;
  conditionName: string; methodLabel: string;
  salesJpy: number; ratePct: number; paymentJpy: number; basisNote: string;
}
interface Totals {
  currency: string; basis: number; netExTax: number; tax: number; totalIncTax: number;
  withholdingTax: number; netTransfer: number; netMinor: number;
}
interface TemplateOption { templateKey: string; label: string; category: string | null }
interface TypeOption { value: string; label: string }

/** 束ねの金額はサーバが主単位（円）で返す。最小通貨単位の money() と混ぜない。 */
const major = (value: number, currency: string) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency }).format(value);

export function MatterStatement(
  { detail, onChanged, onOpenDocument }: {
    detail: MatterDetail;
    onChanged: () => void;
    onOpenDocument?: (documentId: number) => void;
  }
) {
  // 計算書を出せるのは料率・単価×数量の条件だけ。定額は計算書ではなく請求。
  const targets = detail.conditions.filter(
    (c) => c.pricingModel === "revenue_rate" || c.pricingModel === "unit_rate");

  // 読み取り専用モード（バックアップ機として動かしているとき）は作らせない。
  const editable = !useReadOnly();
  const [open, setOpen] = useState(false);
  const [eventsBy, setEventsBy] = useState<Record<number, EventRow[]>>({});
  const [typeLabel, setTypeLabel] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<number, number[]>>({});
  const [period, setPeriod] = useState("");
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [result, setResult] = useState<{ lines: Line[]; totals: Totals } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: number; documentNo: string | null } | null>(null);

  // 選べる実績は「有効で、まだどの文書にも結ばれていないもの」。
  const freeEvents = (conditionId: number) =>
    (eventsBy[conditionId] ?? []).filter((e) => e.status === "active" && !e.documentId);

  const entries = targets
    .map((c) => ({ conditionId: c.id, eventIds: picked[c.id] ?? [] }))
    .filter((e) => e.eventIds.length > 0);
  const entriesKey = entries.map((e) => `${e.conditionId}:${e.eventIds.join("-")}`).join(",");

  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.all(targets.map((c) =>
      api.get<{ events: EventRow[]; types: TypeOption[] }>(`/conditions/${c.id}/events`)
        .then((r) => [c.id, r] as const)
        .catch(() => [c.id, { events: [] as EventRow[], types: [] as TypeOption[] }] as const)))
      .then((pairs) => {
        setEventsBy(Object.fromEntries(pairs.map(([id, r]) => [id, r.events])));
        setTypeLabel(Object.fromEntries(
          pairs.flatMap(([, r]) => r.types).map((t) => [t.value, t.label])));
      });
    if (!templates.length) {
      api.get<{ templates: TemplateOption[] }>("/document-templates")
        .then((r) => {
          setTemplates(r.templates);
          setTemplateKey(r.templates.find((t) => t.templateKey === "royalty_statement")?.templateKey
            ?? r.templates[0]?.templateKey ?? "");
        })
        .catch((e: ApiError) => setError(e.message));
    }
  }, [open, detail.id]);

  // 選び直したら試算し直す。保存しない。
  useEffect(() => {
    if (!open || !entries.length) { setResult(null); return; }
    let live = true;
    api.post<{ lines: Line[]; totals: Totals }>("/statement-documents/preview", {
      entries: entries.map((e) => ({ ...e, period: period.trim() || null }))
    })
      .then((r) => { if (live) { setResult(r); setError(null); } })
      .catch((e: ApiError) => { if (live) { setResult(null); setError(e.message); } });
    return () => { live = false; };
  }, [open, entriesKey, period]);

  function toggle(conditionId: number, eventId: number) {
    setPicked((p) => {
      const current = p[conditionId] ?? [];
      return {
        ...p,
        [conditionId]: current.includes(eventId)
          ? current.filter((id) => id !== eventId)
          : [...current, eventId]
      };
    });
  }

  async function issue() {
    if (!templateKey || !entries.length) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { id: number; documentNo: string | null } }>(
        "/statement-documents", {
          templateKey, matterId: detail.id,
          entries: entries.map((e) => ({ ...e, period: period.trim() || null }))
        });
      setDone(r.document);
      setOpen(false); setPicked({}); setResult(null);
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!targets.length) return null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>実績から計算書を作る</h2>
        <span className="faint">
          取引モデルが何本あっても、相手先に出すのは1枚。中は取引モデルごとの内訳になります
        </span>
        {!open && editable && (
          <button className="btn btn-sm primary" style={{ marginLeft: "auto" }}
                  onClick={() => { setOpen(true); setDone(null); }}>
            計算書を作る
          </button>
        )}
      </div>

      {done && (
        <div className="panel-bd">
          <div className="done-note">
            計算書 <span className="code">{done.documentNo ?? `#${done.id}`}</span> を作りました。
            <span className="row">
              {onOpenDocument && (
                <button className="btn btn-sm primary" onClick={() => onOpenDocument(done.id)}>
                  文書を開く
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setDone(null)}>閉じる</button>
            </span>
          </div>
        </div>
      )}

      {open && (
        <div className="panel-bd stack">
          {error && <div className="alert">{error}</div>}

          <div className="row">
            <label className="field">
              <span>対象期間</span>
              <input value={period} onChange={(e) => setPeriod(e.target.value)}
                     placeholder="2026上期（空なら実績の期間から決める）" />
            </label>
            <label className="field">
              <span>ひな形</span>
              <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.templateKey} value={t.templateKey}>{t.label}</option>
                ))}
              </select>
            </label>
          </div>

          {targets.map((c) => {
            const rows = freeEvents(c.id);
            return (
              <div key={c.id} className="stack" style={{ gap: 4 }}>
                <div className="row">
                  <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                  <b>{c.name}</b>
                  <span className="tag">
                    {c.pricingModel === "unit_rate" ? "単価×数量" : "料率"}
                  </span>
                </div>
                {rows.length ? (
                  <div className="picker">
                    {rows.map((e) => (
                      <label key={e.id} className="row">
                        <input type="checkbox"
                               checked={(picked[c.id] ?? []).includes(e.id)}
                               onChange={() => toggle(c.id, e.id)} />
                        <span className="code">{e.occurredOn ?? "—"}</span>
                        <span>{typeLabel[e.eventType] ?? e.eventType}</span>
                        <span className="faint">
                          {e.period ?? ""}
                          {e.quantity !== null ? `　数量 ${e.quantity}` : ""}
                          {e.grossAmount !== null ? `　報告 ${e.grossAmount.toLocaleString()}` : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className="faint">
                    まだ結べる実績がありません。条件の実績に売上・製造の記録を入れてください
                  </span>
                )}
              </div>
            );
          })}

          {result && (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>取引モデル</th><th>算定方法</th><th className="num">根拠額</th>
                      <th className="num">料率</th><th className="num">実額（税抜）</th><th>但し書き</th></tr>
                </thead>
                <tbody>
                  {result.lines.map((l, i) => (
                    <tr key={l.conditionId ?? i}>
                      <td>{l.conditionName}</td>
                      <td>{l.methodLabel}</td>
                      <td className="num">{major(l.salesJpy, result.totals.currency)}</td>
                      <td className="num">{l.ratePct ? `${l.ratePct}%` : "—"}</td>
                      <td className="num">{major(l.paymentJpy, result.totals.currency)}</td>
                      <td className="faint">{l.basisNote}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4}><b>合計（税抜）</b></td>
                    <td className="num"><b>{major(result.totals.netExTax, result.totals.currency)}</b></td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={4}>消費税</td>
                    <td className="num">{major(result.totals.tax, result.totals.currency)}</td>
                    <td className="faint">条件ごとの税区分で計算します</td>
                  </tr>
                  <tr>
                    <td colSpan={4}><b>合計（税込）</b></td>
                    <td className="num"><b>{major(result.totals.totalIncTax, result.totals.currency)}</b></td>
                    <td className="faint">
                      {result.totals.withholdingTax > 0
                        ? `源泉 ${major(result.totals.withholdingTax, result.totals.currency)} を引いた振込額 ${major(result.totals.netTransfer, result.totals.currency)}`
                        : ""}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="row">
            <button className="btn primary" disabled={busy || !result || !templateKey}
                    onClick={() => void issue()}>
              {busy ? "作成中…" : "この内容で計算書を作る"}
            </button>
            <button className="btn" disabled={busy}
                    onClick={() => { setOpen(false); setPicked({}); setResult(null); }}>やめる</button>
            {!entries.length && <span className="faint">実績を1件以上選んでください</span>}
          </div>
        </div>
      )}
    </div>
  );
}
