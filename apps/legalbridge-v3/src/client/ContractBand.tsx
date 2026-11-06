import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { SignSwitch } from "./SignState.js";
import { useMapLinks } from "./mapLinks.js";
import type { ContractRow, ContractStep } from "../server/matters/contract-band.js";

/**
 * マップの「契約のみ（条件なし）」の帯（server/matters/contract-band.ts）。
 *
 * IN／OUT の帯の下に置く。行は契約 1 本（基本契約・NDA・覚書・番号だけ取った文書）、
 * 列は 取引先 → 基本契約 → 契約書・番号 → 種類・件名 → 送付 → 締結 → 期限。止まりは前の段から 1 つだけ赤。
 *   - 番号だけ取る：種類（取り込みの種別か、ひな形＝全ジャンル）と件名で番号を取る。
 *     ファイル（PDF）を取り込み、締結を記録するまで止まりのまま（記録を求める）。
 *   - 選んだ行は「案件に入れる」で案件に寄せられる（マップの帯の上の帯から）。
 */

interface ReserveKinds {
  kinds: Array<{ kind: string; prefix: string }>;
  templates: Array<{ key: string; label: string; prefix: string | null }>;
}

const STEP_CLASS: Record<ContractStep["state"], string> = { ok: "tag ok", stop: "tag out", wait: "tag warn", none: "faint" };

