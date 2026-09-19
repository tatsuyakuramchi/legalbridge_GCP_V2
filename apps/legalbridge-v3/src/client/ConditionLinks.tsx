import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";
import { ListSearch, useDebounced } from "./ListTools.js";

/**
 * 条件の相手先と権利の範囲。
 *
 * どちらも本体とは別の操作にしてある。相手先の付け替えは参照の付け替えで、
 * 範囲の差し替えは行の入れ替えなので、金額の改訂とは意味が違う。
 * まとめて1つの保存にすると、片方だけ直したいときに全部を触ることになる。
 */

const SCOPE_TYPES = [
  { value: "region", label: "地域" },
  { value: "language", label: "言語" },
  { value: "media", label: "媒体" },
  { value: "channel", label: "チャネル" }
] as const;

type ScopeType = (typeof SCOPE_TYPES)[number]["value"];

export function ConditionCounterparty(
  { detail, onDone }: { detail: ConditionDetail; onDone: () => void }
) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [parties, setParties] = useState<Array<{ id: number; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    api.get<{ parties: Array<{ id: number; name: string }> }>(
      `/parties${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setParties(r.parties.slice(0, 30))).catch(() => setParties([]));
  }, [open, search]);

  async function assign(partyId: number) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/conditions/${detail.id}/counterparty`, { partyId });
      setOpen(false); setKeyword(""); onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>相手先</h2>
        <span className="faint">{detail.counterparty?.name ?? "未設定"}</span>
        {!open && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => setOpen(true)}>付け替える</button>
        )}
      </div>
      {open && (
        <div className="panel-bd stack">
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="名称・カナ・別名" label="付け替える相手先を探す" />
            <button className="btn btn-sm" onClick={() => { setOpen(false); setKeyword(""); }}>やめる</button>
          </div>
          {error && <div className="alert">{error}</div>}
          <div className="picker">
            {parties.map((p) => (
              <button key={p.id} className="btn btn-sm" disabled={busy || p.id === detail.counterparty?.id}
                      style={{ textAlign: "left" }} onClick={() => void assign(p.id)}>
                {p.name}{p.id === detail.counterparty?.id ? "（いまの相手先）" : ""}
              </button>
            ))}
            {!parties.length && <span className="faint">見つかりません</span>}
          </div>
          <p className="faint" style={{ margin: 0 }}>
            付け替えても、この条件を出した文書や過去の支払は書き換わりません。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 条件の案件。
 *
 * 案件が全体の入口なのに、繋ぐ操作は案件の画面にしか無かった。条件を作った
 * 直後に付けられず、あとで案件を開いて条件を探し直すことになっていた。
 * ここから既存の案件に付けるか、この条件から新しく作れる。
 *
 * 参照の向きは変えていない（案件 → 条件）。外しても条件は消えない。
 */
export function ConditionMatters(
  { detail, onDone }: { detail: ConditionDetail; onDone: () => void }
) {
  const [mode, setMode] = useState<"closed" | "find" | "create">("closed");
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [matters, setMatters] = useState<Array<{ id: number; matterNo: string | null; title: string; kind: string; status: string }>>([]);
  const [title, setTitle] = useState("");
  const [withDocuments, setWithDocuments] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== "find") return;
    const q = search.trim();
    api.get<{ matters: Array<{ id: number; matterNo: string | null; title: string; kind: string; status: string }> }>(
      `/matters${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setMatters(r.matters.slice(0, 30))).catch(() => setMatters([]));
  }, [mode, search]);

  // 案件が無い文書。付けるときに何件が一緒に動くかを先に出す。
  const loose = detail.documents.filter((d) => d.status !== "void" && d.matterId === null).length;

  async function link(body: { matterId?: number; title?: string }) {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await api.post<{ matterNo: string | null; created: boolean; documents: number }>(
        `/conditions/${detail.id}/matters`, { ...body, withDocuments });
      setNote(`${r.created ? "案件を作って繋ぎました" : "案件に繋ぎました"}：` +
              `${r.matterNo ?? "（番号なし）"}` +
              (r.documents ? `／文書 ${r.documents} 件も一緒に付けました` : ""));
      setMode("closed"); setKeyword(""); setTitle("");
      onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(matterId: number, label: string) {
    if (!window.confirm(`${label} から外します。条件も文書も消えません。`)) return;
    setBusy(true); setError(null); setNote(null);
    try {
      await api.del(`/conditions/${detail.id}/matters/${matterId}`);
      onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>案件</h2>
        <span className="faint">
          {detail.matters.length ? `${detail.matters.length} 件` : "付いていません"}
        </span>
        {mode === "closed" && (
          <span className="row" style={{ marginLeft: "auto" }}>
            <button className="btn btn-sm" onClick={() => setMode("find")}>既存に付ける</button>
            <button className="btn btn-sm"
                    onClick={() => { setTitle(detail.name); setMode("create"); }}>
              この条件から作る
            </button>
          </span>
        )}
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className="note ok">{note}</div>}

        {detail.matters.length ? (
          <div className="picker">
            {detail.matters.map((m) => (
              <div key={m.id} className="pick">
                <span className="code">{m.matterNo ?? `#${m.id}`}</span>
                <span>{m.title}</span>
                <span className="faint">{matterKindLabel(m.kind)}／{m.status}</span>
                <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy}
                        onClick={() => void detach(m.id, m.matterNo ?? `#${m.id}`)}>外す</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>
            この条件はどの案件にも付いていません。案件に付けると、進み具合・期日・
            文書がひとつの画面にまとまります。
          </p>
        )}

        {mode !== "closed" && loose > 0 && (
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={withDocuments}
                   onChange={(e) => setWithDocuments(e.target.checked)} />
            <span>この条件から出した文書 {loose} 件も一緒に付ける</span>
          </label>
        )}

        {mode === "find" && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <ListSearch value={keyword} onChange={setKeyword}
                placeholder="案件番号・件名" label="付ける案件を探す" />
              <button className="btn btn-sm" onClick={() => { setMode("closed"); setKeyword(""); }}>
                やめる
              </button>
            </div>
            <div className="picker">
              {matters.map((m) => (
                <button key={m.id} className="btn btn-sm" style={{ textAlign: "left" }}
                        disabled={busy || detail.matters.some((x) => x.id === m.id)}
                        onClick={() => void link({ matterId: m.id })}>
                  <span className="code">{m.matterNo ?? `#${m.id}`}</span> {m.title}
                  <span className="faint"> {matterKindLabel(m.kind)}</span>
                </button>
              ))}
              {!matters.length && <span className="faint">見つかりません</span>}
            </div>
          </div>
        )}

        {mode === "create" && (
          <div className="stack" style={{ gap: 6 }}>
            <label className="field">
              <span>案件名</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                     placeholder={detail.name} />
            </label>
            <p className="faint" style={{ margin: 0 }}>
              取引モデルは条件の種類（{detail.kind}）から決まります。相手先
              {detail.counterparty ? `（${detail.counterparty.name}）` : ""}も引き継ぎます。
            </p>
            <div className="row">
              <button className="btn primary btn-sm" disabled={busy}
                      onClick={() => void link({ title: title.trim() || detail.name })}>
                作って繋ぐ
              </button>
              <button className="btn btn-sm" onClick={() => setMode("closed")}>やめる</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const matterKindLabel = (kind: string) =>
  ({ work: "ライセンス", outsourcing: "業務委託", single: "文書作成" })[kind] ?? kind;

export function ConditionScopes(
  { detail, onDone }: { detail: ConditionDetail; onDone: () => void }
) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState(detail.scopes.map((s) => ({
    scopeType: s.scopeType as ScopeType, label: s.label, code: s.code ?? ""
  })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function start() {
    setRows(detail.scopes.map((s) => ({
      scopeType: s.scopeType as ScopeType, label: s.label, code: s.code ?? ""
    })));
    setEditing(true); setError(null);
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.put(`/conditions/${detail.id}/scopes`, {
        scopes: rows
          .filter((r) => r.label.trim())
          .map((r) => ({ scopeType: r.scopeType, label: r.label.trim(), code: r.code.trim() || null }))
      });
      setEditing(false); onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>権利の範囲</h2>
        <span className="faint">地域・言語・媒体・チャネル</span>
        {!editing && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={start}>範囲を編集</button>
        )}
      </div>

      {!editing ? (
        <div className="panel-bd">
          {detail.scopes.length ? (
            <div className="chips">
              {detail.scopes.map((s) => (
                <span key={`${s.scopeType}-${s.label}`} className="tag">
                  {SCOPE_TYPES.find((t) => t.value === s.scopeType)?.label ?? s.scopeType}：{s.label}
                </span>
              ))}
            </div>
          ) : (
            <div className="faint">
              範囲の指定がありません。無制限として扱われるので、限定するなら足してください。
            </div>
          )}
        </div>
      ) : (
        <div className="panel-bd stack">
          {rows.map((row, i) => (
            <div className="row" key={i}>
              <select value={row.scopeType}
                onChange={(e) => setRows(rows.map((r, j) =>
                  j === i ? { ...r, scopeType: e.target.value as ScopeType } : r))}>
                {SCOPE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <input className="inline-input" style={{ width: 200 }} value={row.label}
                placeholder="日本 / 日本語 / 電子書籍"
                aria-label={`${i + 1} 行目の内容`}
                onChange={(e) => setRows(rows.map((r, j) =>
                  j === i ? { ...r, label: e.target.value } : r))} />
              <input className="inline-input" style={{ width: 90 }} value={row.code}
                placeholder="JP" aria-label={`${i + 1} 行目のコード`}
                onChange={(e) => setRows(rows.map((r, j) =>
                  j === i ? { ...r, code: e.target.value } : r))} />
              <button className="btn btn-sm"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}>外す</button>
            </div>
          ))}
          <div className="row">
            <button className="btn btn-sm"
              onClick={() => setRows([...rows, { scopeType: "region", label: "", code: "" }])}>
              行を足す
            </button>
          </div>
          {error && <div className="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? "保存中…" : "保存する"}
            </button>
            <button className="btn" disabled={busy} onClick={() => setEditing(false)}>やめる</button>
            <span className="faint">
              いまの範囲をすべて置き換えます。空欄の行は保存されません
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
