import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import type { LedgerView, Round } from "../server/royalty/ledger-service.js";

/**
 * 許諾料の回を選ぶ（依頼 → 作家・作品 → 回）。A-060
 *
 * 依頼を台帳のどの回の分かは自動では決めない。作家・作品（台帳）を選び、
 * その台帳の回から選ぶ。作家・作品の候補は依頼に繋いだ条件から出し、
 * 無ければ作家を名前で探して作品を選ぶ。
 */

export const roundTitle = (r: Round) => r.kind === "event"
  ? `${r.closeOn ?? ""} 製造`
  : r.key.startsWith("x:") ? `${r.closeOn ?? ""} 予定の外`
  : `${r.payOn ? `${Number(r.payOn.slice(5, 7))}/${Number(r.payOn.slice(8, 10))}` : r.closeOn ?? ""} 支払の回`;

/** 回を指すもの。時限式は予定明細の行、イベント式（と予定の外）は実績。 */
export const roundTargets = (r: Round) => ({
  scheduleIds: r.parts.map((p) => p.scheduleId).filter((x): x is number => !!x),
  eventIds: r.parts.filter((p) => !p.scheduleId && p.eventId).map((p) => p.eventId!)
});

export function RoundPicker(
  { ledgers, onPick, busy }: {
    /** 候補の作家・作品。依頼に繋いだ条件から。 */
    ledgers: Array<{ partyId: number; partyName: string; workId: number; workTitle: string }>;
    onPick: (round: Round) => void;
    busy?: boolean;
  }
) {
  const [pair, setPair] = useState<string>(ledgers[0] ? `${ledgers[0].partyId}:${ledgers[0].workId}` : "search");
  const [partyId, setPartyId] = useState<string>("");
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [view, setView] = useState<LedgerView | null>(null);
  const [roundKey, setRoundKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 別の作家を探したとき：作家の全作品を引いて、作品を選ばせる。
  useEffect(() => {
    if (!partyId) { setWorks([]); return; }
    api.get<LedgerView>(`/royalty-ledger?partyId=${partyId}`)
      .then((v) => { setWorks(v.works); if (v.works.length === 1) setPair(`${partyId}:${v.works[0].id}`); })
      .catch((e: ApiError) => setError(e.message));
  }, [partyId]);
  useEffect(() => {
    setView(null); setRoundKey("");
    if (!pair || pair === "search") return;
    const [p, w] = pair.split(":");
    api.get<LedgerView>(`/royalty-ledger?partyId=${p}&workId=${w}`)
      .then((v) => { setView(v); setRoundKey(v.rounds.find((r) => r.state !== "before")?.key ?? v.rounds[0]?.key ?? ""); })
      .catch((e: ApiError) => setError(e.message));
  }, [pair]);

  const choices = view ? [...view.rounds, ...view.history.slice(0, 6)] : [];
  const round = choices.find((r) => r.key === roundKey) ?? null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {error && <div className="alert">{error}</div>}
      <div className="row" style={{ gap: 6 }}>
        <select value={pair} onChange={(e) => { setPair(e.target.value); if (e.target.value !== "search") setPartyId(""); }}
                aria-label="作家・作品">
          {ledgers.map((l) => (
            <option key={`${l.partyId}:${l.workId}`} value={`${l.partyId}:${l.workId}`}>{l.partyName} × {l.workTitle}</option>
          ))}
          {partyId && works.map((w) => (
            <option key={`s${w.id}`} value={`${partyId}:${w.id}`}>（探した作家）× {w.title}</option>
          ))}
          <option value="search">別の作家を探す…</option>
        </select>
        {pair === "search" && (
          <div style={{ minWidth: 240 }}>
            <SearchSelect value={partyId} search={searchParties} placeholder="作家名で探す"
                          onChange={(v) => setPartyId(v)} />
          </div>
        )}
        {pair === "search" && partyId && !works.length && <span className="faint">この作家には料率の許諾（IN）の条件がありません</span>}
      </div>
      {view && (
        <div className="row" style={{ gap: 6 }}>
          <select value={roundKey} onChange={(e) => setRoundKey(e.target.value)} aria-label="回">
            {view.rounds.length > 0 && <optgroup label="開いている回">
              {view.rounds.map((r) => <option key={r.key} value={r.key}>{roundTitle(r)}（{[...new Set(r.parts.map((p) => p.label).filter(Boolean))].join("・")}）</option>)}
            </optgroup>}
            {view.history.length > 0 && <optgroup label="これまでの回">
              {view.history.slice(0, 6).map((r) => <option key={r.key} value={r.key}>{roundTitle(r)}</option>)}
            </optgroup>}
          </select>
          <button className="btn btn-sm primary" disabled={busy || !round} onClick={() => round && onPick(round)}>この回に紐づける</button>
          {!choices.length && <span className="faint">この作家・作品には回がありません（締め日の予定明細を作ると回ができます）</span>}
        </div>
      )}
    </div>
  );
}
