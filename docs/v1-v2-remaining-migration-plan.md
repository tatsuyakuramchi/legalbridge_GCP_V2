# V1 未移植機能の移植計画（2026-08-18 起草）

対象：ロイヤリティ計算／支払報告書／源泉税計算／為替管理／請求ダッシュボード／権利ツリー／
サブライセンス条件／Backlog 書戻し。

## 0. 結論（先に）

**8 項目のうち 7 項目は V2 に実装済み**で、動いていないのは移植が無いからではなく
**点火（フラグ）していない**ため。ただしそのうち 3 つは**点火する経路自体がデプロイ設定に
配線されていない**ので、フラグを渡そうとしても渡せない状態にある。ここだけコード作業が要る。

本当に未移植なのは UI 2 件（権利ツリーの地域サマリー・重複警告／ライセンスマトリクス）。

| # | 項目 | V2 の実体 | 状態 |
|---|---|---|---|
| 1 | ロイヤリティ計算 | `server/royalty/calc.ts`＋`RoyaltyPreview.tsx` | ✅ 実装済み。**プレビューは点火不要で動く**。実績の記録だけ未点火 |
| 2 | 源泉税計算 | `server/royalty/tax.ts`（源泉徴収＋消費税） | ✅ 実装済み・計算は動く |
| 3 | 為替管理 | `server/royalty/fx.ts`（換算＋明細行） | ✅ 実装済み・計算は動く |
| 4 | 請求ダッシュボード | `receipt-dashboard-*`＋`BillingDashboard.tsx`／`BillingPrint.tsx` | ✅ 読取は動く。受領の記録が未点火 |
| 5 | 支払報告書 | `payment-report*`＋`PaymentReport.tsx`（CSV/Excel 出力込み） | ✅ 実装済み・読取のみで完結 |
| 6 | サブライセンス条件 | `ledgers/outbound-condition*`＋`OutboundConditionWorkspace.tsx` | ✅ 実装済み。`outbound-conditions` スコープ次第 |
| 7 | Backlog 書戻し | `integrations/backlog-routes.ts`（コメント投稿） | ✅ 実装済み・**未点火**（`_BACKLOG_COMMENT_WRITE_ENABLED=false`） |
| 8 | 権利ツリー | `works/work-detail.ts`（receivable/payable 分類まで）＋作品詳細の権利タブ | ⚠️ **部分**。地域サマリー・重複警告・買い切り合計が無い |
| — | ライセンスマトリクス | 無し（V1 `V3LicenseMatrix.tsx` 671行） | ❌ 未移植。要否の業務判断が先 |

読取系（1・2・3・5、および 4 の閲覧）は**いま既に使える**。使えていないなら点火ではなく
画面導線の問題なので、そちらを先に確認する（下の「まず確認する」）。

## 1. まず確認する（現状の実測）

```bash
IMG=$(gcloud run services describe legalbridge-v2 --project legalbridge-488506 \
  --region asia-northeast1 --format='value(spec.template.spec.containers[0].image)')
gcloud builds describe "${IMG##*:}" --project legalbridge-488506 --format=json \
  | jq '.substitutions | {_WRITE_SCOPES, _OUTBOUND_CONDITION_WRITES_ENABLED,
       _BACKLOG_COMMENT_WRITE_ENABLED, _CONTRACT_INTAKE_WRITES_ENABLED}'
```

**実測（2026-08-18）**：

```
_WRITE_SCOPES = drafts,documents,pdf,drive,slack-approvals,matters,vendors,staff,works,
  materials,rights-sources,vendor-merge,matter-merge,matter-delete,document-void,
  document-reissue,excel-batch,settings,workflow-rules,contract-master,snippets,
  attachments,cloudsign,slack,slack-dispatch,matter-slack,condition-repair
_OUTBOUND_CONDITION_WRITES_ENABLED = false
_BACKLOG_COMMENT_WRITE_ENABLED     = false
```

→ `outbound-conditions` は**入っていない**ので R2-2 は必要。`backlog-comment` も無いので R2-1 も必要。

**ついでに見つかった未点火**：`contract-intake` もスコープに無い（`ContractIntakeWorkspace.tsx`
＋`_CONTRACT_INTAKE_WRITES_ENABLED` は実装済み）。契約インテークの書込を使う予定があるなら
R2 に足す。使わないなら明示的に「使わない」と決めて記録する。

