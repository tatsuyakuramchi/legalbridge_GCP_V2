# Phase 3：Backlog双方向 & 依頼 — 計画と棚卸し

Backlog課題を起点にリーガル業務へ取り込み（読取）、V2側の操作をBacklogへ書き戻す（双方向）。Phase 1〜6と同じ原則：**読取先行 → guarded 書込み**、外部API書込みは既定OFF＋確認、プロジェクト固有IDが要る同期は判断ポイント。

## 1. 現状棚卸し

- `BacklogWebApiClient`（`integrations/backlog-web-api.ts`）は当初 **`getProject()`（接続確認）のみ**。課題一覧・依頼取込・書き戻しは未実装。
- 連携は `BACKLOG_MODE`（disabled/readonly）＋`BACKLOG_HOST`/`BACKLOG_PROJECT_KEY`/`BACKLOG_API_KEY` で制御。`readonly` かつ接続情報が揃うと `BacklogReadOnlyIntegrationAdapter` が接続確認に用いられる。
- V2に「依頼(requests)」画面は無かった（ナビ 業務＞依頼 は ❌）。

## 2. スライス分割

| # | 内容 | 種別 | 判断 |
|---|---|---|---|
| **3-1** | Backlog課題一覧 → 依頼画面（課題起点で文書作成） | 読取 | 不要（`BACKLOG_MODE=readonly`＋接続情報） |
| **3-2** | 書き戻し：コメント投稿 | 書込 | ✅ guarded＋確認＋新capability `backlog-comment`（`BACKLOG_MODE=live`非依存） |
| 3-2b | 書き戻し：ステータス同期／カスタム属性更新 | 書込 | **要判断**：status ID・custom field ID はプロジェクト固有。運用側から実値を確定してから |
| **3-3** | 変数自動抽出（課題本文→フォーム変数を非破壊シード） | 読取/変換 | ✅ 純関数＋別名表・依存ゼロ |

### 決定ポイント（3-2b 着手前）
- **書き戻し範囲**：どの属性/ステータスを同期するか。ステータスIDとカスタムフィールドIDはBacklogプロジェクト固有のため、実値（`GET /projects/:key/statuses`・`/customFields`）を確定してからマッピングを実装する。コメント投稿（3-2）はID非依存で先行可能。

## 3. Slice 3-1（実装済み）

- `backlog-web-api.ts`：`BacklogReadClient` に `getIssues({count,keyword})` を追加。`resolveProjectId()` で projectId を一度解決し `GET /api/v2/issues?projectId[]=…&sort=updated&order=desc` を呼ぶ。`mapIssue` が id/issueKey/summary/status.name/assignee.name/created/updated を防御的に整形。APIキーは例外メッセージに含めない（既存方針踏襲）。
- `integrations/backlog-routes.ts`：`GET /api/v2/backlog/issues`（admin/legal限定・読取）。クライアント未構成（`BACKLOG_MODE≠readonly` 等）は `{enabled:false, issues:[]}`。`BacklogApiError` は 502。
- app.ts：`BACKLOG_MODE=readonly`＋接続情報がある時のみ読取クライアントを構築して結線（`defaultBacklogClient()`）。書込みなし・safe-methods はGETで自動許可。
- UI `RequestsWorkspace.tsx`（業務＞依頼・legal/requester）：課題を検索一覧し、「この課題で文書作成」で issueKey を文書作成に引き継ぐ（V1の「課題→リーガルリクエスト」導線）。未設定時は設定案内。
- テスト：`getIssues`（mock fetch・projectId解決・整形）＋ルート（403/enabled:false/成功/502）。テスト405件。**新規GRANT・依存なし**。有効化は `BACKLOG_MODE=readonly`＋`BACKLOG_HOST`/`BACKLOG_PROJECT_KEY`/`BACKLOG_API_KEY`（既存env）。

## 4. Slice 3-2b-prep（実装済み・メタデータ一覧API）

3-2b（ステータス同期・カスタム属性更新）の本体はプロジェクト固有IDが要るため、**まず実IDを確認できる読取API**を先行実装した（判断：2026-08-06「まず一覧APIを追加」）。

- `backlog-web-api.ts`：`BacklogReadClient` に `getProjectMetadata()` を追加。`GET /api/v2/projects/:key/statuses`・`/customFields` を叩き、`{statuses:[{id,name}], customFields:[{id,name,typeId}]}` に整形（`mapStatus`/`mapCustomField`・防御的）。共通ヘルパ `getJsonArray()` を追加。APIキーは例外に含めない方針を踏襲。
- `backlog-routes.ts`：`GET /api/v2/backlog/metadata`（admin/legal限定・読取）。未構成は `{enabled:false, statuses:[], customFields:[]}`、`BacklogApiError` は 502。
- UI `RequestsWorkspace.tsx`：ツールバーに「プロジェクトID一覧」トグル。オンデマンドで status ID / custom field ID を読取専用表示（3-2b の同期設定時の参照値）。403/未設定は文言で案内。
- テスト：メタデータ取得（mock fetch・整形・APIキー付与）＋ルート（403/enabled:false/成功/502）＋APIエラー時のキー非漏洩。テスト420件。**新規GRANT・依存なし**（読取のみ・書込増分なし）。

### 決定事項の確定（2026-08-06）

| 項目 | 決定 | 内容 |
|---|---|---|
| 3-2b ステータス/属性同期 | **まず一覧APIを先行** | 実ID確認用の読取APIを実装（本スライス）。同期本体は運用側が実IDを確認しマッピングを確定してから別スライスで着手 |
| 稟議(Ringi) | **保留/廃止** | V2へ移植しない。承認は Slack承認（`slack-approvals`）／案件ステータスで代替。将来必要なら別スライスで再判断 |
| 製品(products) | **オプションA継続** | 製品専用テーブルは新設しない（DDL回避）。製品は既存エンティティ（作品・素材・条件）で表現 |
