# Phase 10：文書運用オペレーション（発行後の管理）

V2 は draft→finalize→pdf→drive までは移植済みだが、**発行後の運用系**（void／再発行／
アーカイブ／PDF 再生成／Excel 一括）が欠落していた。本フェーズはこれを既存 guarded パターン
（既定OFF・確認トークン・列レベル GRANT・隔離台帳）で段階移植する。

## スライス

| # | 機能 | 粒度 | 状態 |
|---|---|---|---|
| 10-2 | 文書 void（無効化）＋実績取消（残高復元） | 小 | ✅ 実装済 |
| 10-3 | PDF 再生成（Drive 上書き更新） | 小 | ✅ 実装済 |
| 10-6 | 文書ルックアップ（番号検索・PDF未生成一覧・次番号プレビュー） | 小 | ✅ 実装済 |
| 10-1 | 文書アーカイブ（状態フィルタ・PDF未生成キュー・バージョン履歴） | 中 | ✅ 実装済 |
| 10-1b | 文書再発行（新版採番＋旧版 supersede＋実績取消） | 中 | ✅ 実装済 |
| 10-6 | 文書ルックアップ（番号検索・次番号・PDF未生成一覧） | 小 | 未 |
| 10-4 | 一括無効化（bulk void） | 中 | ✅ 実装済（一括項目更新は将来拡張） |
| 10-5 | Excel 一括出力（担当×支払期日×種別集計→Drive保存） | 大 | 未 |

## 10-2：文書 void（無効化）✅ 実装済

V1（`services/worker/server.ts` の `/api/documents/:id/void`）と同じ挙動を移植：
文書を `lifecycle_status='voided'`・`is_primary=FALSE` にし、**同一トランザクションで**紐づく
有効実績 `condition_events` を `voided_at`/`void_reason` で取消して残高を復元する。

- **grant 033**（`033_production_document_void_grants.sql`＋preflight）：列レベル
  `UPDATE(lifecycle_status, is_primary) ON documents` ＋ `UPDATE(voided_at, void_reason) ON condition_events`。
  監査は隔離台帳 `lb_v2_document_void_ledger`（CREATE＋GRANT SELECT/INSERT・append-only）。
  行削除は許可しない（状態列の更新のみ）。token `GRANT_PRODUCTION_DOCUMENT_VOID`。
- `documents/document-void-schema.ts`：確認トークン `COMMIT_DOCUMENT_VOID`＋任意 reason（≤500）。
- `documents/document-void-repository.ts`：Pg/Memory。SELECT ... FOR UPDATE → 既 void は
  `alreadyVoided:true` で副作用なし → documents 更新 → condition_events 取消（RETURNING で
  影響明細 ID を集計）→ 台帳記録。42501 は `DOCUMENT_VOID_FORBIDDEN_DB`（503）へ橋渡し。
- `documents/document-void-routes.ts`：`POST /api/v2/documents/:id/void`（admin/legal・
  既定OFF時は503・確認トークン必須）。Backlog 書き戻しは backlog-comment 有効時のみベストエフォート。
- config `documentVoidEnabled`（`DOCUMENT_VOID_ENABLED`）／app.ts（gating・safe-write scope
  `document-void`・writeCapabilities）／verify（true/false＋validation-only＋本番DB＋IAP/IAM＋
  WRITE_SCOPES 正準順に `document-void`）／cloudbuild（subs 既定false・export・ENVVARS）全結線。
- 読取：`registry-repository` の一覧・詳細に `lifecycle_status`（COALESCE 'final'）を追加。
- UI：`DocumentRegistry` に無効化バッジ（一覧）＋ void 危険操作ゾーン（詳細・capability-gated・
  合言葉入力＋理由）。void 済みは出力アクションを隠しバナー表示。
- tests：ルート 7（無効/403/トークン不正/実行＋通知/404/既void/FORBIDDEN_DB）。584 緑。

### 点火（本番）
```bash
# preflight（列・現状内訳・権限の確認）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/033_production_document_void_preflight.sql || true
# grant 適用
psql "$RUNTIME_ADMIN_DSN" -v confirm_document_void=GRANT_PRODUCTION_DOCUMENT_VOID \
  -f infra/gcp/sql/033_production_document_void_grants.sql
```
デプロイは Profile D の substitutions 末尾へ：
```
|_DOCUMENT_VOID_ENABLED=true|_CONFIRM_DOCUMENT_VOID=DOCUMENT_VOID_LEGALBRIDGE_VALIDATION_ONLY
```
かつ `_WRITE_SCOPES` の `matter-delete` の直後に `document-void` を追加（正準順）。

## 10-3：PDF 再生成（Drive 上書き更新）✅ 実装済

