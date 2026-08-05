# LegalBridge V2 リニューアル設計計画（UI/UX再編＋機能完全移植）

V1（`LegalBridge_AI_GCP`）の全機能をV2（`apps/legalbridge`）へ移植し、UI/UXを再編するための全体設計計画。パリティ表（`v1-v2-parity-checklist.md`）を実装ロードマップへ落とし込む。

## 0. 不変条件（この計画の前提・全フェーズ共通）

1. **DBテーブル構成・document templateは変更しない**（共有本番`legalbridge` DBを尊重）。V2は操作パネル・UI・API/書込み層のみを足す。
2. **guarded-write モデル**を全書込みで踏襲：既定OFF、`WRITE_SCOPES`完全一致、確認トークン、admin/legal限定、DELETEなし、GRANTは最小権限。
3. **capability-gated UI**：`/api/v2/runtime` の `writeCapabilities` で画面を出し分け。未有効機能は表示しない。
4. **1スライス=1PR**：型検査＋テスト＋build グリーンを維持し、`main`へ小さくマージ。デプロイは既定OFFのまま安全に積む。
5. **段階cutover**：V1は一気に落とさない。領域単位でV2へ寄せ、金銭など重い領域は並行稼働も許容。

## 1. 現状認識（パリティ要約）

- **✅ 稼働可**：マスタ/文書/条件/契約取込/アウト条件/検索/認証
- **❌ 未移植（大）**：金銭・ロイヤリティ管理、作品権利モデル詳細、Backlog双方向、データ品質/保全/名寄せ
- **🟡 実装済みOFF**：Gmail/CloudSign/Slack

詳細は `v1-v2-parity-checklist.md` を正とする。

## 2. UI/UX 再編設計

### 2.1 情報設計（IA）— V1のナビをV2へ再構成

V1の4グループ構成を基礎に、V2の実装状況とcapabilityで出し分ける。目標IA：

| グループ | 項目 | V2現状 | 備考 |
|---|---|---|---|
| 概要 | ダッシュボード | ✅ | 案件KPIに加え決算バンド（消化率/検収率/未消化残）を追加済み（0-C）。grant 011適用で点火 |
| 業務 | 依頼(Backlog) | ❌ | Phase 3 |
| 業務 | 案件 | ✅ | **案件中心の導線**（文書/条件/送信を1案件に集約）を強化 |
| 業務 | 条件明細（消化/検収/検索） | ✅ | 既存を統合ハブ化 |
| 業務 | Excel出力 | ❌ | Phase 6 |
| 業務 | アーカイブ | ❌ | Phase 6 |
| 作成 | 文書作成 | ✅ | — |
| 作成 | 過去文書取込 | ✅ | — |
| 作成 | CSV取込（全テーブル・スキーマ駆動） | 🔶 | 汎用CsvImportを**スキーマ駆動**へ拡張（Phase 4） |
| 設定 | 作品管理（原作/作品/派生 3カード統合） | 🔶 | **3カード統合エディタ**を再現（Phase 2） |
| 設定 | 契約台帳 | 🔶 | 条件明細と統合検討 |
| 設定 | Finance（請求・分配） | ❌ | Phase 1（最重要） |
| 設定 | マスタ（取引先/担当者/作品） | ✅ | 台帳に集約済み |
| 設定 | Data Maintenance（一括取込/ID統合/未リンクCL/下書き） | ❌ | Phase 4 |
| 設定 | テンプレート | ✅ | — |
| 設定 | 連結チェック / データ品質 | ❌ | Phase 4 |
| 設定 | 設定 | 🔶 | 管理画面を拡張 |

### 2.2 UX導線の原則

