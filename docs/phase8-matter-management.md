# Phase 8：案件管理の欠落機能（V1→V2 パリティ）

V1 突合で判明した、V2 に欠けている案件管理機能を段階的に移植する。V1 の案件詳細は
Drive フォルダ・課題紐付け・文書リンク・送信履歴・名寄せ（マージ）まで備えるが、V2 は
list/detail/create/update/task と Slack（Phase 7）まで。以下を guarded-write で補う。

## 欠落一覧（V1 あり / V2 なし）

| 機能 | V1 | Phase 8 |
|---|---|---|
| 課題（Backlog）紐付け 追加/解除（`matter_issues`） | あり | **8-1 実装済** |
| 文書リンク/解除（`documents.matter_id`） | あり | **8-2 実装済** |
| 送信履歴（`document_sends`：email/slack/drive/manual） | あり | **8-3 実装済** |
| Drive フォルダ連携（作成/添付/一覧/Drive→文書登録） | あり | **8-4 実装済**（作成/一覧）＋**8-2b 実装済**（Drive→文書登録） |
| 名寄せ（案件マージ/absorb） | あり | **8-5 実装済**（複数表write・grant 028） |
| 案件削除・タスク削除 | あり | **8-6 実装済**（破壊的・grant 029・専用フラグ＋合言葉） |

## スライス 8-1（実装済）：課題紐付け 追加/解除

- **grant 025**（`025_production_matter_issue_links_grants.sql`・トークン
  `GRANT_PRODUCTION_MATTER_ISSUE_LINKS`）：`matter_issues` に INSERT/UPDATE/DELETE を付与
  （006 で SELECT 済・008 は matters/matter_tasks のみ）＋ preflight。
- `matter-issue-write-repository.ts`（Pg/Memory）：`attach`（V1 準拠 UPSERT・relation 更新）、
  `detach`（紐付け解除のみ・課題自体は消さない）。権限不足(42501)は
  `MATTER_ISSUE_GRANT_MISSING`(503) に翻訳。
- ルート（`write-routes` に追加・**案件編集権限 `matterWriteEnabled` を共有**）：
  `POST /matters/:id/issues`（attach）／`DELETE /matters/:id/issues/:key`（detach）。
  app.ts の write-guard allowlist にも両パスを追加。
- UI：`MatterRegistry` 関連課題セクションに `MatterIssueLinks`（キー入力＋relation 選択＋
  紐付け／各行に解除ボタン）。
- **フラグ乱立回避**：新スコープ/フラグは追加せず、既存 `matters` スコープ＋
  `MATTER_WRITES_ENABLED` を再利用。有効化時は grant 025 の適用が前提（未適用は 503）。
- テスト（attach UPSERT・detach removed・503/403・400）。

## スライス 8-2（実装済）：文書リンク/解除

- **grant 026**（`026_production_matter_document_links_grants.sql`・トークン
  `GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS`）：`documents` に**列レベル UPDATE(matter_id) のみ**を付与
  （最小権限・他列は更新不可）＋preflight（`role_column_grants` で確認）。
- `matter-document-write-repository.ts`（Pg/Memory）：`link`（`UPDATE documents SET matter_id`・
  対象無しは `MATTER_DOCUMENT_NOT_FOUND`404）／`unlink`（`SET matter_id=NULL WHERE ... AND matter_id`・
  removed 返却）。42501→`MATTER_DOCUMENT_GRANT_MISSING`503。
- ルート（`matterWriteEnabled` 共有）：`POST /matters/:id/documents`（documentId 指定）／
  `DELETE /matters/:id/documents/:docId`。write-guard allowlist にも追加。
- UI：`MatterRegistry` 関連文書に `MatterDocumentLinks`（文書ID入力で紐付け／各行に解除）。

## スライス 8-2b（実装済）：Drive ファイル → 案件文書として新規登録

V1 の `POST /api/matters/:id/documents/from-drive` 相当。案件フォルダ内の Drive ファイルを
外部文書（`template_type='external_file'`）として `documents` に登録し案件へ紐付ける。

- **新規 grant 不要**：`documents` の INSERT は grant 006（SELECT/INSERT）で付与済み。
  `document_number` は NULL（外部ファイルは採番しない・V1 と同じ）、ファイル名は `form_data`
  （`{title, source:"drive"}`）に格納。
- `matter-document-write-repository.ts` に `registerFromDrive(matterId, {link, name})` を追加
  （Pg/Memory）。**冪等**：同一案件×同一 `drive_link` が既にあれば作らず既存を返す（`created:false`）。
- ルート（`write-routes` に追加・`matterWriteEnabled` 共有）：
  `POST /matters/:id/documents/from-drive`（新規=201／既存=200）。write-guard allowlist にも追加。
- UI：`MatterDriveFolder` のファイル一覧の各ファイルに「案件文書に登録」ボタン（登録後は詳細を再取得）。
- テスト（新規created:true・冪等created:false・503/400・403）。

## スライス 8-3（実装済）：送信履歴（document_sends）

