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

### Phase 1：金銭・ロイヤリティ管理【最重要・最大】✅ 主要スライス完了（§7進捗ログ参照）
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

| 2026-08-04 | Phase 1 | スライス7：債権マップ（作品中心3層カスケード・読取・GRANT不要※既存SELECT利用） | `cd15a8e` | ✅ |
| 2026-08-04 | Phase 1 | スライス4：支払報告書（源泉込み支払内訳・CSV出力・読取・GRANT不要※016 SELECT利用） | `ffb99d3` | ✅ |
| 2026-08-04 | Phase 1 | スライス8：請求印刷（受領・分配 計算書・window.print()・クライアント完結） | — | ✅ |

**スライス8（請求印刷・クライアント完結）**：`receipts-dashboard`読み取りを作品ごとに集計し、印刷最適化した「再許諾料 受領・分配 計算書」を`BillingPrint.tsx`で描画。`@media print`でシェル（レール/ヘッダ/パンくず/トースト）を隠し、計算書のみ印刷。`window.print()`でPDF化。新規依存・新規GRANT・サーバ変更なし。**これにて Phase 1（金銭・ロイヤリティ）の主要スライスが完了**。

> **Phase 1 完了サマリ**：純関数エンジン7種（calc/tax/fx/receipt/payment-sync/receivable-map/payment-report）＋書込3系統（消化イベント/受領記録/payments台帳・grant 014/015/016）＋読取・印刷UI6種（試算/請求ダッシュボード/債権マップ/支払報告書/請求印刷＋受領記録UI）。テスト327件。すべて既定OFF・capability-gated・no-DELETE・DB/template無改変・既存ゼロ破壊。本番GRANT適用（011/014/015/016）と`verify-write-test`はオペレーター作業として残る。S4は軽量Excel(.xls・HTMLテーブル方式・依存なし)＋CSV出力に対応済み（正式xlsx/ZIPはSheetJS等の依存判断があれば後日）。デプロイは統合Runbook `docs/phase1-deploy-runbook.md` 参照。

| 2026-08-05 | Phase 2 | 棚卸し＋計画 → `docs/phase2-works-rights-plan.md` | — | ✅ |
| 2026-08-05 | Phase 2 | スライス2-1：作品集約リードAPI（一覧/検索＋詳細集約：概要/系譜/素材/権利ソース/条件・読取・GRANT不要※006+007 SELECT利用・セクションnull縮退） | — | ✅ |

**スライス2-1（作品集約リード）**：`works/work-detail.ts`（純関数：条件分類`groupWorkConditions`・系譜ラベル`buildLineageView`）＋`works/read-repository.ts`（`list`/`detail`・並行取得・権限不足セクションnull縮退・Memory同梱）＋`works/read-routes.ts`（`GET /works`・`GET /works/:id/detail`・admin/legal限定）。app.ts結線（読取・フラグ無し）。作品を起点に系譜/素材/権利ソース/条件を一望する土台。新規GRANT・新規env不要（既存デプロイで反映）。テスト339件。決定ポイント（製品テーブルはDDL要・系譜の真実源二重化）は計画doc §2参照。

| 2026-08-05 | Phase 2 | スライス2-2：作品詳細ページUI（作品ピッカー＋タブ 概要/系譜/素材/条件/権利ソース/料率対象・読取・ナビ「作品」新設） | — | ✅ |

**スライス2-2（作品詳細ページUI）**：`WorkDetail.tsx`。作品ピッカー（キーワード検索・デバウンス＝ReceivableMapの生ID入力問題も解消）で選択 → `GET /works/:id/detail` を集約表示。タブ 概要/系譜/素材/条件/権利ソース/料率対象。系譜は原作→派生Nを段表示し、派生作品・「未反映の親（work_relations）」への遷移導線を提供。権限未付与セクションは縮退注記。ナビ「業務」に**作品**を新設（`view: works`・legal限定）。CSSは`wd-*`名前空間で追加（既存無改変）。新規依存・新規GRANT・新規env・サーバ変更なし（2-1のAPIのみ利用）。テスト339件。**これで「作品を起点に権利・条件・製品を一望」の一望（読取）が完結**。残：編集（2-3）・権利ソース書込（2-4）・製品（DDL要・保留）。

| 2026-08-05 | Phase 2 | スライス2-3：作品編集の書込み拡張（系譜/種別/権利者・capability-gated・grant 012流用・閉路防止） | — | ✅ |

**スライス2-3（作品編集の書込み拡張）**：既存の作品書込み（5列）を拡張し、`title_kana`/`work_type`/`kind`(enum)/`derivation_type`/`is_original`/**`parent_work_id`（系譜）**/`rights_holder_vendor_id`/`creator_name`/`publisher_name` を編集可能に。**grant 012（works全表UPDATE）流用で新規GRANT不要**、既存 `works` capability（scope `works`・`WORK_WRITES_ENABLED`）で一体ゲート。系譜の**閉路防止**（自己親・子孫を親にする操作を422 `WORK_LINEAGE_CYCLE` で拒否・Pg再帰CTE＋Memory両実装）。`find`と`WorkRecord`を拡張列まで返すよう更新。UIは `WorkDetail` 概要タブに capability-gated（`canEditWorks`）な編集フォームを追加（親作品ID・区分・原作フラグ等、保存はPATCH→再取得）。DELETEなし。テスト344件。

| 2026-08-05 | Phase 2 | スライス2-4：権利ソース(material_rights_sources)書込（作成/更新・guarded・既定OFF・scope `rights-sources`）＋grant 017（UPDATE） | — | ✅ |

**スライス2-4（権利ソース書込）**：`works/rights-source-write-{schema,repository,routes}.ts`。`POST /rights-sources`・`PATCH /rights-sources/:id`（admin/legal限定・validate同梱・DELETEなし・material_id付替禁止）。新capability **`rights-sources`**（`RIGHTS_SOURCE_WRITES_ENABLED`）でPhase 1と同一の5条件ゲート。**grant 017**（`material_rights_sources` UPDATE。INSERT/seqは007済・`relkind='r'`検証）＋preflight。config/app（gating・safe-write許可・writeCapabilities）・`verify-write-test.sh`（case＋expected_write_scopes）・`cloudbuild-write-test.yaml`（substitutions/verify export/deploy ENVVARS）を全結線（既定OFF・BLOCKED＝既存デプロイ無影響、default検証で確認）。UIは `WorkDetail` 権利ソースタブに capability-gated（`canEditRights`）な追加/編集フォーム（素材選択・ソース種別・役割・主フラグ・有効期間・各参照ID）。テスト352件。有効化手順は `docs/phase2-works-rights-plan.md`。

| 2026-08-05 | Phase 2 | スライス2-4b：work_relationsグラフ編集（derived_from追加・冪等・循環拒否・既存works capability流用・GRANT不要※007 INSERT） | — | ✅ |

**スライス2-4b（work_relationsグラフ編集）**：系譜の第2真実源 `work_relations` に `derived_from` 関係を追加。`POST /work-relations`（＋validate）を既存の作品書込ルーターに追加し、**既存 `works` capability ゲート流用・新規scope/GRANT不要**（INSERTは007付与済）。`ON CONFLICT DO NOTHING` で冪等（重複は200 `created:false`）、自己参照400、`parent_work_id`系譜と整合する**循環を422で拒否**（Pg `assertNoCycle`＋Memoryの祖先走査）。UIは `WorkDetail` 系譜タブに capability-gated な「派生元を追加」＋「現在の親を系譜に記録」（二重管理の整合導線）。**削除はDELETE権限が必要なため保留**（財務系と同じくno-DELETE方針。整合維持は追加＝additive中心）。テスト356件。

| 2026-08-05 | Phase 2 | スライス2-5：製品タブ（オプションA・既存エンティティ代替・読取・DDL/GRANT不要） | — | ✅ |

**スライス2-5（製品タブ・オプションA）**：製品専用テーブルは共有DB無改変の原則によりDDL保留とし、**既存エンティティで代替**。読取リポジトリの系譜子ノードに `kind`/`status` を追加し、`WorkDetail` に「製品」タブを新設。この作品を派生元とする**派生作品を「製品」として表**（コード/製品名/区分/ステータス・詳細へ遷移）＋**構成素材**を集約表示。DDL・新規GRANT・書込みなし。注記で代替表示である旨を明示。テスト356件。**これにて Phase 2（作品・権利モデル）完了**：読取一望（2-1/2-2）＋作品編集（2-3）＋権利ソース編集（2-4）＋系譜グラフ編集（2-4b）＋製品タブ（2-5）。正式な製品モデル（SKU/版を持つ `products` テーブル）が要件化した時点でオプションBへ置換可能。

> **Phase 2 完了サマリ**：作品集約リード（`GET /works`・`GET /works/:id/detail`）＋作品詳細UI（概要/系譜/製品/素材/条件/権利ソース/料率対象）。書込3系統（作品拡張列＝grant 012流用・権利ソース＝grant 017新規・work_relations＝007流用）はすべて capability-gated・既定OFF・no-DELETE・DDLなし・既存ゼロ破壊。系譜は `parent_work_id` を正とし `work_relations` 差分を整合導線として提示。製品はオプションA（既存代替）。本番有効化（scope `works`,`rights-sources`＋grant 012/017）はオペレーター作業。デプロイは既存 `cloudbuild-write-test.yaml`（読取は追加設定なしで反映）。

| 2026-08-05 | Phase 4 | 棚卸し＋計画 → `docs/phase4-data-quality-plan.md` | — | ✅ |
| 2026-08-05 | Phase 4 | スライス4-1：データ品質センター（横断整合スキャン俯瞰・drill・読取・GRANT不要※006/007/015 SELECT・スキャン単位null縮退） | — | ✅ |

**スライス4-1（データ品質センター）**：`data-quality/scan.ts`（純関数 `summarizeQuality`＝available集計・重大度→件数降順整列・未スキャン末尾）＋`data-quality/repository.ts`（`scan()` が5カテゴリ並行・**スキャン単位で42501/42P01/42703/42883を縮退** available:false・Memory同梱）＋`data-quality/routes.ts`（`GET /data-quality`・admin/legal限定）。5スキャン：未リンク条件明細(high)／素材未登録の作品(medium)／権利ソース未登録の素材(medium)／未受領報告済(low)／取引先重複候補(medium・`lower(btrim())`で関数非依存)。app.ts結線（読取・フラグ無し）。UI `DataQuality.tsx`（サマリバンド＋重大度色分けカード＋サンプル展開＋drill導線）をナビ「設定＞データ品質」に新設。**新規GRANT・env・依存なし**（既存デプロイで反映）。テスト361件。

| 2026-08-05 | Phase 4 | スライス4-2：CSV取込の拡張（素材・権利ソース・共通bulkヘルパ・既存INSERT流用・GRANT不要） | — | ✅ |

**スライス4-2（CSV取込拡張）**：`import/bulk.ts`（共通 `bulkImport(rows, schema, create)`＝行独立の検証→登録→成否集計、CSV文字列を寄せる `csvBool`/`csvOptionalId`）を新設。素材：`materialImportRowSchema`（workId/enumをcoerce）＋`POST /materials/import`（既存 `materials` capability・INSERTは007済）。権利ソース：`rightsSourceImportRowSchema`＋`POST /rights-sources/import`（既存 `rights-sources` capability）。app.ts safe-write に `/materials/import`・`/rights-sources/import` を追加。UIは `CsvImport` に `materialCsvConfig`（enum値ガイド付き）を追加し `LedgerWorkspace` 素材タブに CSV取込ボタンを結線（権利ソース取込はAPI・configレディ、専用UIは後段）。DELETEなし・新規GRANT/env不要。テスト369件。

| 2026-08-05 | Phase 4 | スライス4-3：取引先名寄せ（8表FK再指定＋旧is_active=false・プレビュー2段・guarded・確認トークン・scope `vendor-merge`）＋grant 018（列単位UPDATE×4表） | — | ✅ |

