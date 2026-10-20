import { useEffect, useState } from "react";
import { api } from "./api.js";
import { STATION_HINT, STATION_MARK, STATION_NAME, type StationNo } from "./ProcessRail.js";
import type { HomeStations, StationCard } from "../server/ops/home-stations.js";
import { isInProgress, listWorkbenchStates } from "./WorkbenchWorkspace.js";

/** ホームの行き先。view は App の画面名。 */
export interface HomeGo { view: string; tab?: string; tile?: string; mode?: string }

/**
 * ホームの盤面：入口 3 つ（案件から・取引先から・まとめて）と、本線 5 駅で待っているもの。
 * 駅の札を押すと、その駅の画面へ行く。数は各画面と同じ道具で数える（/home/stations）。
 */
export function HomeBoard({ onGo }: { onGo: (go: HomeGo) => void }) {
  const [data, setData] = useState<HomeStations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState(0);
  useEffect(() => {
    api.get<HomeStations>("/home/stations").then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    try { setResumable(listWorkbenchStates().filter(isInProgress).length); } catch { setResumable(0); }
  }, []);

  const total = (no: StationNo) => data?.stations.find((s) => s.no === no)?.cards.reduce((a, c) => a + c.count, 0) ?? null;

  return (
    <div className="hb">
      {/* 入口 3 つ。列はいつも同じ 5 駅、違うのは行の粒だけ。 */}
      <div className="hb-entries">
        <button className="hb-entry" onClick={() => onGo({ view: "matters" })}>
          <span className="hb-entry-k">N</span>
          <span className="hb-entry-t">案件から</span>
          <span className="hb-entry-s">N 取引先 × N 取引。案件の工程表で次にやることを順に</span>
        </button>
        <button className="hb-entry" onClick={() => onGo({ view: "workbench" })}>
          <span className="hb-entry-k">1</span>
          <span className="hb-entry-t">取引先から</span>
          <span className="hb-entry-s">1 取引先 × N 取引。作業テーブルで相手先を選んで始める{resumable ? `・途中 ${resumable}` : ""}</span>
        </button>
        <button className="hb-entry" onClick={() => onGo({ view: "ops", tab: "sending" })}>
          <span className="hb-entry-k">P</span>
          <span className="hb-entry-t">まとめて</span>
          <span className="hb-entry-s">駅を 1 つ選び、待っている行を全部並べて一度に進める（下の 5 駅）</span>
        </button>
      </div>

      {error && <div className="alert">{error}</div>}
      <div className="hb-stations">
        {([1, 2, 3, 4, 5] as StationNo[]).map((no) => {
          const cards = data?.stations.find((s) => s.no === no)?.cards ?? [];
          const n = total(no);
          return (
            <section key={no} className={`hb-station${n ? " has" : ""}`}>
              <header className="hb-station-hd">
                <span className="hb-no">{STATION_MARK[no]}</span>
                <span className="hb-name">{STATION_NAME[no]}</span>
                <span className="hb-total">{n === null ? "…" : n}</span>
                <span className="hb-hint">{STATION_HINT[no]}</span>
              </header>
              <div className="hb-cards">
                {cards.map((c) => <Card key={c.key} card={c} onGo={onGo} />)}
                {!data && <span className="faint">読み込み中…</span>}
              </div>
            </section>
          );
        })}
      </div>
      <div className="faint">駅の札を押すと、その駅で待っている行がまとまって出る画面へ行きます。送ると、その行は ⑤ 記録 へ移ります。</div>
    </div>
  );
}

function Card({ card, onGo }: { card: StationCard; onGo: (go: HomeGo) => void }) {
  return (
    <button className={`hb-card${card.count ? " on" : ""}`} onClick={() => onGo(card.go)} disabled={!card.count}>
      <span className="hb-card-n">{card.count}</span>
      <span className="hb-card-l">{card.label}{card.sub ? <span className="faint">　{card.sub}</span> : null}</span>
    </button>
  );
}
