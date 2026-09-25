import { useEffect, useState } from "react";

/**
 * 一覧の絞り込み。
 *
 * サーバは案件・条件・作品・取引先・文書のすべてで q= を受け取るのに、
 * 画面がどこからも送っていなかった。件数の上限（200件）も出していなかった
 * ので、201件目以降は画面から辿り着けないうえ、そのことに気づけなかった。
 *
 * 打つたびに引かない。打ち終わってから引く。
 */

/** 入力が止まってから値を返す。 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** パネル見出しに置く検索欄。 */
export function ListSearch(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <div className="list-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" style={{ flex: "none", color: "var(--muted)" }}
           aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      <input type="search" value={props.value} placeholder={props.placeholder}
        aria-label={props.label ?? props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") props.onChange(""); }} />
    </div>
  );
}

/** 見出しの下に出す件数の帯。何件に絞れたのかを必ず見せる。 */
export function ListCount(props: {
  shown: number;
  keyword?: string;
  /** 絞り込みを外したときの全件数。分かるときだけ渡す。 */
  total?: number | null;
  onClear?: () => void;
  children?: React.ReactNode;
}) {
  const filtered = Boolean(props.keyword?.trim());
  return (
    <div className="list-count">
      {filtered
        ? <span>「{props.keyword}」に一致 <b className="num">{props.shown}</b> 件</span>
        : <span><b className="num">{props.shown}</b> 件</span>}
      {props.total != null && props.total !== props.shown && (
        <span className="faint">／ 全 {props.total} 件</span>
      )}
      {props.children}
      {filtered && props.onClear && (
        <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                onClick={props.onClear}>条件を消す</button>
      )}
    </div>
  );
}

/** 一覧の下に出す打ち切りの断り。黙って切らない。 */
export function ListLimit({ shown, limit = 200 }: { shown: number; limit?: number }) {
  if (shown < limit) return null;
  return (
    <div className="list-foot">
      <span>{limit} 件まで表示しています。これより多い場合は<b>表示されていないものがあります</b>。
        絞り込むと残りも見つかります。</span>
    </div>
  );
}