- **grant 027**（`027_production_matter_sends_grants.sql`・トークン `GRANT_PRODUCTION_MATTER_SENDS`）：
  `document_sends` に SELECT/INSERT（append専用・UPDATE/DELETE なし）＋sequence＋preflight。006 未付与。
- `matter-send-repository.ts`（Pg/Memory）：`list`（新しい順）／`record`（channel email/slack/drive/manual・
  status sent/failed/queued）。42501→`MATTER_SEND_GRANT_MISSING`503。
- `matter-send-routes.ts`：`GET /matters/:id/sends`（read・admin/legal・台帳無しは enabled:false）／
  `POST /matters/:id/sends`（append・`matterWriteEnabled` 共有・sentBy は current user）。
  write-guard allowlist に POST を追加。
- UI：`MatterSends`（送信履歴一覧＋手動記録フォーム：文書選択/チャネル/宛先）。

## スライス 8-4（実装済）：Drive フォルダ連携（作成/一覧）

- `documents/drive-folder.ts`：`MatterDriveFolderService`（Google/Local/Memory・drive-storage と同じ Drive SA
  認証を生 fetch で再利用）。`ensureFolder`（親フォルダ配下に同名検索→無ければ作成＝冪等）／
  `listFiles`（フォルダ内一覧）＋純関数 `matterFolderName`。
- `matter-drive-repository.ts`（Pg/Memory）：`getFolder`/`setFolder`（`matters.drive_folder_id/url`・
  **008 の matters UPDATE 権限で更新可＝新規 grant 不要**）。42501→`MATTER_DRIVE_GRANT_MISSING`503。
- `matter-drive-routes.ts`：`POST /matters/:id/drive-folder`（作成/取得・冪等・案件編集権限＋Drive設定）／
  `GET /matters/:id/drive-files`（一覧・read）。write-guard allowlist に POST 追加。
- 有効化ゲート：`driveStorageEnabled`（scope `drive`＋`DRIVE_STORAGE_ENABLED`＋SA）で読取、加えて
  `matterWriteEnabled` で作成（**新フラグ無し**・既存 Drive 能力＋案件編集を再利用）。
- UI：`MatterDriveFolder`（フォルダ作成ボタン／開くリンク＋フォルダ内ファイル一覧）。
- `from-drive`（Drive ファイル→新規文書登録）は V1 固有列のため 8-2b へ。

## スライス 8-5（実装済）：名寄せ（案件マージ / absorb）

V1 の `POST /api/matters/:id/absorb` 相当。重複案件（source）を存続案件（target）へ寄せ、
紐付き（課題・タスク・文書・送信履歴）を移送する。破壊的なので**専用フラグ＋scope＋合言葉**。

- **grant 028**（`028_production_matter_sends_matter_id_grants.sql`・トークン
  `GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID`）：`document_sends` に**列レベル UPDATE(matter_id) のみ**を付与
  （027 は SELECT/INSERT のみ・履歴移送に matter_id 更新が必要）＋preflight。
  課題は 025（UPDATE）、文書は 026（UPDATE(matter_id)）、タスク/matters は 008（UPDATE）で移送。
- `matter-merge-schema.ts`：合言葉 `COMMIT_MATTER_MERGE`・自己マージ拒否。
- `matter-merge-repository.ts`（Pg/Memory）：`preview`（SELECT のみ・移送件数を集計・GRANT不要／
  権限未付与の表は count=null）／`merge`（トランザクション・両案件 `FOR UPDATE`・課題は衝突する
  `backlog_issue_key` を source に残す・タスクは `is_primary=FALSE` へ降格・文書/送信履歴は matter_id 付替え・
  target 未設定なら Drive フォルダを DB 上で引継ぎ・source は `status='archived'`＝**DELETE しない**）。
  42501→`MATTER_MERGE_FORBIDDEN_DB`503。
- `matter-merge-routes.ts`：`GET /matter-merge/preview`（read・admin/legal・書込無効でも可）／
  `POST /matter-merge`（guarded・専用フラグ `MATTER_MERGE_ENABLED`＋scope `matter-merge`＋合言葉）。
  app.ts の write-guard allowlist に `POST /matter-merge` を追加。
- 有効化ゲート：`accessMode=readwrite`＋`WRITE_FEATURES_ENABLED`＋scope `matter-merge`＋
  `MATTER_MERGE_ENABLED=true`＋DB接続。capability `matter-merge` を露出（UI 実行ボタンの条件）。
- verify/cloudbuild：`_MATTER_MERGE_ENABLED` / `_CONFIRM_MATTER_MERGE`（=`MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY`）
  を追加。有効時は write-test サービス・production DB・IAP/Cloud Run IAM を要求。
- UI：`MatterMerge`（設定 > 案件名寄せ・存続先/統合元ID→プレビュー→合言葉→実行）。
- テスト（プレビュー集計・403/404/400・503・移送＋アーカイブ＋Drive引継ぎ・自己マージ拒否）。

## スライス 8-6（実装済）：案件削除・タスク削除（破壊的）

