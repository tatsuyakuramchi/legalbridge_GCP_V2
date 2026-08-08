# Phase 8：案件管理の欠落機能（V1→V2 パリティ）

V1 突合で判明した、V2 に欠けている案件管理機能を段階的に移植する。V1 の案件詳細は
Drive フォルダ・課題紐付け・文書リンク・送信履歴・名寄せ（マージ）まで備えるが、V2 は
list/detail/create/update/task と Slack（Phase 7）まで。以下を guarded-write で補う。

## 欠落一覧（V1 あり / V2 なし）

| 機能 | V1 | Phase 8 |
|---|---|---|
| 課題（Backlog）紐付け 追加/解除（`matter_issues`） | あり | **8-1 実装済** |
| 文書リンク/解除（`documents.matter_id`） | あり | 8-2（予定） |
| 送信履歴（`document_sends`：email/slack/drive/manual） | あり | 8-3（予定） |
| Drive フォルダ連携（作成/添付/一覧/Drive→文書登録） | あり | 8-4（予定・重量級） |
| 名寄せ（案件マージ/absorb） | あり | 8-5（予定・複数表write） |
| 案件削除・タスク削除 | あり | 8-6（予定・破壊的） |

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

## 有効化

案件編集（`MATTER_WRITES_ENABLED=true`＋scope `matters`）に加え、**grant 025 を本番適用**：

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/025_production_matter_issue_links_preflight.sql || true
psql "$RUNTIME_ADMIN_DSN" -v confirm_matter_issue_links=GRANT_PRODUCTION_MATTER_ISSUE_LINKS \
  -f infra/gcp/sql/025_production_matter_issue_links_grants.sql
```
