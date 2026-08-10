# Phase 10：文書運用オペレーション（発行後の管理）

V2 は draft→finalize→pdf→drive までは移植済みだが、**発行後の運用系**（void／再発行／
アーカイブ／PDF 再生成／Excel 一括）が欠落していた。本フェーズはこれを既存 guarded パターン
（既定OFF・確認トークン・列レベル GRANT・隔離台帳）で段階移植する。

## スライス

| # | 機能 | 粒度 | 状態 |
|---|---|---|---|
| 10-2 | 文書 void（無効化）＋実績取消（残高復元） | 小 | ✅ 実装済 |
| 10-3 | PDF 再生成 | 小 | 未 |
| 10-1 | 文書アーカイブ画面＋再発行 | 中 | 未 |
| 10-6 | 文書ルックアップ（番号検索・次番号・PDF未生成一覧） | 小 | 未 |
| 10-4 | 一括削除／一括項目更新 | 中 | 未（優先低） |
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

## 次スライス候補
- **10-3 PDF 再生成**：確定文書の PDF を再レンダリング（既存 pdf-renderer 再利用・grant 不要・
  Drive 保存は drive scope に従属）。小。
- **10-1 アーカイブ画面**：確定文書の一覧・履歴トグル・再編集/再発行導線（読取＋既存 void/再生成の集約）。