**スライス4-3（取引先名寄せ）**：`vendors/merge-{schema,repository,routes}.ts`。`GET /vendor-merge/preview`（**読取・GRANT不要**＝8表の参照件数を集計、書込無効でも可）＋`POST /vendor-merge`（guarded・admin/legal・合言葉 `COMMIT_VENDOR_MERGE`）。実行は1トランザクションで8表のvendor FKを旧→新へ再指定し、旧取引先を `is_active=false`（**DELETEしない**）。新capability **`vendor-merge`**（`VENDOR_MERGE_ENABLED`）でPhase 1同格の5条件ゲート。**grant 018**＝既にUPDATE済でない4表（condition_lines/material_categories/contracts/contract_works）に**列単位UPDATE**のみ付与（全列は付与せず）＋preflight（`relkind='r'`検証）。config/app（gating・safe-write・writeCapabilities）・`verify-write-test.sh`・`cloudbuild-write-test.yaml` 全結線（既定OFF・default検証で無影響確認）。UI `VendorMerge.tsx`（存続先/統合元ID→プレビュー→合言葉→実行・capability未付与はプレビューのみ）をナビ「設定＞取引先名寄せ」に新設。データ品質センターの重複取引先カードからdrill導線。テスト377件。

| 2026-08-05 | Phase 4 | スライス4-4：下書き一括整理（stale sweep・プレビュー→一括削除・owner scoped・既存 `drafts` capability・GRANT不要※006 DELETE済） | — | ✅ |

**スライス4-4（下書き一括整理）**：`document_drafts` の古い下書きを一括整理。`draft-repository` に `listStale(days, owner, limit)`／`purgeStale(days, owner)` を追加（owner=""＝全件、requesterは自分のみ）。`GET /document-drafts/stale?days=N`（プレビュー・件数）＋`POST /document-drafts/purge {days}`（一括削除・既存 `drafts` capability の safe-write ゲート）。**新規GRANT不要**（006で document_drafts の DELETE 付与済）。UI `DraftWorkspace` に「古い下書きの整理」（日数指定→対象確認→一括削除・確認ダイアログ）を追加。テスト381件。

| 2026-08-05 | Phase 4 | スライス4-5：Excel一括取込（依存ゼロ・区切り自動判定/引用符対応パーサ）＋LegalOn土台 | — | ✅ |

**スライス4-5（Excel一括取込・依存ゼロ）**：S4 Excel出力と同じ無依存方針で取込を堅牢化。`client/csv-parse.ts`（`detectDelimiter`＝**Excelセル範囲コピペのTSV**を自動判定／`parseRecords`＝**引用符付きCSV**の埋め込みカンマ・改行・`""`を復元／`parseDelimited`＝ヘッダ別名マップ）を新設し、`CsvImport` の素朴なカンマ分割を置換。全取込（取引先/担当者/作品/素材/権利ソース）がExcel実データで壊れない。UIに貼付ガイド追記。テストは純関数化により**クライアントも対象化**（package.json testグロブに `src/client/**/*.test.ts` 追加）。**SheetJS等の`.xlsx`直接パースは新規依存回避のため見送り**。**LegalOn**専用presetは実export列仕様が判明した時点で追加（現状も汎用取込のヘッダマッピングで取込可能）。テスト387件。**これにて Phase 4（データ品質・保全・取込）完了**。

> **Phase 4 完了サマリ**：データ品質センター（横断整合5スキャン・読取・GRANT不要）／CSV取込拡張（素材・権利ソース・共通bulkヘルパ）／取引先名寄せ（8表FK再指定＋is_active=false・guarded・grant 018列単位UPDATE）／下書き一括整理（stale sweep・既存drafts capability）／Excel一括取込（依存ゼロ・TSV/引用符対応パーサ）。書込は全て capability-gated・既定OFF・no-DELETE・既存ゼロ破壊。本番有効化（scope `vendor-merge`＋grant 018）はオペレーター作業。読取（品質センター）と取込パーサ堅牢化は追加設定なしで反映。LegalOn専用presetのみ実仕様待ちで保留。

**スライス4（支払報告書・読取）**：出金台帳（`payments` outbound）の各行に源泉徴収・消費税を適用し差引振込額まで算定。純関数`buildPaymentReport`が`tax.ts`（源泉10.21%/100万超20.42%/個人強制ON・消費税ceil）を合成。読み取りリポジトリ（Pg/Memory・42501等で縮退）が`payments`＋`vendors`（源泉フラグ）を集約。`GET /api/v2/payment-report`（admin/legal限定）＋`PaymentReport.tsx`（期間フィルタ・4KPI・明細・**クライアント側CSV出力**）。**SheetJS等の新規バイナリ依存は追加せず**、XLSX/ZIP特有形式は後日拡張。新規GRANT不要（016の`payments` SELECT＋vendors利用）。

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

| 2026-08-05 | Phase 6 | 棚卸し＋計画 → `docs/phase6-remaining-features-plan.md` | — | ✅ |
| 2026-08-05 | Phase 6 | スライス6-1：Excel/CSV一覧出力の共通化＋主要一覧配線（文書/検収/条件/請求/支払・依存ゼロ・GRANT不要） | — | ✅ |

**スライス6-1（Excel/CSV一覧出力）**：`client/export-util.ts`（純関数 `toCsv`/`toExcelHtml`＝SheetJS非依存の`.xls`/`download`/`exportCsv`/`exportExcel`、`ExportColumn<T>` 型安全）＋`ExportButtons.tsx` を新設し、`PaymentReport` のローカル実装を汎用化。**文書一覧・検収待ち・条件明細(許諾)・請求ダッシュボード・支払報告書**にCSV/Excel出力を配線（ロードマップ「Excel出力（未発行/検収/許諾）」）。全て既存GETの読取＝**新規GRANT・env・依存なし**（既存デプロイで反映）。クライアント純関数テスト追加。テスト390件。Phase 6の残（運用ガイド6-2/スニペット6-3/アーカイブ6-4/契約チェック6-5＝依存ゼロ版で実装可、稟議6-6＝新規テーブル判断、銀行口座＝非表示方針で対象外）は `docs/phase6-remaining-features-plan.md` §1参照。

| 2026-08-05 | Phase 6 | スライス6-2/6-3：運用ガイド（静的）＋テキストスニペット（localStorage）・依存ゼロ | — | ✅ |

**スライス6-2/6-3（運用ガイド＋スニペット）**：どちらもクライアント完結・サーバ/DB非依存。`OperationsGuide.tsx`＝権限/機能有効化/GRANT早見/デプロイ/安全設計の要点を画面内集約（設定＞運用ガイド・admin）。`TextSnippets.tsx`＋純関数`snippets-store.ts`（upsert/remove/filter/sanitize）＝定型文をlocalStorageに保存しコピー（作成＞スニペット・legal/requester）。新規GRANT・env・依存なし。クライアント純関数テスト追加。テスト394件。

| 2026-08-05 | Phase 6 | スライス6-4/6-5：アーカイブ表示分離（案件）＋契約チェック（作品条件の作成時点検・純関数）・依存ゼロ | — | ✅ |

**スライス6-4/6-5（アーカイブ＋契約チェック）**：どちらも依存ゼロ。6-4＝`MatterRegistry` で保管(`status='archived'`)を既定「すべて」から除外し「保管」チップを新設（案件のstatus編集は既存 `InlineMatterControls` を流用・grant 008）。6-5＝`contract-check.ts`（純関数 `checkWorkConditions`＝サブライセンス上流未リンク/MG無料率/方向欠落/受取素材未紐付け/条件名空 の作成時ルール、`summarizeFindings`）を `WorkDetail` の「契約チェック」タブで表示（4-1の横断スキャンとは別・条件単位）。新規GRANT・env・依存なし。クライアント純関数テスト追加。テスト400件。**これでPhase 6の依存ゼロ枠（6-1〜6-5）が完了**。残：稟議6-6（新規テーブル判断）・銀行口座（非表示方針で対象外）・設定拡張（サーバ永続化は要判断）。

| 2026-08-05 | Phase 3 | 棚卸し＋計画 → `docs/phase3-backlog-plan.md` | — | ✅ |
| 2026-08-05 | Phase 3 | スライス3-1：Backlog課題一覧→依頼画面（課題起点で文書作成・読取・既存env） | — | ✅ |

**スライス3-1（Backlog依頼取込・読取）**：`BacklogWebApiClient.getIssues({count,keyword})` を追加（projectId解決→`GET /issues`・防御的整形・APIキー非漏洩）。`integrations/backlog-routes.ts`＝`GET /api/v2/backlog/issues`（admin/legal・読取・未構成は`enabled:false`・API失敗は502）。app.tsは`BACKLOG_MODE=readonly`＋接続情報がある時のみクライアント構築（`defaultBacklogClient`）。UI `RequestsWorkspace.tsx`（業務＞依頼）＝課題を検索一覧し「この課題で文書作成」で issueKey を文書作成へ引き継ぐ（課題→リーガルリクエスト導線）。mock fetchでテスト。**新規GRANT・依存なし**（有効化は既存 `BACKLOG_MODE`/`BACKLOG_HOST`/`BACKLOG_PROJECT_KEY`/`BACKLOG_API_KEY`）。テスト405件。残：書き戻し（3-2コメント＝汎用で実装可・3-2bステータス/カスタム属性＝プロジェクト固有ID判断）・変数自動抽出（3-3）。

| 2026-08-05 | Phase 3 | スライス3-2：Backlogコメント書き戻し（guarded・確認トークン・新capability `backlog-comment`・BACKLOG_MODE=live非依存） | — | ✅ |

**スライス3-2（Backlogコメント書き戻し）**：`BacklogWriteClient.addComment(issueKey, content)`（`POST /issues/:key/comments`・ID非依存）。`POST /api/v2/backlog/issues/:key/comments`（admin/legal・確認トークン `COMMIT_BACKLOG_COMMENT`・未有効は503・API失敗502）。新capability **`backlog-comment`**（`BACKLOG_COMMENT_WRITE_ENABLED`）でPhase 1同型の5条件ゲート。**既存の `BACKLOG_MODE=live` ブロックは維持**し、コメント書き戻しは独立capability（readonly接続を維持しつつ明示有効化時のみ動作＝既存workerとの棲み分け）。config/app（gating・safe-write・writeCapabilities）・`verify-write-test.sh`（validation-only＋IAP＋readonly必須のcase＋scope）・`cloudbuild`（subs/verify/env）全結線（既定OFF・default検証で無影響確認）。UI `RequestsWorkspace` に capability-gated（`canBacklogComment`）なコメント投稿（確認ダイアログ）。テスト409件。残：ステータス/カスタム属性同期（3-2b・プロジェクト固有ID判断）・変数自動抽出（3-3）。

| 2026-08-05 | Phase 3 | スライス3-3：Backlog課題本文の変数自動抽出→文書フォーム非破壊シード（純関数・依存ゼロ） | — | ✅ |

**スライス3-3（変数自動抽出）**：`extract-variables.ts`（純関数 `extractVariables`＝「ラベル：値」「【ラベル】値」を解析し別名表 `DEFAULT_ALIASES` で正規フィールド名（PROJECT_TITLE/COUNTERPARTY/AMOUNT等）へ対応付け、`seedFormData`＝空欄のみ非破壊補完）。`getIssues` に `description` を追加。`RequestsWorkspace` が課題本文から抽出変数をプレビュー表示し「この課題で文書作成」で App へ引き継ぎ、`DocumentForm` の context 読込後に `seedFormData` でフォームを非破壊シード（下書き復元時はシードしない）。クライアント純関数テスト。**新規GRANT・依存なし**。テスト414件。**これで Phase 3 の主要スライス（依頼取込・コメント書き戻し・変数抽出）が完了**。残：ステータス/カスタム属性同期（3-2b・プロジェクト固有ID判断）。

| 2026-08-05 | Phase 5 | 点火レディネス・レビュー → `docs/phase5-integration-readiness.md`＋INTEGRATION_MODEブロッカー解消 | — | ✅ |