export function ContractBand({ scope, filter, reloadKey, cols, onOpenDocument, canWrite, picked, onPick }: {
  scope: { matterId: number } | { partyId: number } | { workId: number };
  /** 作業台で契約を選んだとき：その契約（と補助文書）の行だけ／どの契約にも入らない行だけ。 */
  filter?: { only: number[] } | { exclude: number[] } | null;
  reloadKey?: number;
  /** 上の表と同じ列の数（見出しの帯を横いっぱいにする）。 */
  cols: number;
  onOpenDocument?: (id: number) => void;
  canWrite: boolean;
  /** 選んでいる行（"document:12" / "agreement:108"）。案件に入れるのは上の帯で。 */
  picked: Set<string>;
  onPick: (key: string, on: boolean) => void;
}) {
  const links = useMapLinks();
  const [rows, setRows] = useState<ContractRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [signing, setSigning] = useState<ContractRow | null>(null);
  const [reserving, setReserving] = useState(false);

  const path = "matterId" in scope ? `/matters/${scope.matterId}/contracts`
    : "partyId" in scope ? `/parties/${scope.partyId}/contracts` : `/works/${scope.workId}/contracts`;
  useEffect(() => {
    setError(null);
    api.get<{ rows: ContractRow[] }>(path).then((r) => setRows(r.rows)).catch((e: ApiError) => { setError(e.message); setRows([]); });
  }, [path, reloadKey, version]);

  const shown = useMemo(() => (rows ?? []).filter((r) => {
    if (!filter) return true;
    const ids = [r.agreementId, r.contract?.id].filter((x): x is number => x != null);
    if ("only" in filter) return ids.some((id) => filter.only.includes(id));
    return !ids.some((id) => filter.exclude.includes(id));
  }), [rows, filter]);
  const reload = (message?: string) => { if (message) setNotice(message); setVersion((v) => v + 1); };

  // 番号を取る先：案件の切り口ならその案件、契約を選んでいればその契約（相手先はそこから決まる）。
  const matterId = "matterId" in scope ? scope.matterId : null;
  const agreementId = filter && "only" in filter && filter.only.length ? filter.only[0]! : null;
  const canReserve = canWrite && (matterId !== null || agreementId !== null);

  if (rows === null) return null;
  const stuck = shown.filter((r) => r.stuck).length;

  return (
    <>
      <tr className="ledger-sec band">
        <td colSpan={cols}>
          <b>契約のみ</b><span>条件の無い契約・番号だけ取った文書</span>
          <span className="faint">{shown.length} 件{stuck ? `・止まり ${stuck}` : ""}</span>
          {canReserve && (
            <button className="btn btn-sm band-btn" onClick={() => setReserving((v) => !v)}>{reserving ? "閉じる" : "＋ 番号だけ取る"}</button>
          )}
          {canWrite && !canReserve && <span className="faint">（案件か契約を選ぶと番号だけ取れます）</span>}
        </td>
      </tr>
      {(error || notice) && (
        <tr><td colSpan={cols}>{error ? <div className="alert">{error}</div> : <div className="note ok">{notice}</div>}</td></tr>
      )}
      {reserving && (
        <tr><td colSpan={cols}>
          <ReserveForm matterId={matterId} agreementId={agreementId}
            onDone={(no) => { setReserving(false); reload(`${no} を取りました。PDF を取り込み、締結を記録すると済みになります`); }} />
        </td></tr>
      )}
      {shown.length > 0 && (
        <tr className="ledger-colhead">
          <th style={{ width: 28 }} />
          {cols === 8 && <th className="stage-hd">取引先</th>}
          <th className="stage-hd">基本契約<span className="stage-sub">基本契約・単体契約</span></th>
          <th className="stage-hd">契約書・番号<span className="stage-sub">文書・番号だけ・契約の記録</span></th>
          <th className="stage-hd">種類・件名</th>
          <th className="stage-hd">送付</th>
          <th className="stage-hd">締結<span className="stage-sub">CloudSign・手で記録</span></th>
          <th className="stage-hd">期限<span className="stage-sub">満了・更新</span></th>
        </tr>
      )}
      {shown.length === 0 && (
        <tr><td colSpan={cols} className="faint">条件の無い契約はありません。</td></tr>
      )}
      {shown.map((r) => (
        <tr key={r.key} className={picked.has(r.key) ? "sel" : undefined}>
          <td><input type="checkbox" checked={picked.has(r.key)} aria-label={`${r.number ?? r.key} を選ぶ`}
                     onChange={(e) => onPick(r.key, e.target.checked)} /></td>
          {cols === 8 && <td>{r.party ? <b>{r.party.name}</b> : <span className="faint">（会社全体）</span>}</td>}
          <td className="ledger-plain">
            {r.contract
              ? <div className="ledger-line">
                  {links.agreement
                    ? <button className="linky code" onClick={() => links.agreement!(r.contract!.id)}>{r.contract.agreementNo ?? `#${r.contract.id}`}</button>
                    : <span className="code">{r.contract.agreementNo}</span>}
                  <span className="tag">{r.contract.kind === "standalone" ? "単体契約" : "基本契約"}</span>
                </div>
              : <span className="faint">—</span>}
          </td>
          <td className="ledger-plain">
            <div className="ledger-line">
              {r.source === "document" && onOpenDocument
                ? <button className="linky code" onClick={() => onOpenDocument(r.id)}>{r.number ?? `#${r.id}`}</button>
                : r.source === "agreement" && links.agreement
                ? <button className="linky code" onClick={() => links.agreement!(r.id)}>{r.number ?? `#${r.id}`}</button>
                : <span className="code">{r.number}</span>}
              {r.numberOnly && <span className="tag warn">発番のみ</span>}
            </div>
            <Step step={r.steps.document} />
            {r.stuck === "document" && canWrite && r.numberOnly && <FileImport documentId={r.id} onDone={() => reload(`${r.number ?? ""} に PDF を取り込みました`)} />}
            {r.stuck === "document" && !r.numberOnly && onOpenDocument && (
              <button className="btn btn-sm ledger-next" onClick={() => onOpenDocument(r.id)}>→ 開いて決定する</button>
            )}
          </td>
          <td><b style={{ fontSize: 12.5 }}>{r.title ?? "—"}</b><div className="faint" style={{ fontSize: 11.5 }}>{r.kindLabel}</div></td>
          <td>
            <Step step={r.steps.send} />
            {r.stuck === "send" && onOpenDocument && <button className="btn btn-sm ledger-next" onClick={() => onOpenDocument(r.id)}>→ 送る</button>}
          </td>
          <td>
            <Step step={r.steps.sign} />
            {canWrite && r.source === "document" && r.steps.sign.state !== "ok" && r.stuck !== "document" && (
              <button className="btn btn-sm ledger-next" onClick={() => setSigning(r)}>締結を記録</button>
            )}
            {canWrite && r.source === "agreement" && r.steps.sign.state !== "ok" && links.agreement && (
              <button className="btn btn-sm ledger-next" onClick={() => links.agreement!(r.id)}>→ 契約で締結日を入れる</button>
            )}
            {signing?.key === r.key && (
              <SignSwitch documentId={r.id} documentNo={r.number} current={r.sign}
                onDone={(m) => { setSigning(null); reload(m); }} onClose={() => setSigning(null)} />
            )}
          </td>
          <td><Step step={r.steps.term} /></td>
        </tr>
      ))}
    </>
  );
}

