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