**Phase 5 レディネス・レビュー**：各外部連携（Drive/Gmail送受信/CloudSign/Slack）のコード監査。**最優先ブロッカーを解消**：`cloudbuild-write-test.yaml` がハードコードしていた `INTEGRATION_MODE=local`（Gmail送信/CloudSign/Slack配信の実送信を一律ブロック＝「停止中」の正体）を substitution `_INTEGRATION_MODE`（既定`local`）へ変更し、`verify-write-test.sh` で `live` を write-test＋IAP必須にガード（既定localは挙動不変・default検証パス）。コネクタ別の点火手順・残ギャップ（SA鍵マウントのDrive従属／CloudSign認証未確定／Gmail・CloudSignの冪等未実装／Gmail受信の登録導線無し／Slack候補フローの依頼者メール）・推奨順序（Drive→Gmail受信→Slack→Gmail送信→CloudSign）を `docs/phase5-integration-readiness.md` に集約。実トークン投入・DWD設定・CloudSign認証突合はオペレーター/要判断として残る。

| 2026-08-06 | Phase 3 | スライス3-2b-prep：Backlogプロジェクトメタデータ（statuses/customFields）読取API＋判断事項の確定 | — | ✅ |

**スライス3-2b-prep（メタデータ一覧API）＋判断確定**：3-2b（ステータス同期・カスタム属性更新）本体はプロジェクト固有IDが要るため、**まず実IDを確認する読取APIを先行実装**（判断：「まず一覧APIを追加」）。`BacklogReadClient.getProjectMetadata()`（`GET /projects/:key/statuses`・`/customFields`→`{statuses:[{id,name}], customFields:[{id,name,typeId}]}` に防御的整形）。`GET /api/v2/backlog/metadata`（admin/legal・読取・未構成は`{enabled:false}`・API失敗502）。`RequestsWorkspace` に「プロジェクトID一覧」トグル（オンデマンド読取専用表示）。**新規GRANT・依存なし**（読取のみ）。テスト420件。**判断事項を確定**：①**稟議(Ringi)＝保留/廃止**（V2へ移植せず、承認はSlack承認／案件ステータスで代替）②**製品(products)＝オプションA継続**（製品専用テーブルは新設せず既存エンティティで表現・DDL回避）。`docs/v1-v2-parity-checklist.md`／`docs/phase3-backlog-plan.md` に反映。3-2b同期本体は運用側が実IDを確認・マッピング確定後に別スライスで着手。

| 2026-08-06 | Phase 5 | スライス5-1：Gmail送信の冪等強制（append専用送信履歴 `lb_v2_gmail_send_history`・grant 019）＋dispatch二重送信防止 | — | ✅ |

| 2026-08-07 | Phase 5 | スライス5-2：Gmail受信の取込→登録導線（隔離台帳 `lb_v2_inbound_contracts`・grant 020・append＋status・冪等） | — | ✅ |

| 2026-08-07 | Phase 5 | スライス5-3：Slack依頼者宛先の二重エスケープ・バグ修正（`optionalEmail`）＋回帰テスト | — | ✅ |

| 2026-08-07 | Phase 5 | スライス5-6：CloudSign API契約をV1実装に突合して確定（gap ④解消・5-4のsecret想定は撤去） | LegalBridge_AI_GCP | ✅ |

| 2026-08-07 | Phase 5 | スライス5-7：CloudSign 送信堅牢化（冪等履歴 grant 022・cloudSignDocumentId永続化・宛先allowlist） | LegalBridge_AI_GCP | ✅ |

| 2026-08-07 | Phase 5 | 点火準備：CloudSign 点火 Runbook 新設＋gmail-cloudsign.md を確定仕様へ更新 | — | ✅ |

| 2026-08-10 | UX | B1（作成→出力の1画面化）実装：DocumentOutputActions を抽出し確定結果へインライン | LegalBridge_AI_GCP | ✅ |

**B1 実装**：文書の出力アクション（PDF生成・Drive保存・Gmail/CloudSign送信）を `DocumentOutputActions.tsx` に抽出。確定結果パネル（DocumentForm）にインライン化し、`documents` 一覧詳細への必須ジャンプ（従来4遷移・F8）を解消。同部品を DocumentRegistry 詳細ペインでも共用（DRY・重複ロジック削除）。DocumentForm に canGeneratePdf/canSaveToDrive/canGmailNotify/canCloudSign を配線。テスト545件緑・typecheck緑・build緑。UX 改善は Quick Wins Q1〜Q4・構造 R1〜R5・大物 B1 まで完了（残 B2＝新規画面に指針適用）。

| 2026-08-10 | UX | 構造リファクタ R2（条件面集約）・R3（作品二重解消）・R5（申請者ホーム分離）実装 | LegalBridge_AI_GCP | ✅ |

**R2/R3/R5 実装**：R2＝条件明細を正典ハブに `surface-xref`（役割ラベル付き相互リンク：閲覧＝条件明細／作成＝アウト条件／マスタ＝台帳金銭条件）、`ledgerSeedType` で台帳の該当タブを直接開く。R3＝作品ビュー（WorkDetail）と台帳「作品・原作」を役割明示＋相互リンクで整流（F5）。R5＝申請者（requester かつ非 legal）のホームを `RequesterHome`（文書作成・自分の文書・自分の下書き＋Backlog起票案内）に分離し、法務オペ俯瞰を見せない（法務/管理者は従来 Dashboard 維持）。テスト545件緑・typecheck緑・build緑。構造リファクタ R1〜R5 完了（R4 は標準確定＝新規画面適用）。

| 2026-08-10 | UX | 構造リファクタ R1（ナビ再編：業務10項目を分割）実装 ＋ R4（ガード階層 標準）確定 | LegalBridge_AI_GCP | ✅ |

**R1 ナビ再編（実装）**：`App.tsx navGroups` を タスクフロー優先の 概要／しごと（依頼・案件・文書・下書き・スニペット）／権利・条件（作品・条件明細・アウト条件）／お金（請求・債権マップ・支払報告・請求印刷・試算）／マスタ・設定（台帳・契約取込・データ品質・名寄せ×2・担当者・受信取込・管理・運用ガイド）へ再編。過積載だった「業務10項目」を主ループ／権利条件／財務に分割し、財務系を日常ループから隔離（F1 解消）。ロール別出し分けは維持。**R4 ガード階層 標準**：T3 不可逆/破壊＝プレビュー＋合言葉、T2 本番書込＝インライン確認、T1 低リスク/外部＝通常、の3ティアを `docs/v2-ux-rationality-review.md` に明文化し新規画面（Phase 10/11）へ適用（既存 retrofit は業務合意の上で個別）。テスト545件緑・typecheck緑・build緑。

| 2026-08-10 | UX | Quick Wins Q3（空状態の2ティア整流）・Q4（文書紐付け検索UI）実装 | LegalBridge_AI_GCP | ✅ |

**UX Quick Wins Q3/Q4 実装**：Q4＝案件詳細の文書紐付けを生ID入力から**デバウンス検索ピッカー**へ（`GET /documents?q=` を叩き候補クリックで POST 紐付け・紐付け済みは候補除外・`.doc-link-*` CSS 追加）＝F9 解消。Q3＝主要リストの空状態を `EmptyState` 箱に統一（DocumentRegistry/Requests/Draft/Ledger/TemplateCatalog）、表内・ローディング等のインライン注記は軽量 `.empty-state` を下位ティアとして維持し「意図した2ティア」に整流＝F7 緩和。テスト545件緑・typecheck緑・build緑。Quick Wins Q1〜Q4 完了。

| 2026-08-10 | UX | Quick Wins Q1（発見→是正の prop 配線）・Q2（未有効化メッセージ統一＋GRANT番号除去）実装 | LegalBridge_AI_GCP | ✅ |

**UX Quick Wins 実装**：Q1＝データ品質の重複ドリルが名寄せ画面へ統合元IDを引き継ぐよう配線（`data-quality/repository.ts` の vendor-merge link に `id` 付与、`DataQuality.onNavigate(view,id)`、`App` に `mergeSourceSeed`→`VendorMerge/MatterMerge` の `initialSource` 配線、ナビ直接遷移では seed クリア）＝発見と是正を1動線化。Q2＝`FeatureLockedNote.tsx` を新設して未有効化注記を統一し、VendorMerge/MatterMerge/WorkDetail の end-user 文言から GRANT 番号（018/025/026/028/007）と capability 名を除去。テスト545件緑・typecheck緑・build緑。

| 2026-08-10 | UX | V2 UI/UX 合理性レビュー（V1 の迷いの構造監査＋V2 現状 IA 監査を統合・改善指針化） | LegalBridge_AI_GCP | ✅ |

**UI/UX 合理性レビュー（`docs/v2-ux-rationality-review.md`）**：V1 の「迷いの構造」を 5 類型化（作業オブジェクト三重帳簿・暗黙モードの入口乱立・用語不整合・ロール未分岐・巨大マルチ目的画面）し、V2 現状 IA を並列監査して統合。V2 は既に主要な V1 病を治療済み（案件へ正典化・文書作成 funnel 統一・破壊操作トークン型統一・ロール一級市民化・Breadcrumb）＝維持資産として明記。残摩擦 F1〜F9（業務グループ過積載/OFF機能の伝え方3系統/GRANT番号露出/発見→是正断絶/条件・作品の画面分散/ガード重み付け不揃い/空状態2系統/作成→出力4遷移/生ID入力）を洗い出し、実タスクフロー（申請者・法務・管理者）に立脚した設計原則6点と、Quick Wins（Q1発見→是正prop配線・Q2未有効化統一＋GRANT番号除去・Q3空状態一本化・Q4文書検索UI）／構造リファクタ（R1ナビ再編・R2条件集約・R3作品二重解消・R4ガード階層化・R5ロール別ホーム）／大（B1作成→出力1画面化・B2 Phase10/11新規UIへ本指針適用）を優先度・粒度付きで提案。機能ギャップ台帳と対になる体験台帳。

| 2026-08-10 | 監査/S-B | grant 039（vendors.is_active 列追加＋documents.updated_at/drive_link 列 GRANT＋追記専用台帳の明示 REVOKE） | LegalBridge_AI_GCP | ✅ |

**S-B grant 039**（SQL のみ・本番適用待ち）：①P0-2＝`vendors.is_active` は V1 スキーマに存在しない（11-3 の「grant 009 で付与済み」は誤り・phase11 doc を訂正）→ `ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`（PG11+ fast default・書換なし・既存全件有効のまま。UPDATE 権限は grant 009 のテーブルレベルが新列に及ぶ）。②P0-6＝`GRANT UPDATE (updated_at, drive_link) ON documents`（CloudSign executed 遷移・満了ジョブ・Drive リンク添付が SET する列。未付与だと 42501 が「grant 未適用」と区別不能な恒久 forbidden 誤報）。③P1-15＝追記専用台帳5表（void/reissue/excel/webhook/job-alert）へ UPDATE/DELETE/TRUNCATE を明示 REVOKE（実在するテーブルのみ動的適用・未作成はスキップ）。トランザクション内に事後検証 DO ブロック（列・GRANT・REVOKE が期待どおりでなければ全体 ROLLBACK）。preflight は列存在／documents 列 GRANT 現状／台帳権限／vendors 行数を読取専用で確認。token `GRANT_PRODUCTION_CUTOVER_FIXES`。コード変更なし＝テスト 643 緑のまま。

| 2026-08-10 | 監査/S-A | 載せ替え前総点検（3観点並列監査→P0×11/P1×18/P2×23 台帳化）＋緊急止血 S-A（P0-5/7/8/9/11 修正） | LegalBridge_AI_GCP | ✅ |

**総点検＋S-A**：移植漏れ／UX 合理性／DB スキーマ矛盾の3観点を並列監査し `docs/cutover-readiness-audit.md` に恒久化（P0 必修11・P1 推奨18・P2 台帳外の移植漏れ23〈U1 Slack インテーク受信口ほか・要業務判断〉・クリーン確認領域）。**S-A（緊急止血）を即日実施**：①P0-5 void の NULL 述語→`IS DISTINCT FROM`＋rowCount 検査で「イベントだけ取消して文書生存」の半完了を遮断（legacy NULL 行テスト追加）。②P0-7 契約マスタ setStatus を lifecycle_stage のみ更新に（contract_status は V1 文書語彙の legacy 列＝V2 語彙で汚染しない。テスト期待値を据え置き検証に変更）。③P0-8 台帳作品編集の NaN バグ→`work:` プレフィックス解析・`source_ip:` 行は編集非表示。④P0-9 契約マスタ状態変更を2段階確認（確認バナー・満了/解約/中止は警告付き・enum 外の V1 値は素通し表示）＋「取消」→「キャンセル」。⑤P0-11 設定キーを V1 が実読する `COMPANY_INVOICE_NO` に統一。**即時緩和：`DOCUMENT_REISSUE_ENABLED=false`＋scope 除去を要デプロイ操作**（P0-1 再発行の残高消滅が未修正のため、S-D 完了まで点火禁止）。テスト643件緑・typecheck緑・build緑。残：S-B grant 039（is_active 列追加＋updated_at/drive_link GRANT）→S-C 文書ライフサイクル整合→S-D 再発行 repoint 再設計→S-E/S-F。

