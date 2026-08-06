// 運用ガイド / 管理ポータル（Phase 6・静的クライアント）。
// V2の機能有効化・ロール・GRANT・デプロイの要点を画面内に集約する。
// サーバ非依存の静的コンテンツ（読取のみ）。

type Section = { heading: string; items: Array<{ term: string; detail: string }> };

const SECTIONS: Section[] = [
  {
    heading: "ロールとアクセス",
    items: [
      { term: "admin（管理者）", detail: "全業務・マスタ編集・管理ポータル・名寄せ等の実行が可能。" },
      { term: "legal（法務）", detail: "案件・文書・条件・作品・請求など日常業務。書込みは capability 有効時のみ。" },
      { term: "requester（依頼者）", detail: "自分の文書・下書きの作成/再開に限定（他者データは非表示）。" },
      { term: "認証", detail: "IAP（本番）／Cloud Run IAM（検証）。AUTH_MODE=disabled では読取のみの想定。" }
    ]
  },
  {
    heading: "機能の有効化（capability）",
    items: [
      { term: "既定はすべてOFF", detail: "書込み機能は既定で無効。/api/v2/runtime の writeCapabilities に載った機能だけがUIに現れる。" },
      { term: "有効化の3点", detail: "①該当スコープを WRITE_SCOPES に追加 ②対応する *_WRITES_ENABLED=true ③本番DBへ該当GRANTを適用。3つが揃って初めて動作。" },
      { term: "WRITE_SCOPES 完全一致", detail: "有効化したcapabilityと WRITE_SCOPES が食い違うと verify-write-test が停止（安全側）。" }
    ]
  },
  {
    heading: "GRANT（本番DB権限）早見",
    items: [
      { term: "006 / 007", detail: "基盤SELECT（works/condition_lines/vendors/documents 等）＋契約取込のINSERT/SELECT。" },
      { term: "011〜016", detail: "消化・検収読取／消化イベント／受領記録／payments台帳（Phase 1）。" },
      { term: "012 / 013 / 017", detail: "作品UPDATE／素材UPDATE／権利ソースUPDATE。" },
      { term: "018", detail: "取引先名寄せ（4表の該当vendor列に列単位UPDATE）。" }
    ]
  },
  {
    heading: "デプロイ",
    items: [
      { term: "検証環境", detail: "infra/gcp/cloudbuild-write-test.yaml を gcloud builds submit（既定OFFのまま安全に反映）。" },
      { term: "Runbook", detail: "Phase 1は docs/phase1-deploy-runbook.md、各機能は docs/*-deploy.md、Phase別は docs/renewal-design-plan.md を参照。" },
      { term: "切戻し", detail: "WRITE_SCOPES から該当を外して再デプロイ、全停止は WRITE_FEATURES_ENABLED=false。" }
    ]
  },
  {
    heading: "データの安全設計",
    items: [
      { term: "DBスキーマ無改変", detail: "共有本番DBのテーブル/テンプレートは変更しない。V2は操作パネル・API・書込み層のみ追加。" },
      { term: "no-DELETE", detail: "物理削除は行わない。無効化は is_active=false や status 変更、金額ゼロUPDATE等で表現。" },
      { term: "確認トークン", detail: "重要な書込み（消化イベント・名寄せ等）は合言葉入力を要求。" }
    ]
  }
];

export function OperationsGuide() {
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>OPERATIONS GUIDE</p>
          <h1>運用ガイド</h1>
          <small>V2の権限・機能有効化・GRANT・デプロイの要点（読み取り専用）</small>
        </div>
      </div>
      <div className="guide-sections">
        {SECTIONS.map((section) => (
          <article className="guide-section" key={section.heading}>
            <h3>{section.heading}</h3>
            <dl>
              {section.items.map((item) => (
                <div key={item.term}><dt>{item.term}</dt><dd>{item.detail}</dd></div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
