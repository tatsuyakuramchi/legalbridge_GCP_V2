import type { ReactNode } from "react";

/**
 * 工程ナビ ― 本線は 1 本、駅は 5 つ（docs/v3-tidy.md の前段、モック「工程の文法」）。
 *
 *   ① 登録する  台帳に事実を入れる（取引先・契約・条件・実績・支払）
 *   ② 作る      紙を出して決定する（契約書・条件書・計算書・検収書・訂正版）
 *   ③ 確かめる  人の目を通す（飛ばせる：担当者・相手方・試算）
 *   ④ 送る      外へ出す（メール・CloudSign・Drive）
 *   ⑤ 記録する  外で起きたことを残す（締結・返事・払った・飛ばした）
 *
 * どの作業でも左に ①〜⑤ が同じ順・同じ位置。入口（案件・取引先・まとめて）と対象の名前だけが変わる。
 * 駅の中は「札」で分かれる（① の中に 取引先 ✓／基本契約 ✓／条件 ✓ のように）。
 * 済んだ駅・札は押して戻れる（作ったものは消えない）。先の駅は押せない。
 *
 * この部品は見た目と押す口だけ。駅の状態は画面ごとに組む（作業テーブル・文書の送る流れ・支払文書の回）。
 */

export type StationNo = 1 | 2 | 3 | 4 | 5;
export type StationState = "done" | "now" | "todo" | "skipped" | "optional";

export const STATION_NAME: Record<StationNo, string> = { 1: "登録する", 2: "作る", 3: "確かめる", 4: "送る", 5: "記録する" };
export const STATION_MARK: Record<StationNo, string> = { 1: "①", 2: "②", 3: "③", 4: "④", 5: "⑤" };
export const STATION_HINT: Record<StationNo, string> = {
  1: "台帳に事実を入れる", 2: "紙を出して決定する", 3: "人の目を通す（飛ばせる）", 4: "外へ出す", 5: "外で起きたことを残す"
};

/** 駅の中の札（① の 取引先／基本契約／条件、③ の 担当者／相手方 など）。 */
export interface StationTag {
  key: string;
  label: string;
  state: StationState;
  /** 押したときに開く（戻る）。無ければ押せない。 */
  onGo?: () => void;
  /** いま開いている札。 */
  open?: boolean;
  title?: string;
}

export interface Station {
  no: StationNo;
  state: StationState;
  /** 1 行の説明（「条件書 1 枚（下書き）」「ARC-PUBM-2026-0030」）。 */
  detail?: ReactNode;
  tags?: StationTag[];
  /** 駅を押したときに開く（戻る）。無ければ押せない。 */
  onGo?: () => void;
  /** いま開いている駅。 */
  open?: boolean;
  /** 点線＝飛ばせる駅（③ など）。 */
  skippable?: boolean;
}

export function ProcessRail({ stations, entry, subject, onBack, backLabel, foot, compact }: {
  stations: Station[];
  /** 入口（案件・取引先・まとめて・デイリータスク）。 */
  entry?: ReactNode;
  /** 対象（「脇屋彰太 様　出版条件書」）。 */
  subject?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  foot?: ReactNode;
  /** 右の欄の無い所（一覧の脇）で使う狭い形。 */
  compact?: boolean;
}) {
  const byNo = new Map(stations.map((s) => [s.no, s]));
  return (
    <nav className={`prail${compact ? " compact" : ""}`} aria-label="工程ナビ">
      {(entry || subject || onBack) && (
        <div className="prail-head">
          {onBack && <button type="button" className="linky" onClick={onBack}>← {backLabel ?? "戻る"}</button>}
          {entry && <div className="prail-entry">{entry}</div>}
          {subject && <div className="prail-subject">{subject}</div>}
        </div>
      )}
      <ol className="prail-list">
        {([1, 2, 3, 4, 5] as StationNo[]).map((no) => {
          const s = byNo.get(no) ?? { no, state: "todo" as StationState };
          const canGo = Boolean(s.onGo) && s.state !== "todo";
          const Tag = canGo ? "button" : "div";
          return (
            <li key={no} className={`prail-station ${s.state}${s.open ? " open" : ""}${s.skippable ? " skippable" : ""}`}>
              <Tag {...(canGo ? { type: "button", onClick: s.onGo } : {})} className="prail-row" aria-current={s.state === "now" ? "step" : undefined}
                   title={canGo ? "ここに戻る（作ったものは消えません）" : STATION_HINT[no]}>
                <span className="prail-mark" aria-hidden="true">
                  {s.state === "done" ? "✓" : s.state === "skipped" ? "↷" : String(no)}
                </span>
                <span className="prail-body">
                  <span className="prail-name">
                    <span className="prail-no">{STATION_MARK[no]}</span>{STATION_NAME[no]}
                    {s.state === "now" && <span className="prail-now">いま</span>}
                    {s.state === "skipped" && <span className="prail-skip">飛ばした</span>}
                  </span>
                  {s.detail && <span className="prail-detail">{s.detail}</span>}
                </span>
              </Tag>
              {s.tags && s.tags.length > 0 && (
                <div className="prail-tags">
                  {s.tags.map((t) => {
                    const go = Boolean(t.onGo) && t.state !== "todo";
                    const T = go ? "button" : "span";
                    return (
                      <T key={t.key} {...(go ? { type: "button", onClick: t.onGo } : {})}
                         className={`prail-tag ${t.state}${t.open ? " open" : ""}`} title={t.title}>
                        {t.state === "done" ? "✓ " : t.state === "skipped" ? "↷ " : t.state === "now" ? "● " : ""}{t.label}
                      </T>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {foot && <div className="prail-foot">{foot}</div>}
    </nav>
  );
}

/** 駅の状態を、その駅の札からまとめる（1 つでも「いま」なら now、全部済みなら done）。 */
export function stationStateOf(tags: StationTag[], fallback: StationState = "todo"): StationState {
  if (!tags.length) return fallback;
  if (tags.some((t) => t.state === "now")) return "now";
  if (tags.every((t) => t.state === "done" || t.state === "skipped" || t.state === "optional")) {
    return tags.some((t) => t.state === "done") ? "done" : tags.some((t) => t.state === "skipped") ? "skipped" : "optional";
  }
  return fallback;
}