| 2026-08-10 | Phase 11 | 11-4 契約マスタ CRUD（登録は intake 既存・今回 既存契約の列単位更新＋ライフサイクル状態変更・grant 038） | LegalBridge_AI_GCP | ✅ |

**11-4 契約マスタ CRUD**：調査で契約の新規登録(INSERT)は contract-intake（`contracts/intake-repository.ts`）が既に担うと確認＝実ギャップは既存 contracts 行の中核項目編集とライフサイクル状態変更。`contract-master-schema`（`LIFECYCLE_STAGES` 9値・`contractUpdateSchema` 全 optional の部分更新〈表題/有効期間/自動更新/更新通知・アラート月数/レビュー期日〉・`contractStatusSchema`）。**バグ修正**：`.optional().transform()` は optional の undefined でも transform が走り省略キーを null 化して出力に足す＝部分 PATCH が他列を潰す。transform を `v===undefined?undefined:...` にガードして省略キーを省略のまま維持（テストで検出）。grant 038（`contracts` に**列単位 UPDATE** 9列のみ・全列/DELETE なし・SELECT/primary_vendor_id は 006/018 既存・token `GRANT_PRODUCTION_CONTRACT_MASTER`・V1 既存表 CREATE せず）。`contract-master-repository`（Pg/Memory・list〈ILIKE 検索・42P01 は Pg 例外そのまま〉/find/update〈FIELD_COLUMNS 動的 assignment・存在キーのみ〉/setStatus〈lifecycle_stage 正・legacy contract_status も同値〉）。routes（`GET /contracts` admin/legal＋`PATCH /contracts/:id`／`PATCH /contracts/:id/status` guarded・42501→FORBIDDEN_DB・NOT_FOUND→404）。config `CONTRACT_MASTER_WRITE_ENABLED`／app.ts（gating・scope `contract-master`・safe-write `PATCH /contracts/:id(/status)`・writeCapabilities 両所・OR-chain）／verify（write-test＋IAP/IAM＋正準順 workflow-rules 直後）／cloudbuild 全結線。UI `ContractMasterWorkspace`（マスタ・設定＞契約マスタ・admin/legal）＝一覧＋検索・行内インライン編集（表題/有効期間/自動更新）・状態はセレクトで即時変更（capability 有効時のみ・未有効は FeatureLockedNote）。テスト642件緑・typecheck緑・build緑。**Phase 11 cutover Tier 1（設定・承認ルート・台帳/契約マスタ・原作マテリアル）完了**。残 11-6〜11-9（優先低・Ringi 保留）。点火：grant 038＋`_CONTRACT_MASTER_WRITE_ENABLED=true`＋`_WRITE_SCOPES` に `contract-master`。

| 2026-08-10 | Phase 11 | 11-5 原作マテリアル登録（WorkDetail 素材タブに原作起点の追加/編集 UX・materials write 既存再利用・grant不要） | LegalBridge_AI_GCP | ✅ |

**11-5 原作マテリアル登録**：調査で materials write（work_materials・create は work_id 必須＝作品スコープ）が Phase 4 で実装済みと判明。素材タブ読取のみだったのは UI。V1 の「原作→素材起点で作成/編集」の実体＝作品詳細から素材を追加/編集する UX を補完。`WorkDetail` の素材タブに `canEditMaterials`（既存 materials capability）有効時のみ「素材を追加/編集」フォーム（現在作品 id を workId に `POST /materials`、更新は `PATCH /materials/:id`・素材名/種別/役割/取得/権利/権利者/備考/ロイヤリティ対象トグル）。**新規 grant/config/endpoint なし**（既存 API を作品起点で呼ぶだけ）。見送り：安全削除（work_materials に is_active 無し＝DELETE grant＋参照チェックが要る別スライス）、金銭条件付帯必須のハード強制（現状 isRoyaltyBearing フラグまで）。テスト631件緑・typecheck緑・build緑。**Phase 11 cutover Tier 1（設定・マスタ・承認ルート・原作起点マテリアル）主要導線完了**。残 11-4 契約CRUD。

| 2026-08-10 | Phase 11 | 11-2 承認ルート（department_workflow_rules を部門別 upsert・grant 037） | LegalBridge_AI_GCP | ✅ |

**11-2 承認ルート**：部門ごとの承認者/押印担当/責任者の Slack ID・部署チャンネル・有効フラグを管理。共有 `department_workflow_rules`（department UNIQUE・V1 の通知/承認ルーティングも参照）を V2 が upsert。`workflow-rules-schema`（department 必須・Slack ID は U/W/C 形式か空）／grant 037（SELECT/INSERT/UPDATE＋seq USAGE・DELETE なし・token `GRANT_PRODUCTION_WORKFLOW_RULES`・V1 既存表 CREATE せず）／`workflow-rules-repository`（Pg/Memory・list〈42P01 空縮退〉/upsert〈ON CONFLICT department・42501 throw〉）／routes（`GET /workflow-rules` admin＋`POST /workflow-rules` guarded admin・42501→FORBIDDEN_DB）。config `WORKFLOW_RULES_WRITE_ENABLED`／app.ts（gating・scope `workflow-rules`）／verify（write-test＋IAP/IAM＋正準順）／cloudbuild 全結線。UI `WorkflowRulesWorkspace`（マスタ・設定＞承認ルート・admin）＝部門別一覧＋編集（Slack ID/チャンネル/有効・新規部門・capability 有効時のみ保存）。閲覧は grant/フラグ不要・編集のみ点火要。V2 ルーティングの参照配線は将来。テスト631件緑。残 11-5 マテリアル登録／11-4 契約CRUD。

| 2026-08-10 | Phase 11 | 11-3 台帳マスタ CRUD（調査で過大計上判明・Create/Update 既存＝未有効化／今回 vendor 論理削除 is_active 追加・grant不要） | LegalBridge_AI_GCP | ✅ |

**11-3 台帳マスタ CRUD**：調査の結果、gap 台帳 11-3 は自動監査が読取専用 `/ledgers/:type` ファサードのみを見た**過大計上**と判明。実際には Create/Update は Phase 2/4/8 で実装済み（vendors/works/staff/materials の write-*）。ただし**現行デプロイの WRITE_SCOPES 未収載＝未有効**（cutover 時に有効化＝デプロイ設定であってコードではない）。唯一の実ギャップ＝取引先の論理削除（作品は有効/無効トグル既存）。本スライスで `vendors` の create/update に `isActive`（既定true）を追加（schema／COLUMNS is_active／find が is_active 返却）＝**新規 GRANT 不要**（`vendors.is_active` は grant 009 で付与済・名寄せが既に使用）。UI は LedgerWorkspace の取引先編集に「有効/無効」トグル追加（作品と同型）。cutover での「マスタ書込」解禁は WRITE_SCOPES に `vendors`/`works`/`materials`/`staff` ＋各 `*_WRITES_ENABLED`＋既存 GRANT を有効化するだけ。テスト624件緑・typecheck緑・build緑。残 11-2 承認ルート／11-4 契約CRUD／11-5 マテリアル登録。

| 2026-08-10 | Phase 11 | 11-1 システム設定（会社プロファイルを共有 app_settings に allowlist 編集・grant 036） | LegalBridge_AI_GCP | ✅ |

**11-1 システム設定**：cutover Tier 1（運用自立）の第一歩。共有 `app_settings`（key/value JSONB・V1 も参照）を V2 が所有・編集。**安全のため編集キーは会社プロファイル（自社情報・非機密）に allowlist**（連携トグル/秘密は env 管理のまま対象外）。`settings-schema`（COMPANY_PROFILE_FIELDS＋allowlist＋zod・外キー400）／grant 036（app_settings に SELECT/INSERT/UPDATE・upsert 用・token `GRANT_PRODUCTION_APP_SETTINGS`）／`settings-repository`（Pg/Memory・get〈JSONB→文字列・42P01 空縮退〉/save〈ON CONFLICT DO UPDATE・42501 throw〉）／routes（`GET /settings` admin＋`POST /settings` guarded admin・allowlist・42501→FORBIDDEN_DB）。config `SETTINGS_WRITE_ENABLED`／app.ts（gating・scope `settings`・writeCapabilities）／verify（write-test＋IAP/IAM＋正準順）／cloudbuild 全結線。UI `SettingsWorkspace`（マスタ・設定＞システム設定・admin）＝会社プロファイル編集（capability 有効時のみ保存・変更キーのみ送信・未有効は閲覧のみ）。閲覧は grant/フラグ不要・編集のみ点火要。V2 レンダリングへの差込は将来スライス。テスト623件緑・typecheck緑・build緑。`docs/phase11-settings-master.md` 新設。残 11-2 承認ルート／11-3 台帳CRUD／11-4 契約CRUD／11-5 マテリアル登録。

| 2026-08-10 | Phase 10 | 10-5 Excel 一括出力（種別×担当者×支払期日で集計→client Excel生成・発行済みは隔離台帳 grant 035） | LegalBridge_AI_GCP | ✅ |

**10-5 Excel 一括出力**：検収書・利用許諾料計算書を「種別×担当者×支払期日」で束ねて Excel 化。V1 はサーバ xlsx 生成→Drive 保存＋`documents.excel_issued_at` 管理だが、V2 は**帳票生成を client（依存ゼロ export-util）で行い発行済みは隔離台帳で管理**（本番列不変）。`excel-batch-engine`（純関数 `deriveExcelGroupKey`/`groupExcelBatches`）／grant 035（`lb_v2_excel_export_ledger`・document_number 一意・append-only）／`excel-batch-repository`（loadPending＝inspection_certificate*/royalty_statement・final・正本・void除外・台帳未載＝未発行・42P01縮退／markExported＝ON CONFLICT DO NOTHING）／routes（`GET /documents/excel-batches` 読取 admin/legal＋`POST /documents/excel-batches/mark` guarded capability `excel-batch`・確認トークン不要・42501=FORBIDDEN_DB・read は :id より前にマウント）。config `EXCEL_BATCH_ENABLED`／app.ts（gating・scope `excel-batch`・writeCapabilities）／verify（write-test＋IAP/IAM＋正準順）／cloudbuild 全結線。UI `ExcelBatchWorkspace`（お金＞Excel一括）＝グループ一覧・Excel出力（client）＋発行済みマーク。**集計＋Excel出力は grant/フラグ不要で即利用可**、発行済み記録のみ点火要。テスト616件緑・typecheck緑・build緑。**Phase 10 完了**（10-1/10-1b/10-2/10-3/10-4/10-5/10-6）。

| 2026-08-10 | Phase 10 | 10-4 一括無効化（bulk void・document-void ケーパビリティ＆grant 033 共用・新規 grant なし） | LegalBridge_AI_GCP | ✅ |

**10-4 一括無効化**：V1 の bulk-delete（ハード削除＋force カスケード）は V2 のソフト void 方針と合わないため、複数文書の一括 void として実装。**既存 document-void ケーパビリティ・grant 033 を共用＝新規 grant/config/scope なし**（現行デプロイで既に有効）。`documentVoidBulkSchema`（ids 1..200）／`voidMany`（各 id 個別 tx で void→voided/already/not_found/error を集計・**FORBIDDEN_DB は全体中断**・重複 id は集約・共通 `runVoidMany` を Pg/Memory 共用）／`POST /documents/void-bulk`（admin/legal・確認トークン `COMMIT_DOCUMENT_VOID`）。app.ts safe-write ガードに `/documents/void-bulk` 追加。UI は DocumentRegistry にチェックボックス列（void 済み除外）＋全選択＋一括無効化バー（合言葉＋理由・結果集計トースト）。一括項目更新（bulk-update-fields）は form_data 広範 UPDATE 権限が必要で優先低のため将来拡張。テスト609件緑・typecheck緑・build緑。残 10-5 Excel一括。

