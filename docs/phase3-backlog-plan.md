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