- **案件（Matter）を主軸**に、文書生成→確定→PDF/Drive→署名依頼(CloudSign)→通知(Gmail/Slack)→条件登録→消化/検収 を1画面から辿れる縦導線。
- **作品（Work）を第2の主軸**に、原作/作品/派生と素材/条件/権利ソースをぶら下げる横断ビュー（3カード）。
- **重複・不整合はその場で警告**（条件重複ガードの思想を、データ品質/連結チェックへ拡張）。
- **操作パネルは capability で段階表示**：使える機能だけを出し、権限外は隠す。

### 2.3 デザインシステム

- V1のスキン（NERV/clean/arcs）は運用対象外とし、**cleanベースの単一デザインシステム**へ統一（トークン化：色/余白/タイポ/コンポーネント）。
- 既存V2のCSSを整理し、共通コンポーネント（テーブル/カード/フォーム/トースト/空状態/プレビュー）をライブラリ化。UI再編は各フェーズで機能移植とセットで進める（大爆発リファクタは避ける）。

## 3. 機能移植ロードマップ（フェーズ）

各フェーズは複数スライス（PR）に分割。優先度は「業務停止リスク × 依存関係」で決定。

### Phase 0：基盤整備（UI/UX土台）✅ 完了
- デザイントークン/共通コンポーネント抽出、ナビIA刷新（capability連動グループ）、ダッシュボード再設計
- 受け入れ：既存機能を壊さずIAが新構成に、共通UIが差し替わる
- 実装（3スライス・いずれも typecheck/test/build グリーン、DB/template無改変）：
  - **0-A** デザイントークン土台（`311f1d5`）：`src/client/tokens.css` を単一の真実源として新設（色/角丸/影/タイポ、既存値を1:1昇格＝見た目不変）。共通シェル＋基本プリミティブ（レール/ナビ/ヘッダ/パンくず/ページ/ボタン/KPI/パネル/表/フォーム土台/空状態/トースト）をトークン参照へ。機能固有ブロックは各フェーズ移植時に併せて寄せる（大爆発リファクタ回避）。
  - **0-B** ナビIA刷新（`6947514`）：サイドナビを 概要／業務／作成／設定 の4グループへ再構成（§2.1）。ロール・`writeCapabilities` の出し分けは完全維持。
  - **0-C** ダッシュボード決算バンド（`42b8c45`）：ホームに 消化率／検収率／未消化残 を追加。既存 `conditionLines.settlement()` を再利用し、財務テーブル未付与（grant 011）時は `null` で安全縮退（非表示）。Phase 1のGRANT適用で自動点火。

### Phase 1：金銭・ロイヤリティ管理【最重要・最大】
- ロイヤリティ計算エンジン（料率×製造/販売数、MG/AG消化）
- 支払報告書/ロイヤリティステートメント生成（templateは既存を使用）
- 源泉徴収・租税条約・多通貨/為替レート
- 請求ダッシュボード、債権マップ、製造・販売イベント
- **要GRANT**：関連テーブルへのSELECT/INSERT/UPDATE最小付与（billing系）
- 受け入れ：V1の支払報告と数値が一致（実データ突合）

### Phase 2：作品・権利モデル
- 作品3カード統合エディタ（原作/自社作品/派生）
- 作品詳細タブ：概要/素材/製品/条件/系譜(lineage)/権利ソース/料率対象
- 権利ツリー/条件ツリー、サブライセンス条件、未紐付け条件の導線
- 受け入れ：作品を起点に権利・条件・製品を一望・編集できる

### Phase 3：Backlog双方向 & 依頼
- 依頼(requests)画面：Backlog課題→リーガルリクエスト
- 書き戻し（コメント投稿・カスタム属性更新・ステータス同期）
- 変数自動抽出の移植
- **要判断**：書き戻しの範囲（どの属性を同期するか）
- 受け入れ：課題起点の依頼が取り込め、V2側操作がBacklogへ反映