| 2026-08-10 | Phase 10 | 10-1b 文書再発行（新版 <base>-R<n> 採番＋旧版 supersede＋旧版実績取消・grant 034・guarded） | LegalBridge_AI_GCP | ✅ |

**10-1b 文書再発行**：既存確定文書を基に新版 `<base>-R<n>` を採番して発行し、旧版を lifecycle_status='reissued'・is_primary=FALSE・superseded_by=新番号 に倒す guarded-write。**V2 の残高は condition_events.voided_at IS NULL のみで判定し文書 lifecycle では絞らない**（conditions/repository.ts で確認）ため、旧版の有効実績を同一トランザクションで取消して二重計上を防ぐ（void 10-2 と同じ列 UPDATE 再利用）。grant 034＝列レベル `UPDATE(lifecycle_status, is_primary, superseded_by) ON documents`＋`UPDATE(voided_at, void_reason) ON condition_events`（033再掲）＋隔離台帳 `lb_v2_document_reissue_ledger`（INSERT は 006 表レベルで既付与）。`nextReissueNumber`（純関数・系列最大版+1）／repository（source FOR UPDATE→voided は409→系列ロック→新版INSERT〈final/primary〉→系列他行 is_primary=false→旧版 reissued＋superseded_by→旧版実績取消→台帳・42501=FORBIDDEN_DB）／routes（`POST /documents/:id/reissue`・admin/legal・確認トークン `COMMIT_DOCUMENT_REISSUE`・既定OFF503・404/409/503・Backlog 書戻しは backlog-comment 有効時のみ）。config `DOCUMENT_REISSUE_ENABLED`／app.ts（gating・safe-write scope `document-reissue`・writeCapabilities）／verify（validation-only＋本番DB＋IAP/IAM＋WRITE_SCOPES 正準順）／cloudbuild 全結線。UI は DocumentRegistry 詳細に「再発行」ゾーン（capability-gated・合言葉＋理由・成功で新版へ切替）。carryover（旧実績の引継ぎ）は未実装＝将来拡張。テスト605件緑・typecheck緑・build緑。残 10-4 一括／10-5 Excel一括。

| 2026-08-10 | Phase 10 | 10-1 文書アーカイブ（状態フィルタ／PDF未生成キュー／バージョン履歴を DocumentRegistry に集約・読取・grant不要） | LegalBridge_AI_GCP | ✅ |

**10-1 文書アーカイブ**：V1 の別ページ ArchivePage を新設せず、V2 で既にアーカイブを担う `DocumentRegistry` に機能を集約（UX 重複回避）。①状態フィルタ＝`registry-repository.list` に `lifecycle`（all/active/voided）を追加し `GET /documents?lifecycle=` で切替（Pg/Memory）。UI に「すべて／有効のみ／無効化のみ」セレクト。②PDF未生成キュー＝UI トグルで一覧ソースを `GET /documents/pending-pdf`（10-6）へ切替。③バージョン履歴＝`registry-repository.versionHistory(id)`（同一 `base_document_number` 系列を古い順・Pg/Memory）＋`GET /documents/:id/history`（lookup ルーター配置で `/documents/:id` に吸われない）。UI は詳細ペインに系列を表示し各版クリックで切替（正本/旧版/無効化バッジ・単一版なら非表示）。**新規 grant/config なし（すべて読取）**。再発行（reissue・write）は列レベル GRANT＋確認トークンが要るため 10-1b に分離。テスト597件緑・typecheck緑・build緑。残 10-1b 再発行／10-4 一括／10-5 Excel一括。

| 2026-08-10 | Phase 10 | 10-6 文書ルックアップ（番号検索／PDF未生成一覧／次番号プレビュー・読取専用・grant不要） | LegalBridge_AI_GCP | ✅ |

**10-6 文書ルックアップ**：発行後運用の下支えとなる読取ユーティリティ3種（すべて SELECT のみ＝新規 GRANT/config なし）。①`registry-repository.findByNumber` 追加。②`document-lookup-repository`（Pg/Memory）＝`pendingPdf`（Drive 未保存かつ void でない文書の一覧＋種別別件数＝PDF未生成キュー）と `peekNextNumber`（**非破壊**の次番号プレビュー・V1 は document_sequences を増分するが V2 は採番を消費しない）。採番接頭辞・番号組み立ては finalize と共用の純関数 `resolveNumberPrefix`/`formatDocumentNumber` に集約（finalize の findPrefix もこれへ委譲・挙動不変）。③`document-lookup-routes`＝`GET /documents/by-number/:docNumber`／`/documents/pending-pdf`／`/documents/numbering/next?type=`。`/documents/:id`（registry）に吸われないよう registry より前にマウント。稟議リンク（Ringi=保留）と mark-as-imported（取込フロー責務）は対象外。UI 統合は 10-1 アーカイブ画面で実施予定。テスト594件緑・typecheck緑・build緑。残 10-1 アーカイブ画面／10-4 一括／10-5 Excel一括。

| 2026-08-10 | Phase 10 | 10-3 PDF 再生成（保存データ＋現行テンプレで再レンダ→Drive 既存ファイル上書き更新・grant/config不要） | LegalBridge_AI_GCP | ✅ |

**10-3 PDF 再生成**：ダウンロード用 PDF（`GET /documents/:id/pdf`）は常に再レンダリングされるため既に「再生成」済み。欠けていた **Drive 保存済みコピーの更新**を解消する（既存 `POST /documents/:id/drive` は driveLink があると再利用し、データ／テンプレート変更後も Drive が古いままになっていた）。`drive-storage.updatePdf({fileId,pdf})`＝Drive v3 media PATCH で**既存ファイルの中身のみ差し替え**（リンク/ID 維持・Google/Memory 両実装）。`POST /documents/:id/drive/regenerate`＝再レンダ→既存ファイルあれば上書き（200・リンク維持）/なければ新規アップロード（201・created:true）。**既存 drive scope に従属＝新規 grant/config なし**。app.ts の safe-write ガードを `/documents/:id/drive(/regenerate)?` に拡張。UI は `DocumentOutputActions` に「PDFを再生成（Drive更新）」ボタン（Drive 保存済み時のみ）。型修正：Buffer(ArrayBufferLike) は BodyInit 非互換のため `new Uint8Array(pdf)` でラップ。テスト587件緑・typecheck緑・build緑。残 10-6 ルックアップ／10-1 アーカイブ画面／10-4 一括／10-5 Excel一括。

| 2026-08-10 | Phase 10 | 10-2 文書 void（無効化＋実績取消で残高復元・grant 033・列レベルUPDATE＋隔離監査台帳） | LegalBridge_AI_GCP | ✅ |

**10-2 文書 void**：発行後運用の第一歩。V1（`services/worker/server.ts` の `/api/documents/:id/void`）と同じく、文書を `lifecycle_status='voided'`・`is_primary=FALSE` にし、**同一トランザクションで**紐づく有効実績 `condition_events` を `voided_at`/`void_reason` で取消して残高を復元する。grant 033＝列レベル `UPDATE(lifecycle_status, is_primary) ON documents` ＋ `UPDATE(voided_at, void_reason) ON condition_events`＋隔離監査台帳 `lb_v2_document_void_ledger`（CREATE＋GRANT SELECT/INSERT・append-only・行削除は不可）＋preflight。`document-void-repository`（Pg/Memory・SELECT FOR UPDATE→既voidは alreadyVoided で副作用なし→更新→RETURNING で影響明細ID集計→台帳記録・42501 は FORBIDDEN_DB[503]）／`document-void-routes`（`POST /documents/:id/void`・admin/legal・確認トークン `COMMIT_DOCUMENT_VOID`・既定OFFは503・Backlog 書戻しは backlog-comment 有効時のみベストエフォート）／schema。config `DOCUMENT_VOID_ENABLED`／app.ts（gating・safe-write scope `document-void`・writeCapabilities）／verify（validation-only＋本番DB＋IAP/IAM＋WRITE_SCOPES 正準順）／cloudbuild（subs/export/ENVVARS）全結線。読取は `registry-repository` の一覧・詳細に `lifecycle_status` を追加。UI は `DocumentRegistry` に無効化バッジ＋void 危険操作ゾーン（capability-gated・合言葉＋理由）。`docs/phase10-document-operations.md` 新設・gap台帳更新。テスト584件緑・typecheck緑・build緑。残 10-3 PDF再生成／10-1 アーカイブ画面／10-6 ルックアップ／10-4 一括／10-5 Excel一括。

| 2026-08-10 | Phase 9 | 点火ランブック整備（Cloud Scheduler／Webhook・GRANT 030-032／secret／再デプロイ／smoke／到達性判断） | — | ✅ |

**Phase 9 点火ランブック**：`docs/phase9-automation-ignition.md` を新設。Profile D 上乗せで自動化基盤を点火する実行手順を集約。①構成マップ（各 runner／Webhook のエンドポイント・起動方法・必要 GRANT／フラグ・破壊性）。②GRANT 030（督促台帳）／032（Webhook 台帳）／031（契約状態 UPDATE・preflight 付き）の冪等適用（最小構成＝030 のみで督促＋検収が本番不変で回る）。③共有シークレット（`JOBS_TRIGGER_TOKEN`／`CLOUDSIGN_WEBHOOK_TOKEN`／`BACKLOG_WEBHOOK_TOKEN`）を Secret Manager 作成＋secretAccessor 付与。④Profile D の `^|^` substitutions 末尾へ `_JOBS_ENABLED`／`_JOBS_TRIGGER_TOKEN_SECRET`（＋任意で満了遷移・Webhook）を上乗せ再デプロイ。⑤Cloud Scheduler 3 ジョブ（daily-checks 平日09:00／inspection-digest 平日09:05／cloudsign-sync 3h毎）を **OIDC＋X-Jobs-Token 二重**で登録。⑥手動 curl スモーク（summary 確認・401/404 の認可確認）。⑦**重要な到達性判断**：外部 Webhook は Google OIDC を提示できず `--no-allow-unauthenticated` では Cloud Run IAM 層で 403 になるため、専用公開経路／API Gateway を用意するか、**当面 cloudsign-sync（ポーリング）で代替**（検証フェーズ推奨）を明記。⑧個別停止・ロールバック・トラブルシュート表。plan 側のデプロイ節から本ランブックへ導線。ジョブは即点火可・Webhook は到達性決定後。

| 2026-08-10 | Phase 9 | 9-6 CloudSign 一括ステータス同期（未確定依頼を fetchStatus で後追い更新・締結→契約 executed・grant追加なし） | LegalBridge_AI_GCP | ✅ |

**9-6 CloudSign 一括ステータス同期**：Webhook(9-5)の取りこぼし・遅延に対する保険として、未確定の署名依頼を一括で後追い照会する。①`cloudsign-request-repository.ts` に `listPending(limit)` を追加（terminal=`completed`/`canceled` を除外・古い順・grant 022 の SELECT 再利用・終端集合は `CLOUDSIGN_TERMINAL_STATUSES` として公開）。②`jobs/cloudsign-sync-runner.ts` `runCloudSignSync`＝未確定依頼を既存 `CloudSignAdapter.fetchStatus`（`CloudSignApiAdapter`/`FetchCloudSignApiClient` 再利用）で照会し、状態変化があれば `updateStatus`（grant 022 UPDATE）、締結なら契約 executed（**9-5 と同じ `contract-status-writer`・grant 031 再利用**・42501 は forbidden で継続）。live 未構成なら no-op（`configured:false`）、個別照会失敗はジョブを止めず `failed` に計上。summary＝`{configured,scanned,updated,unchanged,completed,contractExecuted,contractForbidden,failed}`。③app.ts は CloudSign live（`CLOUDSIGN_MODE=live`＋client_id＋baseUrl）かつ送信履歴台帳（`cloudSignRequestHistoryEnabled`）がある時のみ runner `cloudsign-sync` を登録（`POST /internal/jobs/cloudsign-sync`）。**新規 grant/config/infra なし**（`JOBS_ENABLED` と既存 CloudSign ゲートに従属）。テスト577件緑・typecheck緑・build緑。**Phase 9 自動化基盤コア（督促・満了・検収・Webhook 双方向・後追い同期）完了**。

