import { businessLineLabel, documentChoicesForWork, type WorkDocumentChoice } from "./work-intake";

// 「この作品から作る文書」の選択カード。作品登録の完了帯・一括編集・作品詳細の3箇所で同じものを出す。
// 2026-09-04 段階3: 条件を持つ文書（個別条件書・発注書・ライセンスアウト契約）は作品から直接
// 起こさず、「条件を登録する」→③新規文書に紐づける で起こす（条件台帳が正・二重防止）。
// ここに残るのは条件を持たない文書（出版基本契約）だけ。展開区分（business_line）で候補を絞る。
export function WorkDocumentLauncher({ businessLine, onPick, onEnterConditions, compact = false }: {
  businessLine: string | null | undefined;
  onPick: (choice: WorkDocumentChoice) => void;
  onEnterConditions?: () => void;
  compact?: boolean;
}) {
  const choices = documentChoicesForWork(businessLine);
  return <div className={`wdl${compact ? " compact" : ""}`}>
    <div className="wdl-head">
      <strong>この作品から作る文書</strong>
      <small>展開区分: {businessLineLabel(businessLine)}{!businessLine ? "（未設定）" : ""}</small>
    </div>
    <div className="wdl-grid">
      {onEnterConditions && <button type="button" className="primary" onClick={onEnterConditions}>
        <b>条件を登録して文書を作る</b>
        <small>個別利用許諾条件書（ゲーム／出版）・発注書・ライセンスアウト契約。条件明細を先に作り、最後に新規文書へ引き渡す</small>
      </button>}
      {choices.map((choice) => <button type="button" key={choice.templateKey} onClick={() => onPick(choice)}>
        <b>{choice.label}</b>
        <small>{choice.hint}</small>
      </button>)}
    </div>
    <small className="wdl-note">条件（料率・MG/AG・支払・許諾地域）は条件台帳が正です。締結済みの契約は「条件を登録する」で条件明細を作り、「過去文書／アップロード文書に紐づける」で結びます。</small>
  </div>;
}