### Phase 4：データ品質・保全・取込
- CSV取込のスキーマ駆動化（全テーブル対応）
- Excel一括、LegalOn取込
- データ品質センター（完全性Issue俯瞰/担当/修正導線）
- 連結チェック（整合性点検/修復）、名寄せ(Entity merge)、未リンクCL、下書き管理
- 受け入れ：不整合を検知・修復でき、一括取込が実運用に耐える

### Phase 5：外部連携の実地点火
- Gmail送信/受信、CloudSign依頼/ステータス、Slack配信を1つずつ有効化・検証
- CloudSignは実APIエンドポイント/認証の最終確認、Slackは実トークン投入
- 受け入れ：各連携が本番相当で実発火し、履歴/冪等が担保される

### Phase 6：残機能・運用
- Excel出力（未発行/検収/許諾）、アーカイブ、テキストスニペット、稟議(Ringi)、契約チェック、管理ポータル/運用ガイド、設定拡張
- 受け入れ：パリティ表の残❌が「移植済 or 廃止確定」になる

### Phase 7：本番昇格・cutover
- `legalbridge-v2-write-test` → 本番V2エンドポイント昇格、トラフィック切替、V1停止
- 受け入れ：パリティ表が全て ✅/🟡(意図的OFF)/廃止、実運用がV2で完結

## 4. 依存関係とクリティカルパス

```
Phase 0（土台）
  ├─→ Phase 1（金銭）  ← クリティカル・最重要
  ├─→ Phase 2（作品）  ← Phase1の債権/料率と一部依存
  ├─→ Phase 3（Backlog）
  └─→ Phase 4（データ品質）
Phase 5（連携点火）は Phase 0 完了後いつでも並行可
Phase 6 は随時
Phase 7 は全フェーズの受け入れ後
```

## 5. 要決定事項（着手前にユーザー判断が必要）

1. **金銭管理(Phase 1)の移植可否と範囲** — 全移植か／V1を金銭だけ残す部分cutoverか。**計画全体の重心**。
2. **Backlog書き戻しの範囲** — どの属性/ステータスを同期するか、iPaaS代替の是非。
3. **デザイン方針** — cleanベース単一DSで確定してよいか（NERVスキンは廃止）。
4. **サービス構成** — V1の admin-ui / search-api / worker 3分割を、V2は単一サービスに統合する方針でよいか。
5. **廃止候補の確定** — 稟議/スニペット/アーカイブ/ガイド等、パリティ表の❌のうち「廃止」でよい項目。

## 6. 進め方・品質ゲート

- 各スライス：`npm run typecheck && npm test && npm run build` グリーン必須、1PR=1論点、既定OFFで投入。
- 書込みは verify-write-test ゲート＋GRANT＋確認トークンを都度追加。
- フェーズ完了ごとにデプロイ＆実データ受け入れ。
- 本ドキュメントとパリティ表を「移植/残す/廃止」の記入で更新し、進捗の唯一の真実とする。

## 7. 進捗ログ

| 日付 | フェーズ | スライス | コミット | 状態 |
|---|---|---|---|---|
| 2026-08-04 | Phase 0 | 0-A デザイントークン土台 | `311f1d5` | ✅ |
| 2026-08-04 | Phase 0 | 0-B ナビIA刷新（概要/業務/作成/設定） | `6947514` | ✅ |
| 2026-08-04 | Phase 0 | 0-C ダッシュボード決算バンド（消化/検収） | `42b8c45` | ✅ |
| 2026-08-04 | Phase 1 | 現行ロジック棚卸し（決定1）→ `docs/phase1-money-inventory.md` | — | ✅ |
| 2026-08-04 | Phase 1 | スライス1：ロイヤリティ計算エンジン移植（純関数・GRANT不要） | `87cc900` | ✅ |
| 2026-08-04 | Phase 1 | スライス3：源泉徴収・消費税エンジン移植（純関数・GRANT不要） | `af38518` | ✅ |
| 2026-08-04 | Phase 1 | スライス9：為替換算・売上報告明細計算（純関数・GRANT不要） | `4489809` | ✅ |