| 2026-08-10 | Phase 9 | 9-5/9-7 Webhook 受信ハンドラ（CloudSign 締結→契約 executed／Backlog 課題→Slack 通知・grant 032・べき等） | LegalBridge_AI_GCP | ✅ |

**9-5/9-7 Webhook 受信ハンドラ**：外部（CloudSign/Backlog）からの Webhook を受ける。①**純関数パーサ** `internal/webhook-parsers.ts`＝`parseCloudSignEvent`（documentID＋status 1/2/3＋text → completed/declined/sent/other・untrusted を型安全抽出・判別不能は null）／`parseBacklogIssueCreated`（type=1 の課題追加のみ・issueKey=projectKey-key_id 合成）。②**べき等台帳** grant 032＝`lb_v2_webhook_receipts`（CREATE＋GRANT SELECT/INSERT・(source,external_id) UNIQUE・token `GRANT_PRODUCTION_WEBHOOK_RECEIPTS`）＋`internal/webhook-receipts-repository.ts`（`recordIfFirst`＝INSERT ON CONFLICT DO NOTHING→初回のみ true・Pg/Memory）。③**契約状態ライタ** `documents/contract-status-writer.ts`＝`markExecuted`（draft/awaiting_signature→executed・**9-3 の grant 031 を再利用**・42501 は forbidden で受信自体は成功）。④**ハンドラ** `integrations/webhook-handlers.ts`＝`createCloudSignWebhookHandler`（べき等化→送付履歴 `updateStatus`→締結時に契約 executed・未知/二重/判別不能は 200 skip）／`createBacklogWebhookHandler`（べき等化→Slack live 時のみ法務相談チャンネルへ新規依頼通知）。app.ts は DB があれば handler を自動構築し `createWebhooksRouter` へ注入（token 未設定＝webhooks-routes が 404 で自動無効）。verify/cloudbuild に `_CLOUDSIGN_WEBHOOK_TOKEN_SECRET`／`_BACKLOG_WEBHOOK_TOKEN_SECRET`（既定 BLOCKED・設定時のみ Secret Manager から `CLOUDSIGN_WEBHOOK_TOKEN`／`BACKLOG_WEBHOOK_TOKEN` をマウント・write-test 限定）。テスト571件緑・typecheck緑・build緑。残 9-6 CloudSign 一括ステータス同期。

| 2026-08-10 | Phase 9 | 9-4 検収待ちダイジェスト（既存 pending-inspections を集計し Slack 投稿・grant不要・dry-run既定） | LegalBridge_AI_GCP | ✅ |

**9-4 検収ダイジェスト**：`jobs/inspection-digest-runner.ts`＝既存 `PendingInspectionRepository`（検収書未作成の発注書・documents SELECT・**新規grant不要**）を読み、`composeInspectionDigest`（件数＋文書番号/案件/課題・上限20行＋「他N件」）で1通に集約して Slack へ投稿。台帳/重複抑止なし（毎回スナップショット）。app.ts に runner `inspection-digest` 登録（Slack live なら matterSlackChannelAdapter で投稿・それ以外 dry-run・0件は無投稿）。テスト563件緑・typecheck緑・build緑。残 9-5・9-7 Webhook／9-6 一括同期。

| 2026-08-10 | Phase 9 | 9-3 満了ステータス自動遷移（grant 031・列レベル UPDATE・専用フラグ＋確認・42501は継続） | LegalBridge_AI_GCP | ✅ |

**9-3 満了遷移**：daily-checks の最後に満了契約を expired へ自動遷移（本番 `documents.contract_status` UPDATE）。grant 031＝`documents` 列レベル UPDATE(contract_status) のみ＋preflight（遷移見込み件数を表示）。repo に `loadExpiryCandidates`（満了日超過かつ draft/awaiting_signature/executed）／`transitionExpired`（遷移可能状態を再確認して UPDATE・terminated 除外・**42501=grant未適用は forbidden で返しジョブ継続**）。runner は `CONTRACT_EXPIRY_TRANSITION_ENABLED`（既定OFF）時のみ実行し summary に expiredTransitions/expiryForbidden。verify/cloudbuild に `_CONTRACT_EXPIRY_TRANSITION_ENABLED`／`_CONFIRM_CONTRACT_EXPIRY`＋ゲート（JOBS_ENABLED 必須・production DB・IAP/IAM）。テスト558件緑・typecheck緑・build緑。残 9-4 検収ダイジェスト／9-5・9-7 Webhook／9-6 一括同期。

| 2026-08-10 | Phase 9 | 9-1c 実送信（LiveDailyChecksNotifier＝Slack 法務相談チャンネルへダイジェスト投稿） | LegalBridge_AI_GCP | ✅ |

**9-1c 実送信**：`jobs/daily-checks-live-notifier.ts`＝`LiveDailyChecksNotifier`。督促を法務相談チャンネルへ1通のダイジェスト（`:bell: 本日の督促（N件）` ＋ 箇条書き）として投稿し、既存 `matterSlackChannelAdapter` を再利用。投稿成功で全件 delivered→台帳記録、失敗で全件未達→次回再送（all-or-nothing）。app.ts は Slack live 設定（SLACK_DELIVERY_MODE=live＋xoxb トークン＋法務相談チャンネル）なら Live、それ以外は Dry-run を daily-checks runner へ注入。宛先DM（申請者個別）は email→Slack ID 解決が要るため将来拡張。テスト555件緑・typecheck緑・build緑。残 9-3 満了遷移／9-4 検収ダイジェスト／9-5・9-7 Webhook／9-6 一括同期。

| 2026-08-10 | Phase 9 | 9-1b/9-2 daily-checks 配線（隔離台帳 grant 030・repo・runner・dry-run 既定・jobs 起動口配線） | LegalBridge_AI_GCP | ✅ |

**9-1b/9-2 実装**：督促ジョブ本体を配線。grant 030＝`lb_v2_job_alert_ledger`（CREATE＋GRANT 自己完結・SELECT/INSERT・(kind,ref_type,ref_id,alert_date) UNIQUE で同日重複抑止）。`jobs/daily-checks-repository.ts`（Pg/Memory）＝候補読取（condition_lines[legacy_role='cli']×documents[record_type='purchase_order']・condition_line_status_v で全量検収除外・**本番は更新せず台帳の最新 alert_date を lastAlertAt として渡す**・権限未整備は空縮退）＋recordAlerts（ON CONFLICT DO NOTHING）。`jobs/daily-checks-runner.ts`＝エンジンで発火判定→通知→**live のみ台帳へ記録**（dry-run は記録せず件数のみ返す）＋`DryRunDailyChecksNotifier`（既定・安全）。app.ts の `/internal/jobs/daily-checks` runner を登録（既定 dry-run）。verify/cloudbuild に `_JOBS_ENABLED`/`_JOBS_TRIGGER_TOKEN_SECRET`（Secret 注入）＋ゲート追加。テスト552件緑・typecheck緑・build緑。実送信（live ノーティファイア）と満了遷移(9-3)・Webhook(9-5/9-7)は後続。

| 2026-08-10 | Phase 9 | 自動化基盤 9-0（スケジューラ/Webhook 受信口・共有シークレット）＋ 9-1 daily-checks 判定エンジン（純関数） | LegalBridge_AI_GCP | ✅ |

**Phase 9 着手（自動化基盤＋督促）**：V2 に欠けていた Cloud Scheduler 起動口・Webhook 受信口を新設。`/internal/jobs/:name`・`/internal/webhooks/{cloudsign,backlog}` をユーザー認証バイパス＋共有シークレット（定数時間比較）で保護し既定OFF、runner/handler は注入式（`internal/{shared-secret,jobs-routes,webhooks-routes}.ts`・tests 10）。daily-checks 判定ロジックを純関数移植（`jobs/daily-checks-engine.ts`＝納期7/3/1/超過・契約更新通告窓・満了遷移・tests 11）。**重要発見**：V1 の納期アラート重複抑止列 `last_alert_at` は互換ビューで NULL 固定＝現行スキーマに実在せず → V2 は本番を更新せず隔離台帳 `lb_v2_job_alert_ledger` で抑止する設計に確定。残スライス（9-1b配信/9-2契約通告/9-3満了遷移(本番UPDATE opt-in)/9-4検収ダイジェスト/9-5,9-7 Webhookハンドラ/9-6一括同期）と grant・verify・Scheduler配線を `docs/phase9-automation-plan.md` に precise plan 化。テスト545件緑。

| 2026-08-09 | 監査 | V1→V2 未移植機能の残課題台帳を新設（バックエンド/フロント/自動処理の3並列監査を統合） | LegalBridge_AI_GCP | ✅ |

**V1→V2 ギャップ監査（`docs/v1-v2-gap-remaining.md`）**：Phase 1〜8 の移植済みを除外し、V1 にあって V2 に無い機能を 3 観点（バックエンドAPI・フロントエンド・自動/バックグラウンド）で並列監査し統合。最大の発見は **V2 に Cloud Scheduler/cron・Pub-Sub・Webhook 受信口の土台が皆無**で、督促自動化（納期アラート・契約更新通告・満了自動遷移・検収ダイジェスト）と外部イベント駆動連携（CloudSign/Backlog Webhook）が丸ごと欠落（ポーリング/手動へ退化）。以下を提案 Phase 9〜15 として粒度・優先度付きで台帳化：9=自動化基盤＋督促/Webhook、10=文書運用オペ（void/再発行/アーカイブ/Excel一括）、11=設定・マスタ書込（会社設定/承認ルート/台帳・契約マスタCRUD/原作マテリアル登録）、12=データ保守（連結チェック修復/未リンクCL棚卸し/監査）、13=条件明細・課題横断オペ、14=関連当事者取引(RPT)独立サブシステム、15=テンプレ編集・取込・Drive健全性。稟議(Ringi)は廃止決定済み・要トリアージ。`v1-v2-parity-checklist.md`（旧・誤記あり）を本台帳が置換。

| 2026-08-09 | Phase 8 | 有効化ランブック整理：Phase 7/8 の GRANT×フラグ×scope 正準順を一枚に集約 | — | ✅ |

**有効化ランブック（`docs/phase8-matter-enablement-runbook.md`）**：案件管理（Phase 7 Slack＋Phase 8）の本番有効化を段階化。機能↔GRANT↔フラグ対応表（024〜029・8-2b/8-4 は追加GRANT不要）、GRANT 適用ブロック（preflight→本適用・確認変数）、`verify-write-test.sh` が要求する **WRITE_SCOPES 完全一致の正準順**（drafts,documents,pdf,…,matters,…,matter-merge,matter-delete,…,matter-slack）、有効化プロファイル A〜D（`_WRITE_SCOPES` と substitution の対応）、`gcloud builds submit` 実行例（プロファイルC）、`/api/v2/runtime` capability 確認、個別停止・ロールバックを収録。confirm トークン（MATTER_MANAGEMENT/MERGE/DELETE_LEGALBRIDGE_VALIDATION_ONLY・DRIVE_LEGALBRIDGE_VALIDATION_ONLY）と GRANT トークンを明記。phase8-matter-management.md から相互参照。

| 2026-08-09 | Phase 8 | 案件管理パリティ 8-2b：Drive ファイル→案件文書として新規登録（grant 006 再利用・冪等） | LegalBridge_AI_GCP | ✅ |