## 2. Phase R1 — 点火経路の配線 ✅ 完了（2026-08-18）

**問題**：`royaltyEventWritesEnabled` / `receiptWritesEnabled` / `paymentLedgerWritesEnabled` は
`config.ts` が読むのに、`cloudbuild-write-test.yaml` が対応する env を**一度も渡していない**
（`ROYALTY_EVENT_WRITES_ENABLED` 等が ENVVARS に無い）。さらに `verify-write-test.sh` は
これらのフラグを知らないため、`WRITE_SCOPES` に `royalty-events` / `receipts` / `payments` を
足すと「期待スコープと一致しない」で**デプロイが落ちる**。つまり現状は点火不能。

やること（既存の capability と同じ形に揃えるだけ・新しい設計判断は不要）：

1. `cloudbuild-write-test.yaml`
   - substitutions に `_ROYALTY_EVENT_WRITES_ENABLED` / `_RECEIPT_WRITES_ENABLED` /
     `_PAYMENT_LEDGER_WRITES_ENABLED`（既定 `"false"`）と、対応する `_CONFIRM_*`（既定 `BLOCKED`）
   - verify ステップの変数設定＋`export` 一覧＋`ENVVARS` に追加
2. `verify-write-test.sh`
   - 3 つの `case` を追加（承認済みサービス・合言葉・IAP/IAM を要求。既存の
     `EXCEL_BATCH_ENABLED` 等と同じ骨格）
   - `expected_write_scopes` に正準順で `royalty-events` / `receipts` / `payments` を追加
     （順序は `app.ts` の並びに合わせる：… `condition-repair` の後段）
3. `verify-cases.sh` に「正式名なら通る／未承認名なら止まる／合言葉が無ければ止まる」を追加
4. grant は **014／015／016 が適用済み**（runbook §0「001〜046 すべて適用済み」）。DB 作業なし

**実施済み**。cloudbuild に `_ROYALTY_EVENT_WRITES_ENABLED` / `_RECEIPT_WRITES_ENABLED` /
`_PAYMENT_LEDGER_WRITES_ENABLED`（＋各 `_CONFIRM_*`）を配線し、verify に3ゲートを追加した。
骨格は MATTER_WRITES と同じ（確認トークン＋本番DB照合＋承認済みサービス＋IAP/IAM）。
追加の判断2点：

- **金額系は本番DB限定**（隔離DBの検証プロファイルでは点火できない。書く先の
  condition_events 等は本番にしか意味がないため）。
- **支払台帳は受領記録とセットでのみ点火可**。payments への書込は受領記録
  （receipt-repository の同期）が唯一の書き手なので、単独で点けても動かない構成を
  ゲートで拒否する。

期待スコープへの挿入位置は app.ts の宣言順どおり `backlog-comment` の直後
（`royalty-events` → `receipts` → `payments`）。verify-cases.sh に8ケースを固定済み。
既定はすべて false＝この配線だけでは挙動は変わらない。

## 3. Phase R2 — 点火（デプロイのみ・DB 作業なし）

R1 のあと、業務側の準備ができたものから順に。**一度に全部点けない**（切り分けができなくなる）。

> **1〜2 は 2026-08-18 点火済み**（backlog-comment・outbound-conditions＋接続先3点。
> 初回は OUTBOUND_DB_* が既定 BLOCKED のまま送ってゲートで落ちた＝build 64792c41。
> 以後は deploy スクリプトが実値プリフライトで送信前に止める）。残りは 3〜5（金額系）のみ。