function Step({ step }: { step: ContractStep }) {
  return (
    <div className="ledger-line" style={{ flexWrap: "wrap" }}>
      {step.state === "none" ? <span className="faint">{step.label}</span> : <span className={STEP_CLASS[step.state]}>{step.label}</span>}
      {step.sub && <span className="faint" style={{ fontSize: 11.5 }}>{step.sub}</span>}
    </div>
  );
}

/** 番号だけ取った文書に PDF を取り込む（POST /documents/:id/import-file）。 */
function FileImport({ documentId, onDone }: { documentId: number; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await api.postRaw(`/documents/${documentId}/import-file?filename=${encodeURIComponent(file.name)}`, file, file.type || "application/pdf");
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); if (ref.current) ref.current.value = ""; }
  }
  return (
    <>
      <input ref={ref} type="file" accept="application/pdf,image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button className="btn btn-sm ledger-next" disabled={busy} onClick={() => ref.current?.click()}>{busy ? "取り込み中…" : "PDF を取り込む"}</button>
      {error && <div className="alert">{error}</div>}
    </>
  );
}

/** 番号だけ取る：種類（取り込みの種別・ひな形＝全ジャンル）と件名。 */
function ReserveForm({ matterId, agreementId, onDone }: { matterId: number | null; agreementId: number | null; onDone: (documentNo: string) => void }) {
  const [kinds, setKinds] = useState<ReserveKinds | null>(null);
  const [choice, setChoice] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<ReserveKinds>("/documents/reserve-kinds").then(setKinds).catch(() => setKinds({ kinds: [], templates: [] })); }, []);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const [type, value] = choice.split(":", 2) as [string, string];
      const r = await api.post<{ documentNo: string }>("/documents/reserve", {
        title: title.trim(),
        ...(type === "t" ? { templateKey: value } : { documentKind: value }),
        matterId, agreementId
      });
      onDone(r.documentNo);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="band-form">
      <label className="field"><span>種類</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">選ぶ</option>
          {kinds && kinds.kinds.length > 0 && (
            <optgroup label="外で作る文書（取り込みの種別）">
              {kinds.kinds.map((k) => <option key={k.kind} value={`k:${k.kind}`}>{k.kind}（{k.prefix}）</option>)}
            </optgroup>
          )}
          {kinds && kinds.templates.length > 0 && (
            <optgroup label="ひな形の番号で取る">
              {kinds.templates.map((t) => <option key={t.key} value={`t:${t.key}`}>{t.label}{t.prefix ? `（${t.prefix}）` : ""}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <label className="field" style={{ flex: "1 1 260px" }}><span>件名</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：秘密保持契約（ノースライト企画）"
               onKeyDown={(e) => { if (e.key === "Enter" && choice && title.trim()) void submit(); }} />
      </label>
      <button className="btn btn-sm primary" disabled={busy || !choice || !title.trim()} onClick={submit}>{busy ? "取っています…" : "番号を取る"}</button>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