V1 の `DELETE /api/matters/:id`・`DELETE /api/matters/:id/tasks/:taskId` 相当。取り返しがつかない
ため**専用フラグ＋scope＋合言葉**（案件削除）で隔離する。

- **grant 029**（`029_production_matter_delete_grants.sql`・トークン `GRANT_PRODUCTION_MATTER_DELETE`）：
  `matters`・`matter_tasks` に DELETE を付与＋preflight。**案件削除は `DELETE FROM matters` のみ**を実行し、
  FK 参照アクションで `matter_issues`／`matter_tasks`（ON DELETE CASCADE）を連鎖削除、
  `documents.matter_id`／`document_sends.matter_id`（ON DELETE SET NULL）を解除する。
  参照アクションは PostgreSQL 内部実行のため、削除ロールに参照先表の権限は不要（本番文書の行は消えない・解除のみ）。
  preflight は matters を参照する FK の `confdeltype` を一覧し想定外の CASCADE が無いか確認する。
- `matter-delete-schema.ts`：合言葉 `COMMIT_MATTER_DELETE`（案件削除のみ）。
- `matter-delete-repository.ts`（Pg/Memory）：`preview`（連鎖=cascade／解除=unlink の件数を集計・GRANT不要）／
  `deleteMatter`（`FOR UPDATE`→件数確定→`DELETE FROM matters`・42501→`MATTER_DELETE_FORBIDDEN_DB`503・
  23503→`MATTER_DELETE_REFERENCED`409）／`deleteTask`（**代表タスク is_primary は拒否**＝`MATTER_TASK_PRIMARY`409／
  非代表のみ削除・無ければ 404）。
- `matter-delete-routes.ts`：`GET /matters/:id/delete-preview`（read・admin/legal）／
  `DELETE /matters/:id`（guarded・合言葉）／`DELETE /matters/:id/tasks/:taskId`（guarded・合言葉不要）。
  app.ts write-guard allowlist に両 DELETE を追加。
- 有効化ゲート：`accessMode=readwrite`＋`WRITE_FEATURES_ENABLED`＋scope `matter-delete`＋
  `MATTER_DELETE_ENABLED=true`＋DB接続。capability `matter-delete` を露出。
- verify/cloudbuild：`_MATTER_DELETE_ENABLED`／`_CONFIRM_MATTER_DELETE`（=`MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY`）
  を追加。有効時は write-test サービス・production DB・IAP/Cloud Run IAM を要求。
- UI：`MatterRegistry` 案件詳細に「危険操作」（削除プレビュー→合言葉→削除・削除後は一覧を再取得）＋
  タスク行に削除ボタン（非代表のみ）。capability 未付与では非表示。
- テスト（プレビュー cascade/unlink・403/404・503・確認トークン・削除・代表タスク409・非代表削除・404）。

## 有効化

> **段階的な有効化（GRANT＋デプロイ substitution＋scope 正準順＋確認）を一枚にまとめた手順は
> `docs/phase8-matter-enablement-runbook.md`（Phase 7/8 横断）を参照。** 以下は最小の抜粋。

案件編集（`MATTER_WRITES_ENABLED=true`＋scope `matters`）に加え、**grant 025/026/027 を本番適用**：

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/025_production_matter_issue_links_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_issue_links=GRANT_PRODUCTION_MATTER_ISSUE_LINKS \
  -f infra/gcp/sql/025_production_matter_issue_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/026_production_matter_document_links_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_document_links=GRANT_PRODUCTION_MATTER_DOCUMENT_LINKS \
  -f infra/gcp/sql/026_production_matter_document_links_grants.sql
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/027_production_matter_sends_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends=GRANT_PRODUCTION_MATTER_SENDS \
  -f infra/gcp/sql/027_production_matter_sends_grants.sql
```

名寄せ（8-5）を有効化する場合は、加えて **grant 028 を本番適用**し、デプロイで
`_MATTER_MERGE_ENABLED=true` / `_CONFIRM_MATTER_MERGE=MATTER_MERGE_LEGALBRIDGE_VALIDATION_ONLY`
と WRITE_SCOPES に `matter-merge` を含める：

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/028_production_matter_sends_matter_id_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_sends_matter_id=GRANT_PRODUCTION_MATTER_SENDS_MATTER_ID \
  -f infra/gcp/sql/028_production_matter_sends_matter_id_grants.sql
```

案件・タスク削除（8-6）を有効化する場合は、加えて **grant 029 を本番適用**（preflight で
matters を参照する FK の ON DELETE アクションを確認）し、デプロイで
`_MATTER_DELETE_ENABLED=true` / `_CONFIRM_MATTER_DELETE=MATTER_DELETE_LEGALBRIDGE_VALIDATION_ONLY`
と WRITE_SCOPES に `matter-delete` を含める：

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/029_production_matter_delete_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_delete=GRANT_PRODUCTION_MATTER_DELETE \
  -f infra/gcp/sql/029_production_matter_delete_grants.sql
```