ダウンロード用 PDF は `GET /documents/:id/pdf` が常に保存データ＋現行テンプレートから
再レンダリングするため既に「再生成」済み。欠けていたのは **Drive 保存済みコピーの更新**：
既存 `POST /documents/:id/drive` は driveLink があると再利用し、データ／テンプレート変更後も
Drive のファイルが古いままになる。10-3 はこれを解消する。

- `drive-storage.ts` に `updatePdf({fileId, pdf})` を追加（Drive v3 media PATCH で**既存
  ファイルの中身のみ差し替え**・リンク/ID は維持）。Google/Memory 両実装。
- `drive-routes.ts` に `POST /documents/:id/drive/regenerate`：保存データ＋現行テンプレートから
  再レンダリング → 既存 Drive ファイルがあれば `updatePdf` で上書き（200・リンク維持）、
  無ければ新規 `uploadPdf`（201・created:true）。**既存 drive scope に従属・新規 grant/config なし**。
- app.ts の safe-write ガード正規表現を `/documents/:id/drive(/regenerate)?` に拡張。
- UI：`DocumentOutputActions` に「PDFを再生成（Drive更新）」ボタン（Drive 保存済みのときのみ表示）。
- tests：drive-routes に3件追加（上書き更新／未保存は新規／scope なし403）。587 緑。

## 10-6：文書ルックアップ（読取専用）✅ 実装済

発行後運用の下支えとなる読取ユーティリティ3種。**すべて SELECT のみ＝新規 GRANT/config なし**。
稟議リンク（Ringi）は保留決定済みのため対象外、mark-as-imported は取込フロー側の責務のため見送り。

- `registry-repository.findByNumber(documentNumber)` を追加（Pg/Memory）。
- `document-lookup-repository.ts`（Pg/Memory）：
  - `pendingPdf(templateType?, limit)`＝Drive 未保存かつ void でない文書の一覧＋種別別件数
    （PDF 未生成キュー）。
  - `peekNextNumber(templateType)`＝**非破壊**の次番号プレビュー。V1（`getNewDocumentNumber`）は
    document_sequences を増分するが、V2 はプレビューで採番を消費しない（SELECT のみ）。採番接頭辞・
    番号組み立ては finalize と共用の純関数 `resolveNumberPrefix`/`formatDocumentNumber` に集約。
- `document-lookup-routes.ts`：`GET /documents/by-number/:docNumber`／`GET /documents/pending-pdf`／
  `GET /documents/numbering/next?type=`。読取＝認証済みユーザー可・ロール限定なし。
- app.ts：`/documents/:id`（registry）に吸われないよう **registry ルーターより前にマウント**。
- finalize リファクタ：`findPrefix`／番号生成を共用純関数へ委譲（挙動不変）。tests 594 緑。

> UI 統合は 10-1 アーカイブ画面（PDF未生成キュー表示・番号検索・再発行導線）で行う。本スライスは
> その土台となる読取 API を提供する。

## 10-1：文書アーカイブ（既存レジストリに集約）✅ 実装済

V1 の別ページ ArchivePage を新設せず、V2 で既にアーカイブを担う `DocumentRegistry` に機能を集約
（UX 重複回避）。発行後の void（10-2）・PDF 再生成（10-3）・ルックアップ（10-6）の集約 UI。

- **状態フィルタ**（読取）：`registry-repository.list` に `lifecycle`（all/active/voided）を追加。
  `GET /documents?lifecycle=` で切替（Pg/Memory）。UI は「すべて／有効のみ／無効化のみ」セレクト。
- **PDF未生成キュー**：UI トグルで一覧ソースを `GET /documents/pending-pdf`（10-6）へ切替。
- **バージョン履歴**（include_history）：`registry-repository.versionHistory(id)` を追加
  （同一 `base_document_number` 系列を古い順・Pg/Memory）。`GET /documents/:id/history`
  （lookup ルーターに配置＝`/documents/:id` に吸われない）。UI は詳細ペインに系列を表示し、
  各版クリックで切替（正本/旧版/無効化バッジ・単一版なら非表示）。
- tests：history（系列2件・単一1件）／lifecycle フィルタ（voided/active）を追加。597 緑。
- **新規 grant/config なし**（すべて読取）。

> **再発行（reissue・write）は 10-1b へ分離**：新しい版を採番して旧版を superseded にする書込みは
> 専用の列レベル GRANT（documents.superseded_by/is_primary/lifecycle_status）＋確認トークンが必要で、
> void（10-2 grant 033）と重なる部分もあるため独立スライスで扱う。

## 10-1b：文書再発行（reissue）✅ 実装済

既存確定文書を基に新版 `<base>-R<n>` を採番して発行し、旧版を supersede する guarded-write。
**重要**：V2 の残高は `condition_events.voided_at IS NULL` のみで判定し文書 lifecycle では絞らない
（`conditions/repository.ts` で確認）。そのため旧版の実績を残すと二重計上になるため、再発行時に
旧版の有効実績を同一トランザクションで取消する（void 10-2 と同じ列 UPDATE を再利用）。