**純関数の計算基盤トリオ完成**（`src/server/royalty/`）：`calc.ts`（料率カスケード）/ `tax.ts`（源泉・消費税）/ `fx.ts`（為替・明細）。いずれもDB非依存・GRANT不要。次段の書込み系（`condition_events` INSERT 等・要GRANT）が乗る土台。

| 2026-08-04 | Phase 1 | ロイヤリティ試算UI（読み取り専用・エンジン接続・GRANT不要） | `f8ad6ae` | ✅ |
| 2026-08-04 | Phase 1 | スライス2：消化イベント書込（`condition_events` INSERT・guarded・既定OFF）＋grant 014 | `fb64f05` | ✅ |
| 2026-08-04 | Phase 1 | 受領再許諾料・分配 計算（純関数・GRANT不要・債権/請求の土台） | `a0641eb` | ✅ |
| 2026-08-04 | Phase 1 | スライス6：受領記録CRUD（`condition_receipts` 作成/更新・guarded・既定OFF）＋grant 015 | `9e9d89c` | ✅ |
| 2026-08-04 | Phase 1 | スライス5：請求ダッシュボード（受領・分配の横断俯瞰・3KPI・読取・GRANT不要※015のSELECT利用） | `0952e9a` | ✅ |
| 2026-08-04 | Phase 1 | 受領記録UI（請求ダッシュボードに登録フォーム・capability-gated・S6 API利用） | `2aa4496` | ✅ |

**受領記録UI**：請求ダッシュボードに「受領を記録」フォームを追加（`receipts` capability連動）。S6の`POST /api/v2/condition-receipts`へ接続し、受領再許諾料はサーバ再計算値をトーストで表示。受領→ダッシュボードKPIの一気通貫UIが完成（GRANT追加なし・読取専用環境では非表示）。

| 2026-08-04 | Phase 1 | 上流分配の算定・保存（`condition_receipts`分配列・親料率参照・GRANT不要※015利用） | `70fcfdc` | ✅ |

**分配算定・保存**：受領記録時に上流ライセンサーへの分配（`基準額×個数×親料率`）を`resolveDistribution`で算定し、`condition_receipts`の分配列（`distribution_base/qty/rate_pct`・`computed_distribution_ex_tax`・`distribution_parent_condition_id`）へ保存。親料率は`condition_lines.parent_license_condition_id`→親の`rate_pct`から取得、引けなければ分配nullで安全縮退。ダッシュボードの「分配」列・「ライセンサー分配合計」KPIが点灯。**payments台帳同期は次スライス（grant 016）へ分離**。GRANT不要（015のUPDATE＋condition_lines SELECT利用）。

| 2026-08-04 | Phase 1 | payments台帳同期（受領→入金/分配→出金・追加capability・既定OFF）＋grant 016 | — | ✅ |

**payments台帳同期**：受領記録時に同一トランザクションで`payments`へ同期（受領→inbound/sublicense_income、分配→outbound/royalty・相手=親）。同期意図は純関数`planPaymentSync`が算出（no-DELETE：クリアは金額ゼロUPDATE、`work_id`欠落時はCHECK不成立でスキップ）。**capability分離**：受領記録（015）は単独動作、台帳同期は追加スコープ`payments`＋grant 016（`payments` SELECT/INSERT/UPDATE）有効時のみ。有効化手順は `docs/payment-ledger-deploy.md`。

| 2026-08-04 | Phase 1 | スライス7：債権マップ（作品中心3層カスケード・読取・GRANT不要※既存SELECT利用） | — | ✅ |