**スライス8-2b（Drive→文書登録）**：V1 の `POST /api/matters/:id/documents/from-drive` 相当。案件フォルダ内の Drive ファイルを外部文書（`template_type='external_file'`）として `documents` に登録し案件へ紐付ける。**新規 grant 不要**（`documents` INSERT は grant 006 で付与済み・`document_number` は NULL＝外部ファイルは採番しない・ファイル名は `form_data`{title,source:"drive"} に格納）。`matter-document-write-repository.ts` に `registerFromDrive(matterId,{link,name})`（Pg/Memory）を追加＝**冪等**（同一案件×同一 drive_link は既存を返し created:false）。ルート `POST /matters/:id/documents/from-drive`（`matterWriteEnabled` 共有・新規201/既存200）を write-routes に追加＋write-guard allowlist 追加。UI＝`MatterDriveFolder` のファイル一覧各行に「案件文書に登録」ボタン（登録後 detail 再取得）。テスト524件・typecheck緑・build緑。**Phase 8 完了（8-1〜8-6＋8-2b）**。

| 2026-08-09 | Phase 8 | 案件管理パリティ 8-6：案件・タスク削除（破壊的・専用フラグ＋合言葉・grant 029） | LegalBridge_AI_GCP | ✅ |

**スライス8-6（案件・タスク削除）**：V1 の `DELETE /api/matters/:id`・`DELETE /api/matters/:id/tasks/:taskId` 相当。`matter-delete-schema.ts`（合言葉 `COMMIT_MATTER_DELETE`・案件削除のみ）。`matter-delete-repository.ts`（Pg/Memory・`preview`＝連鎖(cascade)/解除(unlink)件数集計・GRANT不要／`deleteMatter`＝`FOR UPDATE`→件数確定→**`DELETE FROM matters` のみ**実行し FK 参照アクションで matter_issues/matter_tasks を CASCADE 削除・documents/document_sends を SET NULL 解除（本番文書の行は消えない）・42501→`MATTER_DELETE_FORBIDDEN_DB`503・23503→`MATTER_DELETE_REFERENCED`409／`deleteTask`＝**代表タスク is_primary は拒否**409・非代表のみ削除）。grant 029＝`matters`・`matter_tasks` DELETE（トークン `GRANT_PRODUCTION_MATTER_DELETE`）＋preflight（matters を参照する FK の `confdeltype` を一覧し想定外 CASCADE を確認）。参照アクションは PostgreSQL 内部実行のため削除ロールに参照先表の権限は不要。`matter-delete-routes.ts`：`GET /matters/:id/delete-preview`（read）／`DELETE /matters/:id`（guarded・合言葉）／`DELETE /matters/:id/tasks/:taskId`（guarded・合言葉不要）。**専用フラグ `MATTER_DELETE_ENABLED`＋scope `matter-delete`**。write-guard allowlist に両 DELETE 追加。capability `matter-delete` 露出。verify/cloudbuild に `_MATTER_DELETE_ENABLED`／`_CONFIRM_MATTER_DELETE`（=`MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY`）追加（有効時は write-test・production DB・IAP/Cloud Run IAM 必須）。UI＝`MatterRegistry` 案件詳細「危険操作」（プレビュー→合言葉→削除・削除後は一覧再取得）＋タスク行削除ボタン（非代表のみ）。テスト520件・typecheck緑・build緑。**Phase 8 完了**（残 8-2b Drive→文書登録は任意）。

| 2026-08-09 | Phase 8 | 案件管理パリティ 8-5：名寄せ（案件マージ／absorb・専用フラグ＋合言葉・grant 028） | LegalBridge_AI_GCP | ✅ |

**スライス8-5（名寄せ／案件マージ）**：V1 の `POST /api/matters/:id/absorb` 相当。重複案件（source）を存続案件（target）へ寄せ、課題・タスク・文書・送信履歴を移送。`matter-merge-schema.ts`（合言葉 `COMMIT_MATTER_MERGE`・自己マージ拒否）。`matter-merge-repository.ts`（Pg/Memory・`preview`＝SELECT のみで移送件数集計・GRANT不要／権限未付与表は count=null／`merge`＝両案件 `FOR UPDATE`・課題は衝突する `backlog_issue_key` を source 残置・タスクは `is_primary=FALSE` 降格・文書/送信履歴は matter_id 付替え・target 未設定なら Drive フォルダを DB 上で引継ぎ・source は `status='archived'`＝**DELETE しない**・42501→`MATTER_MERGE_FORBIDDEN_DB`503）。grant 028＝`document_sends` 列レベル UPDATE(matter_id)（027 は SELECT/INSERT のみ・履歴移送用・トークン `GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID`）＋preflight。課題=025／文書=026／タスク・matters=008 を再利用。`matter-merge-routes.ts`：`GET /matter-merge/preview`（read・admin/legal・書込無効でも可）／`POST /matter-merge`（guarded・**専用フラグ `MATTER_MERGE_ENABLED`＋scope `matter-merge`＋合言葉**＝vendor-merge に倣い破壊操作を隔離）。write-guard allowlist に `POST /matter-merge` 追加。capability `matter-merge` 露出。verify/cloudbuild に `_MATTER_MERGE_ENABLED`／`_CONFIRM_MATTER_MERGE`（=`MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY`）を追加（有効時は write-test サービス・production DB・IAP/Cloud Run IAM 必須）。UI＝`MatterMerge`（設定 > 案件名寄せ・ID→プレビュー→合言葉→実行）。テスト511件・typecheck緑。残：8-6 削除 / 8-2b Drive→文書登録。

| 2026-08-08 | Phase 8 | 案件管理パリティ 8-4：Drive フォルダ連携（作成/一覧・grant不要・Drive SA共有） | LegalBridge_AI_GCP | ✅ |

**スライス8-4（Drive フォルダ連携）**：案件ごとの Drive フォルダ作成/一覧。`documents/drive-folder.ts`（`MatterDriveFolderService`＝Google/Local/Memory・drive-storage と同じ Drive SA を生fetchで再利用・`ensureFolder` 冪等／`listFiles`／純関数 `matterFolderName`）。`matter-drive-repository.ts`（`getFolder`/`setFolder`＝`matters.drive_folder_id/url`・**008 の matters UPDATE で更新可＝新規grant不要**）。`matter-drive-routes.ts`：`POST /matters/:id/drive-folder`（作成/取得・冪等）／`GET /matters/:id/drive-files`（一覧）。ゲート＝`driveStorageEnabled`（読取）＋`matterWriteEnabled`（作成）の**既存能力再利用**（新フラグ無し）。write-guard allowlist に POST 追加。UI＝`MatterDriveFolder`（作成/開く＋ファイル一覧）。テスト503件・build緑。`from-drive`（Drive→新規文書登録）は 8-2b へ。

| 2026-08-08 | Phase 8 | 案件管理パリティ 8-3：送信履歴（document_sends・grant 027 SELECT/INSERT・read＋append） | LegalBridge_AI_GCP | ✅ |

**スライス8-3（送信履歴）**：案件の文書送信履歴（`document_sends`・email/slack/drive/manual）。`matter-send-repository.ts`（Pg/Memory・`list` 新しい順／`record` append）。grant 027＝`document_sends` SELECT/INSERT（append専用・006未付与）＋preflight。`matter-send-routes.ts`：`GET /matters/:id/sends`（read・台帳無しは enabled:false）／`POST /matters/:id/sends`（append・`matterWriteEnabled` 共有・sentBy=current user）。write-guard allowlist に POST 追加。UI＝`MatterSends`（履歴一覧＋手動記録フォーム）。テスト497件・build緑。

| 2026-08-08 | Phase 8 | 案件管理パリティ 8-2：文書リンク/解除（documents.matter_id・grant 026 列レベルUPDATE） | LegalBridge_AI_GCP | ✅ |

**スライス8-2（文書リンク/解除）**：案件⇄文書の紐付け付け替え。`matter-document-write-repository.ts`（Pg/Memory・`link`=`UPDATE documents SET matter_id`・対象無し404／`unlink`=`SET matter_id=NULL`）。grant 026＝**`documents` の列レベル `UPDATE(matter_id)` のみ**（最小権限・他列更新不可）＋preflight。ルート `POST/DELETE /matters/:id/documents(/:docId)`（`matterWriteEnabled` 共有・write-guard allowlist 追加）。UI＝`MatterDocumentLinks`（文書ID紐付け／行ごと解除）。テスト492件・build緑。`from-drive`（Drive→新規文書INSERT）は V1固有列のため 8-2b へ。

| 2026-08-08 | Phase 8 | 案件管理パリティ 8-1：課題（Backlog）紐付け 追加/解除（grant 025・matterWrites 共有） | LegalBridge_AI_GCP | ✅ |

**スライス8-1（課題紐付け）**：V1 突合で判明した案件管理欠落（Drive/課題/文書リンク/送信履歴/名寄せ/削除）のうち、中心的な **課題（Backlog）紐付け 追加/解除** を移植。`matter-issue-write-repository.ts`（Pg/Memory・`attach`=V1 準拠 UPSERT／`detach`=解除のみ・権限不足42501→`MATTER_ISSUE_GRANT_MISSING`503）。`write-routes` に `POST /matters/:id/issues`・`DELETE /matters/:id/issues/:key`（**既存 `matterWriteEnabled`＝scope `matters` を共有**・フラグ乱立回避）＋app.ts write-guard allowlist 追加。grant 025（`matter_issues` INSERT/UPDATE/DELETE・トークン `GRANT_PRODUCTION_MATTER_ISSUE_LINKS`）＋preflight（008 は matters/matter_tasks のみだったため新設）。UI＝`MatterRegistry` 関連課題に `MatterIssueLinks`（キー＋relation で紐付け／行ごとに解除）。テスト全緑・client build 緑。設計は `docs/phase8-matter-management.md`。残：8-2 文書リンク / 8-3 送信履歴 / 8-4 Driveフォルダ / 8-5 名寄せ / 8-6 削除。

| 2026-08-07 | Phase 7 | 案件Slack 完了：7-3 定型文＋Drive権限 / 7-4 自動通知 / 7-5 UI パネル | LegalBridge_AI_GCP | ✅ |

**スライス7-3/7-4/7-5（案件Slack 完了）**：7-3=定型文3種（`buildTemplateMessage`）＋`documents/drive-permission.ts`（メンション先へ Drive 閲覧権限 best-effort 付与）＋`POST /matters/:id/slack/template`。7-4=**案件イベント連動の自動通知**（`matter-slack-notifier.ts`・`deriveMatterUpdateNotification`/`deriveTaskNotification`＋`LiveMatterSlackNotifier`・`staff_id→slack_user_id` 解決・書込後 best-effort 投稿・V1 に無い新規）。7-5=`MatterSlackPanel.tsx`（案件詳細のスレッド作成/メンションチップ/本文投稿/定型文/会話表示・admin/legal）。テスト 484 件・client build 緑。Phase 7（案件Slack メンション＋自動通知＋UI）完了。設計は `docs/phase7-matter-slack.md`。

| 2026-08-07 | Phase 7 | 案件Slack 7-1/7-2：法務相談スレッド＋<@id>メンション（V1 パネル移植・grant 024） | LegalBridge_AI_GCP | ✅ |

**スライス7-1/7-2（案件 Slack スレッド＋メンション）**：V1↔V2 突合（並行調査）で「V2 は Slack が依頼者DMのみ・チャンネル/スレッド/メンション非対応」と確定。V1 の案件 Slack パネル（法務相談スレッド）を V2 へ移植。①`SlackWebApiClient` に `conversations.replies` を追加、`slack-matter-channel.ts` に `WebApiMatterSlackChannelAdapter`（`chat.postMessage`＋`thread_ts`）＋純関数（`mentionTokens`/`composeMentionMessage`/`buildThreadRootText`）。②隔離テーブル `lb_v2_matter_slack_threads`（grant 024＝validation＋production＋preflight・1案件1スレッド・SELECT/INSERT）＋`matter-slack-thread-repository.ts`（Pg/Memory・スレッド冪等＋`staff.slack_user_id` メンション候補）。③`matter-slack-routes.ts`：候補/スレッド会話（read）＋スレッド作成/メンション投稿（guarded）。④config `MATTER_SLACK_ENABLED`/`SLACK_LEGAL_CONSULT_CHANNEL`／app.ts／verify（scope `matter-slack`＋live/channel/write-test ガード）／cloudbuild 全結線。テスト 467 件。設計は `docs/phase7-matter-slack.md`。残：7-3 定型文＋Drive権限、7-4 案件イベント自動通知、7-5 UI。

