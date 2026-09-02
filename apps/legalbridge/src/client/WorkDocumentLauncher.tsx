import { businessLineLabel, documentChoicesForWork, type WorkDocumentChoice } from "./work-intake";

// 「この作品から作る文書」の選択カード。作品登録の完了帯・一括編集・作品詳細の3箇所で
// 同じものを出す（承認済み方針 2026-09-02）。展開区分（business_line）で候補を絞り、
// 新規発行であることと、締結済み契約は取込→条件明細で入れる旨を毎回添える。
export function WorkDocumentLauncher({ businessLine, onPick, compact = false }: {
  businessLine: string | null | undefined;
  onPick: (choice: WorkDocumentChoice) => void;
  compact?: boolean;
}) {
  const choices = documentChoicesForWork(businessLine);
  return <div className={`wdl${compact ? " compact" : ""}`}>
    <div className="wdl-head">
      <strong>この作品から作る文書</strong>
      <small>展開区分: {businessLineLabel(businessLine)}{!businessLine ? "（未設定のため全種類を表示）" : ""}</small>
    </div>
    <div className="wdl-grid">
      {choices.map((choice) => <button type="button" key={choice.templateKey}
        className={choice.primary ? "primary" : ""} onClick={() => onPick(choice)}>
        <b>{choice.label}</b>
        <small>{choice.hint}</small>
      </button>)}
    </div>
    <small className="wdl-note">いずれも<b>新しい文書を発行</b>します。締結済みの契約の条件は文書を作らず「取込 → 詳細を編集 → 条件明細」で登録してください。</small>
  </div>;
}