| 順 | 対象 | 渡すフラグ |
|---|---|---|
| 1 | Backlog 書戻し（コメント投稿） | `_BACKLOG_COMMENT_WRITE_ENABLED=true`＋`_CONFIRM_BACKLOG_COMMENT_WRITE=BACKLOG_COMMENT_WRITEBACK_VALIDATION_ONLY`＋`_WRITE_SCOPES` へ `backlog-comment` |
| 2 | サブライセンス（アウト）条件 | `_OUTBOUND_CONDITION_WRITES_ENABLED=true`＋`_CONFIRM_OUTBOUND_WRITES`＋スコープ `outbound-conditions`＋**接続先3点**（`_OUTBOUND_DB_NAME=legalbridge`／`_OUTBOUND_DB_USER=legalbridge_v2_runtime`／`_OUTBOUND_DB_PASSWORD_SECRET=legalbridge-v2-runtime-db-password`。既定 BLOCKED のままだとゲートで落ちる——build 64792c41 で実証） |
| 3 | ロイヤリティ実績の記録 | `_ROYALTY_EVENT_WRITES_ENABLED=true`＋`_CONFIRM_ROYALTY_EVENT_WRITES=ROYALTY_EVENT_WRITES_LEGALBRIDGE_VALIDATION_ONLY`＋スコープ `royalty-events` |
| 4 | 受領の記録（請求ダッシュボード） | `_RECEIPT_WRITES_ENABLED=true`＋`_CONFIRM_RECEIPT_WRITES=RECEIPT_WRITES_LEGALBRIDGE_VALIDATION_ONLY`＋スコープ `receipts` |
| 5 | 支払台帳の同期 | `_PAYMENT_LEDGER_WRITES_ENABLED=true`＋`_CONFIRM_PAYMENT_LEDGER_WRITES=PAYMENT_LEDGER_WRITES_LEGALBRIDGE_VALIDATION_ONLY`＋スコープ `payments`（**4 とセットでのみ**） |

スコープの挿入位置：現行の本番 `_WRITE_SCOPES` では `attachments` と `cloudsign` の間
（`backlog-comment` を点火する場合はその後ろ）。verify が厳密一致で見るので、
位置を間違えるとデプロイが止まる＝止まったら verify の期待順に合わせる。

点火コマンド（例：3〜5 を一括。V1 読み取り専用化の後に）:

```bash
# R2-1/2 点火済みの前提（outbound-conditions は slack-approvals の直後、
# backlog-comment は attachments の直後に既に入っている）。verify は厳密一致なので
# 既存スコープを落とさないこと。
infra/gcp/deploy-write-test.sh \
  _ROYALTY_EVENT_WRITES_ENABLED=true \
  _CONFIRM_ROYALTY_EVENT_WRITES=ROYALTY_EVENT_WRITES_LEGALBRIDGE_VALIDATION_ONLY \
  _RECEIPT_WRITES_ENABLED=true \
  _CONFIRM_RECEIPT_WRITES=RECEIPT_WRITES_LEGALBRIDGE_VALIDATION_ONLY \
  _PAYMENT_LEDGER_WRITES_ENABLED=true \
  _CONFIRM_PAYMENT_LEDGER_WRITES=PAYMENT_LEDGER_WRITES_LEGALBRIDGE_VALIDATION_ONLY \
  '_WRITE_SCOPES=drafts,documents,pdf,drive,slack-approvals,outbound-conditions,matters,vendors,staff,works,materials,rights-sources,vendor-merge,matter-merge,matter-delete,document-void,document-reissue,excel-batch,settings,workflow-rules,contract-master,snippets,attachments,backlog-comment,royalty-events,receipts,payments,cloudsign,slack,slack-dispatch,matter-slack,condition-repair'
```

3〜5 は共有 DB の金額データを書くため、**V1 併走中は二重入力の危険がある**。
V1 側で同じ入力をしていないことを確認してから点ける（§5-1 の読み取り専用化とセットが安全）。

各点火後のスモーク（1件ずつ・テストデータは消す）:
- 3：作品詳細 → ロイヤリティ実績を1件登録 → `condition_events` に1行
- 4：請求ダッシュボード → 受領を1件記録 → `condition_receipts` に1行＋消込表示
- 5：受領記録に対する支払が `payments` へ同期されること

## 4. Phase R3 — 権利ツリー（**UIデザインごと再設計**・2026-08-18 決定）

V1 の移植ではなく**再設計**する（利用者判断）。V1 `RightsTreePanel.tsx`（245行）＋
`GET /api/v3/works/:id/rights-tree` は**参照実装**として扱い、そのまま写さない。

再設計の入力として調査しておくもの（デザイン前に確定させる）：

1. V1 が出していた情報の棚卸し：取得（payable）／許諾（receivable）の分類、
   買い切り金額と件数・合計、ランニングの計算条件、許諾地域・言語、
   地域サマリー（地域→言語→権利）、**広域許諾と個別許諾の重複警告**
2. 重複警告の判定ルール（`workModel.ts` の rights-tree 集計）。UI は変えても
   **この業務ルールは引き継ぐ**——警告が消えると二重許諾の検知手段が無くなる