| 2026-08-07 | Phase 5 | gap⑥ `matter_overview_v` 依頼者メール露出を V1 定義突合で apply-ready DDL 化（023） | LegalBridge_AI_GCP | ✅ |

**gap⑥ ビュー拡張の DDL 確定（023）**：V1 リポジトリの `matter_overview_v` 現行定義（migration `0126_matter_lifecycle_and_tasks.sql`）を取得し、`matters.created_by`（V1 では `x-user-email`＝案件作成者＝依頼者メール）が依頼者メール源と特定。`023_matter_overview_requester_email.sql` として、0126 の SELECT を逐語再現し末尾に `m.created_by AS requester_email` を追加する **apply-ready DDL**（テンプレートでなく実適用可）を authored。確認トークン `EXTEND_PRODUCTION_MATTER_OVERVIEW_REQUESTER`＋`current_database()='legalbridge'` guard＋runtime へ SELECT 再付与。非メール値は V2 `optionalEmail`（5-3修正済）が null 化するため安全。唯一の前提は 021 introspect で本番現行定義が 023 再現部と一致（ドリフト無し）を確認すること。`docs/phase5-db-followups.md` §C を「テンプレート穴埋め」から「023 をそのまま適用」に更新。これで gap⑥ の残りは運用 psql 実行のみ。

| 2026-08-07 | Phase 5 | CloudSign client_id を Secret Manager 化（平文 substitution 廃止・SLACK_BOT_TOKEN 同型） | — | ✅ |

**CloudSign client_id の Secret Manager 配線**：`client_id` を平文ビルド substitution（Cloud Build ログ／Cloud Run env に露出）から **Secret Manager 注入**へ変更。cloudbuild は `_CLOUDSIGN_CLIENT_ID`（値）を廃し `_CLOUDSIGN_CLIENT_ID_SECRET`（シークレット名・既定 BLOCKED）を導入。`_CLOUDSIGN_MODE=live` かつシークレット名設定時のみ `--set-secrets` で `CLOUDSIGN_CLIENT_ID` env を注入（Slack bot token と同型・ENVVARS からは平文値を除去）。verify は live 時に**シークレット名の設定**を要求（値ではなく名前）。アプリは従来どおり `process.env.CLOUDSIGN_CLIENT_ID` を読む（変更不要）。runbook §1 にシークレット作成＋secretAccessor 付与手順、点火コマンドを `_CLOUDSIGN_CLIENT_ID_SECRET=cloudsign-client-id` へ更新。verify 構文OK・default（disabled）パス確認。

**点火準備（CloudSign Runbook）**：`docs/phase5-cloudsign-ignition.md` を新設。多重ゲート条件・事前準備（実 client_id／宛先allowlist／grant 022）・**実本番デプロイコマンド**（`^|^` 区切り・`_INTEGRATION_MODE=live`＋`cloudsign` スコープ＋CloudSign変数を契約取込の実値土台に追加）・スモークテスト（能力ON→preview→許可外422→実依頼→冪等duplicate→status取込）・ロールバックを収録。参照した substitution 変数が cloudbuild に全て存在することを確認済み。旧 `docs/gmail-cloudsign.md` の CloudSign 節（「想定・最終確認必須」）を確定仕様（V1準拠・form-urlencoded・allowlist/history 変数）へ更新。

**スライス5-7（CloudSign 送信路の堅牢化）**：5-6 で確定した CloudSign を点火可能な状態へ。①**送信冪等＋永続化**：`lb_v2_cloudsign_requests`（grant 022＝検証/本番の作成＋付与・`idempotency_key` 一意・SELECT/INSERT/UPDATE・DELETE/TRUNCATE不可）＋`cloudsign-request-repository`（Pg/Memory・findByKey/record〈ON CONFLICT DO NOTHING〉/updateStatus/list）。dispatch が送信前に既依頼を照会し重複は再送せず既存受領を返す（`cloudsign="duplicate"`・200）。`cloudSignDocumentId` を永続化し `GET /cloudsign/:id/status` 取得時に締結状況を反映。②**宛先allowlist**（V1 `CLOUDSIGN_ALLOWED_RECIPIENTS` 準拠）：`parseAllowedRecipients`/`findDisallowedRecipient`（純関数）で、設定時は全宛先が許可集合内であることを要求（許可外は422 `CLOUDSIGN_RECIPIENT_NOT_ALLOWED`・空なら無制限）。config（`CLOUDSIGN_ALLOWED_RECIPIENTS`/`CLOUDSIGN_REQUEST_HISTORY_ENABLED`）／app.ts／verify（history は write-test 限定・**live 点火時は allowlist 必須**）／cloudbuild 全結線。テスト455件。**CloudSign は他送信系と同等の堅牢度に到達**＝実 client_id 投入で点火準備完了。残るは reportees(CC) のみ（必要時）。

**スライス5-6（CloudSign 実API突合・gap ④解消）**：V1 リポジトリ `LegalBridge_AI_GCP` の実動クライアント `services/worker/src/services/cloudSignService.ts` に突合し、V2 スキャフォルドの想定値を**実仕様へ修正**。判明した差分：①`/token` は **`client_id` のみを form-urlencoded body** で送る（**client_secret も grant_type も不要**・V1 に secret は一切存在せず）→ スライス5-4 の「secret 必須」想定は誤りと確定し `CLOUDSIGN_CLIENT_SECRET` フック＋config を撤去。②`expires_in` 尊重のトークンキャッシュ（30秒前倒し失効）＋**401で1回だけ再取得**を追加（従来は無期限キャッシュ・リトライ無し）。③`createDocument` は form-urlencoded `title` のみ（JSON `{title,note}` から修正）。④`addFile` の multipart 項目名を `files`→**`uploadfile`** に修正。⑤`addParticipant` を form-urlencoded（`email/name/organization`）に修正（JSONから）。⑥`send`(POST /documents/:id 本文なし)・`getDocument`(GET) は元から一致。テスト443件（契約テスト：token body / form-encoded / uploadfile multipart / 期限内トークン再利用 / 401再取得）。**gap ④（唯一の hard-block）を解消**＝CloudSign は実 `client_id`＋`INTEGRATION_MODE=live`＋scope で他送信系と同じゲート運用で点火可能に。残るは永続化・送信冪等（Gmail 5-1 同型）・宛先allowlist（V1 `CLOUDSIGN_ALLOWED_RECIPIENTS` 相当）の小項目のみ。

**スライス5-5（Phase 5 DB フォローアップ）**：コード側スライス（5-1〜5-4）で残った本番 DB 作業を実行可能な SQL＋手順として整備。①**A：`lb_v2_gmail_send_history` 本番版**（`019_gmail_send_history_production_grants.sql`＝006同型の作成＋runtime へ SELECT/INSERT・確認トークン `GRANT_PRODUCTION_GMAIL_SEND_HISTORY`＋read-only preflight）。②**B：`lb_v2_inbound_contracts` 本番版**（`020_..._production_grants.sql`＝作成＋SELECT/INSERT/UPDATE・トークン `GRANT_PRODUCTION_INBOUND_INTAKE`＋preflight）。③**C：gap ⑥ 依頼者メール露出**（`021_matter_overview_requester_introspect.sql`＝現行ビュー定義 `pg_get_viewdef` と `matters` の候補列を吸い出す読取専用調査）。ビュー現行定義が本 repo に無い（V1本番側）ため**盲目 `CREATE OR REPLACE` は不可**＝introspect→定義確定→拡張の順を `docs/phase5-db-followups.md` に明記（既存カラム全保持＋末尾に `requester_email` 1列追加、ロールバック付き）。全て preflight→本適用の二段。**残る唯一の hard-block は ④CloudSign 認証の実API突合（外部依存）**。

**スライス5-4（CloudSign認証フック・部分対応）**：Phase 5 残ギャップ④の**コード側で安全に前進できる部分のみ**を対応。`FetchCloudSignApiClient` を options 化し `clientSecret` を受け取り、**設定時のみ** `/token` に `client_secret` を付与（未設定は従来リクエストと厳密同一）。config `cloudSignClientSecret`（`CLOUDSIGN_CLIENT_SECRET`）＋app.ts 結線＋トークン交換テスト2件（付与/非付与）。テスト440件。**これは live 化を保証しない**：エンドポイント/verb/grant_type は依然想定値で、**実CloudSign APIとの突合（外部依存）が唯一の hard-block として残存**。本フックは確定後に「コード変更でなく設定＋シークレット投入＋Secret Managerマウント配線」で済ませるための足場。

**スライス5-3（Slack依頼者メール解決バグ修正）**：Phase 5 残ギャップ⑥のコード側を解消。`matters/repository.ts` の `optionalEmail` が**正規表現リテラルを二重エスケープ**（`/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`）していたため、`matter_overview_v` が `requester_email`/`created_by`/`requester` を返しても **`mapSummary` が全メールを null 化**していた（＝Slack候補フローの依頼者宛先が常に `unmapped`/`missing_identity` になる隠れ原因）。単一エスケープ（`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`・`gmail-delivery-adapter` の `EMAIL_PATTERN` と同一）へ修正し、`optionalEmail` を export して回帰テスト追加（正当メール通過・正規化・非メール棄却）。テスト438件。**残りは DB作業のみ**：`matter_overview_v` が上記いずれかの列で依頼者メールを露出すれば、コード側は解決可能になる。

**スライス5-2（Gmail受信取込の登録導線）**：Phase 5 残ギャップ⑤（②）＝「取得PDFは閲覧+DLのみで文書レジストリ/Driveへの書込導線が無い」を解消。隔離ファースト方針に沿い**本番 `documents` テーブルは触れず**、隔離台帳 `lb_v2_inbound_contracts`（grant 020＝検証DBに作成・`idempotency_key`〈message+attachment指紋〉一意・SELECT/INSERT/UPDATE のみ・DELETE/TRUNCATE 不可）＋preflight。`inbound-contract-repository.ts`（Pg/Memory・`findByKey`/`capture`〈ON CONFLICT DO NOTHING＋再取得〉/`list(status?)`/`updateStatus`）。`gmail-inbound-routes` に3ルート追加：`POST .../register`（添付取得→`isPdfBufferSafe`検証→台帳へcaptured記録・既記録は`intake="duplicate"`で実バイト再取得せず200・非PDFは422）、`GET /gmail-inbound/registered`（一覧・status絞込・台帳無しは`enabled:false`）、`POST /gmail-inbound/registered/:key/status`（captured→linked/dismissed）。config `gmailInboundIntakeEnabled`（`GMAIL_INBOUND_INTAKE_ENABLED`・既定OFF）／app.ts（依存構築・ルート結線）／verify（true/false検証＋write-test限定ガード）／cloudbuild（subs既定false・export・ENVVARS）全結線。テスト435件。**Driveバイト実保管は identity方式（appProperties名前空間）決定後に別スライス**へ明示的に繰延。

**スライス5-1（Gmail送信冪等）**：Phase 5 残ギャップ③（Gmail/CloudSignの冪等未実装）のうち **Gmail 側を解消**。Slack 001/002 と同型の append 専用履歴テーブル `lb_v2_gmail_send_history`（grant 019＝隔離検証DBに作成・`idempotency_key` 一意・SELECT/INSERT のみ・UPDATE/DELETE/TRUNCATE 不可）＋preflight。`gmail-send-history-repository.ts`（Pg/Memory・`findByKey`/`record`＝ON CONFLICT DO NOTHING）。`gmail-notification-routes` の dispatch が送信前に既送信を照会し、重複なら実送信せず受領を返す（`integrations.gmail="duplicate"`・200）。config `gmailSendHistoryEnabled`（`GMAIL_SEND_HISTORY_ENABLED`・既定OFF）／app.ts（依存構築・ルート結線）／`verify-write-test.sh`（true/false検証＋write-test限定ガード）／`cloudbuild`（subs既定false・export・ENVVARS）全結線。既定OFF時は従来通り毎回送信（後方互換）＝default検証パス（simulation確認）。テスト425件。**CloudSign 側は認証未確定（残ギャップ④）のため live 化不可＝認証突合後に同型で追加**。