**スライス7（債権マップ・読取）**：段跨ぎカスケードを純関数`buildLineageCascade`で厳密移植（`cascade_base=Σ(i段〜最下段の受領)`・`分配=料率×base`・同一capabilityの二重計上防止`seenCap`・`Math.round`）。読み取りリポジトリ（Pg/Memory・42501等で縮退）が作品の派生系譜（`works.parent_work_id`）を辿り、各段の受領（`condition_receipts`）と上流料率（`parent_license_condition_id`→親`rate_pct`）を集約。`GET /api/v2/receivable-map`（admin/legal限定）＋`ReceivableMap.tsx`（作品ID入力→段ごとの受領/分配基礎/上流分配/留保＋合計）。新規GRANT不要。

**スライス5（請求ダッシュボード・読取）**：`GET /api/v2/receipts-dashboard`（admin/legal限定・書込みなし・42501等で空縮退）＋ `BillingDashboard.tsx`（業務ナビ・3KPI・フィルタ:検索/期間/未受領/未分配）。読み取りリポジトリ（Pg/Memory）は`condition_receipts`を`condition_lines`/`works`/`vendors`に結合し集計。新規GRANT不要（015の`condition_receipts` SELECTを利用、works/vendorsは既存SELECT）。受領記録（S6）が入るとKPIが点灯。

**スライス6（受領記録CRUD・要GRANT）**：`POST/PUT /api/v2/condition-receipts`（guarded-write：既定OFF・admin/legal・確認トークン `COMMIT_PRODUCTION_RECEIPT`・DELETEなし）。受領再許諾料はサーバ再計算（料率/単価は`condition_lines`から、qty判定/報告値はリクエスト）。書込みリポジトリ（Pg/Memory）＋grant 015（`condition_receipts` SELECT/INSERT/UPDATE＋seq）。**payments台帳同期・上流分配は次スライスへ分離**。有効化手順は `docs/receipt-recording-deploy.md`。

**スライス2（消化イベント書込・要GRANT）**：`POST /api/v2/royalty/events`（guarded-write：既定OFF・admin/legal限定・確認トークン `COMMIT_PRODUCTION_ROYALTY_EVENT`・DELETEなし・金額はサーバ再計算）。書込みリポジトリ（Pg/Memory）＋grant 014（`condition_events` INSERT＋seq、`relkind='r'`検証）。config/app結線・writeCapabilities `royalty-events`・safe-write許可。有効化手順は `docs/royalty-events-deploy.md`。本番GRANT適用と `verify-write-test` はオペレーター作業。

**試算プレビュー**：`POST /api/v2/royalty/preview`（計算専用・DB書込みなし・safe-POST許可）＋ `RoyaltyPreview.tsx`（業務ナビ・法務限定・300msデバウンスのライブ試算）。純関数エンジンを実UIに接続し、実データ・GRANT無しで計算を検証可能に。V1 `RoyaltyPreviewPanel` 相当。

**決定1（金銭管理の移植可否・範囲）＝「まず現行ロジックの棚卸し」**：V1の金銭実装を4系統（計算エンジン／支払報告・源泉・為替／請求・債権マップ／DBスキーマ・GRANT）で精査し、`docs/phase1-money-inventory.md` に集約。V2ギャップと移植ロードマップ（9スライス素案）、Phase 1 GRANT必要範囲を確定。

**grant 011（本番投入OK）**：既存の非破壊・SELECTのみGRANT（`condition_line_installments`/`condition_events`）。適用で0-Cの決算バンドが点火。適用コマンドは棚卸しドキュメント §5.2 参照。Phase 1の書込（`condition_events` INSERT、`condition_lines` UPDATE、`payments`/`invoices`/`condition_receipts`/`royalty_*` 等の新規付与）は次段の新規grantファイル（014+）で起こす。

**次アクション**：棚卸しを踏まえ、Phase 1の着手スコープを確定（全移植 or 計算〜支払報告のみ先行の部分cutover）。着手時は「計算エンジン（純関数・GRANT不要）」から。

---

*本計画はV1実装（`src/layout`・`src/pages`・`services/api/src`・要件定義）とV2現状を突き合わせて作成。フェーズ内の各スライスは着手時に個別設計する。*