3. V2 側の土台：`works/work-detail.ts` が receivable/payable 分類まで済ませており、
   データ源（condition_lines）は同じ。集計は純関数に切り出してテストで固める方針は維持

新規 grant 不要（読取のみ）。デザイン案が決まり次第、別スライスとして計画する。

## 5. Phase R4 — ライセンスマトリクス（**画面から再設計**・2026-08-18 決定）

R3 と同じく V1（`V3LicenseMatrix.tsx`・671行）の移植ではなく、**用途に合わせた
UI/UX を新たに設計する**。V1 は「何を見るための画面だったか」の参照のみ：
作品×地域×言語×権利種別の許諾状況を一覧で俯瞰する用途。

R3 と R4 はデータ源が同じ（`condition_lines`）なので、**集計層は共通に作る**：
純関数の集計（作品単位のツリー用と、横断のマトリクス用）を先に固め、
その上に2つの画面を載せる。デザイン検討もこの2画面をセットで行うのが効率的
（同じ語彙・同じ凡例で揃えられる）。

## 5b. Phase R5 — 作品別損益一望（**保留**・2026-08-18 判断）

イン支払×アウト受領を作品単位で突き合わせる読取画面。基盤は統一管理で揃っており
（payments が work_id×direction を持つ・新規 grant 不要）、実装は1日規模。
**R2-4/5 の点火で受領記録が payments に流れ始めてから着手する**（実データで検証できるため）。

決めごと（推奨で仮置き・着手時に確定）：実績ベース＋契約予定は参考列／まず累計
（年度は後続）／通貨別表示（円換算しない）。
注意：支出側の完全性は V1 時代の支払が payments にどこまで入っているかに依存。
画面に「payments 台帳ベース」と明記し、初回実データで抜けを確認する。

## 6. 見積り

| Phase | 内容 | 規模 | 前提 |
|---|---|---|---|
| R1 | 点火経路の配線 | ✅ 完了（2026-08-18） | — |
| R2 | 点火（5段階） | デプロイのみ | 1〜2 は即可。3〜5 は V1 併走の整理（§5-1 とセット推奨） |
| R3 | 権利ツリー（再設計） | デザイン決定後に見積り | V1 の表示項目・重複判定ルールの棚卸し |
| R4 | ライセンスマトリクス（再設計） | デザイン決定後に見積り | R3 とデザイン検討をセットで（集計層は共通化） |

## 6b. フォーム再設計（検収書・利用許諾料計算書）— 2026-08-18 実装

モック承認済みの2フォームを実装した（ステップカード＋右レール構成・検収書とお揃い）。

**検収書**: ①親の発注書 ②検収明細（表形式・発注数量/今回検収を並記、業績連動行は
PDF と同じ出し分け注記）③〜スキーマグループ。右レールに総支払額ライブ計算
（共有 `computeInspectionTotals`）。テンプレは 059 で歩留率列を削除（新版）。

**利用許諾料計算書**: 計算書タイプ（単票/多明細）＋算定タイプ（イベント式=製造・
時限式=期間の売上報告/サブライセンス受領）を切替え、生の実績値（rs* フィールド）だけを
入力。グロス→MG(floor)→AG(累積消化)→消費税→源泉前合計は共有エンジン
（`src/royalty-statement.ts` → royalty/calc・tax・fx）でサーバ側が組み立てる＝右レールと
PDF が必ず一致。多明細はサブライセンシー入金行（行ごとに通貨・交換前/交換後・レート）。
テンプレは 060 で ■受領情報 を明細表化（receiptRows があるときのみ・旧下書きは従来表示）。
源泉徴収は右レールの参考表示のみ（テンプレどおり源泉前まで・控除は支払処理側）。

**残タスク（フォローアップ）**:
- 受領記録（condition_receipts）からの入金行取り込み（チェックで引用・二重入力をなくす）
- 確定時の condition_events 自動記録（R2-3 点火後・二重入力をなくす）
- ステップ1の条件バッジ（料率・MG/AG 残高・源泉区分の自動表示）と AG 消化済み累計の自動集計
- 算定期間の初期値＝条件明細の報告サイクル

## 7. この計画で確認していないこと

- 契約インテーク書込（`contract-intake`）を使うのかどうか（未点火であることは確認済み）
- V1 の権利ツリーの重複判定の正確なルール（`workModel.ts` の `rights-tree` を読んで写す）
- ライセンスマトリクスの利用実態