- **grant 034**（`034_production_document_reissue_grants.sql`＋preflight）：列レベル
  `UPDATE(lifecycle_status, is_primary, superseded_by) ON documents` ＋
  `UPDATE(voided_at, void_reason) ON condition_events`（033 と同一・再掲）。INSERT は 006 の表レベルで既付与。
  監査は隔離台帳 `lb_v2_document_reissue_ledger`（append-only）。token `GRANT_PRODUCTION_DOCUMENT_REISSUE`。
- `document-reissue-schema.ts`：確認トークン `COMMIT_DOCUMENT_REISSUE`＋任意 reason＋任意 formData
  （省略時は旧版内容を複製）。
- `document-reissue-repository.ts`（Pg/Memory）：`nextReissueNumber`（純関数・系列最大版+1）＋
  トランザクション（source を FOR UPDATE→voided は 409→系列ロック→新版 INSERT〈final/primary〉→
  系列他行 is_primary=false→旧版 reissued＋superseded_by→旧版実績取消→台帳）。42501 は FORBIDDEN_DB。
- `document-reissue-routes.ts`：`POST /documents/:id/reissue`（admin/legal・既定OFF503・確認トークン・
  404/409/503）。Backlog 書戻しは backlog-comment 有効時のみ（旧版 issue_key を registry から解決）。
- config `DOCUMENT_REISSUE_ENABLED`／app.ts（gating・safe-write scope `document-reissue`・
  writeCapabilities）／verify（validation-only＋本番DB＋IAP/IAM＋WRITE_SCOPES 正準順に `document-reissue`）／
  cloudbuild（subs/export/ENVVARS）全結線。
- UI：`DocumentRegistry` の詳細ペインに「再発行」ゾーン（capability-gated・合言葉＋理由）。成功で新版へ切替。
- tests：nextReissueNumber＋ルート（無効/403/トークン/実行＋通知/404/voided 409/FORBIDDEN_DB）8件。605 緑。

### 点火（本番）
```bash
psql "" -f infra/gcp/sql/034_production_document_reissue_preflight.sql || true
psql "" -v confirm_document_reissue=GRANT_PRODUCTION_DOCUMENT_REISSUE \
  -f infra/gcp/sql/034_production_document_reissue_grants.sql
```
デプロイは Profile D substitutions 末尾へ
`|_DOCUMENT_REISSUE_ENABLED=true|_CONFIRM_DOCUMENT_REISSUE=DOCUMENT_REISSUE_LEGALBRIDGE_VALIDATION_ONLY`
＋ `_WRITE_SCOPES` の `document-void` の直後に `document-reissue` を追加（正準順）。

## 10-4：一括無効化（bulk void）✅ 実装済

V1 の bulk-delete（ハード削除＋force カスケード）は V2 の方針（ソフト void）と合わないため、
V2 では **複数文書の一括 void** として実装。**既存 document-void ケーパビリティ・grant 033 を
共用＝新規 grant/config/scope なし**（現行デプロイで既に有効）。

- `document-void-schema.ts`：`documentVoidBulkSchema`（ids 1..200・確認トークン共通・reason 任意）。
- `document-void-repository.ts`：`voidMany(ids, input, actor)`＝各 id を個別トランザクションで
  `void()`→成否集計（voided/already/not_found/error）。**FORBIDDEN_DB（grant 未整備）は全体中断**。
  重複 id は1回に集約。共通ロジック `runVoidMany` を Pg/Memory で共用。
- `document-void-routes.ts`：`POST /documents/void-bulk`（admin/legal・既定OFF503・確認トークン）。
- app.ts：safe-write ガードに `/documents/void-bulk` を追加（document-void 有効時）。
- UI：`DocumentRegistry` にチェックボックス列（void 済みは対象外）＋全選択＋一括無効化バー
  （合言葉＋理由・結果トースト集計）。一覧の再取得・状態切替で選択はクリア。
- tests：混在集計／無効時503／トークン不正／FORBIDDEN_DB 全体中断 の4件。609 緑。

> **一括項目更新（bulk-update-fields）は将来拡張**：form_data の広範な UPDATE 権限が必要で
> （JSONB 全体・列スコープ不可）、V1 の対象フィールドも発注/検収固有。優先低のため見送り。

## 次スライス候補
- **10-5 Excel 一括出力**（大）。

## 既知の限定（将来拡張）
- 再発行は旧版の実績を**取消**する（carryover は未実装）。新版で実績が要る場合は再入力する。
  V1 の `carryOverReissueConsumption`（一意対応時のみ引継ぎ）は将来スライスで検討。
