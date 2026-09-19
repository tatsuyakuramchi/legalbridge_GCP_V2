/**
 * 詳細から一覧へ戻る道（1画面1つのとき）。
 *
 * ウィンドウを半分にして使うので、一覧と詳細は既定で切り替える。切り替える
 * 以上、戻る道が画面の中に無いといけない（ブラウザの戻るは画面そのものが
 * 変わってしまう）。並べて出せる幅のときは CSS で消える。
 */
export function DetailBack({ label, count, onBack }: {
  /** 「案件」「条件明細」など、戻る先の呼び名。 */
  label: string;
  /** 一覧の件数。戻った先に何があるかを先に見せる。 */
  count?: number;
  onBack: () => void;
}) {
  return (
    <button className="md-back" onClick={onBack}>
      <span aria-hidden="true">←</span>
      {label}の一覧{count === undefined ? "" : `（${count} 件）`}へ戻る
    </button>
  );
}

/**
 * 一覧と詳細を並べて出せる幅か。styles.css の分かれ目と同じ数字を使う
 * （ここと CSS がずれると、一覧が消えたまま詳細も出ない画面ができる）。
 */
export const WIDE_LAYOUT = "(min-width: 1700px)";
export const isWideLayout = () =>
  typeof window !== "undefined" && window.matchMedia(WIDE_LAYOUT).matches;
