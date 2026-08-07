# Phase 5 DB フォローアップ — 隔離テーブル本番付与 & 依頼者メール露出

Phase 5 のコード側スライス（5-1〜5-4）で残った **DB 側作業**の適用手順。いずれも
本番 `legalbridge` に対する DDL/GRANT で、preflight（読取専用）→ 本適用の順で行う。
アプリのコードは適用済み（フラグ OFF 既定）なので、DB 適用後にフラグを立てて有効化する。

対象：
- **A. Gmail 送信の冪等履歴**（スライス5-1）… `lb_v2_gmail_send_history` を本番に作成＋付与。
- **B. Gmail 受信の取込台帳**（スライス5-2）… `lb_v2_inbound_contracts` を本番に作成＋付与。
- **C. Slack 依頼者メール露出**（スライス5-3・gap ⑥）… `matter_overview_v` に依頼者メールを露出。

> 検証DB（`legalbridge_v2_validation` / write-test サービス）で先に流す場合は
> `019_gmail_send_history_validation.sql` / `020_inbound_contract_intake_validation.sql`
> を使う（作成＋`legalbridge_v2_validation_writer` へ付与）。本ドキュメントは**本番**の手順。

前提：`006_production_v2_runtime_foundation.sql` 適用済み（`legalbridge_v2_runtime`
ロール・`CONNECT`/`USAGE public` 済み）。`RUNTIME_ADMIN_DSN` は DDL/GRANT 権限を持つ
管理接続（Cloud SQL の所有者/管理ロール）を指す。

---

## A. Gmail 送信の冪等履歴（`lb_v2_gmail_send_history`）

append 専用・`idempotency_key` 一意・**SELECT/INSERT のみ**（UPDATE/DELETE/TRUNCATE 無し）。

```bash
# 1) 事前確認（テーブル未作成なら「missing」で正常に停止）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/019_gmail_send_history_production_preflight.sql || true

# 2) 作成＋付与（本番 legalbridge・冪等: IF NOT EXISTS）
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_gmail_send_history=GRANT_PRODUCTION_GMAIL_SEND_HISTORY \
  -f infra/gcp/sql/019_gmail_send_history_production_grants.sql

# 3) 事後確認（runtime に SELECT, INSERT が出ていること）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/019_gmail_send_history_production_preflight.sql
```

有効化：本番デプロイ substitution に `_GMAIL_SEND_HISTORY_ENABLED=true`。
（現状のアプリガードは write-test サービス限定なので、本番サービスで有効化するには
`verify-write-test.sh` の該当 case のサービス名条件を本番サービスへ拡張、または本番用
verify に同等ガードを追加する。DB 付与だけでは挙動は変わらない＝安全。）

ロールバック：`_GMAIL_SEND_HISTORY_ENABLED=false` で再デプロイ（アプリは即座に従来動作へ）。
テーブルは隔離・append 専用のため残置で無害。物理削除する場合は別途
`DROP TABLE public.lb_v2_gmail_send_history;`（要管理接続・通常不要）。

---

## B. Gmail 受信の取込台帳（`lb_v2_inbound_contracts`）

append＋status 遷移・`idempotency_key`(message+attachment 指紋) 一意・**SELECT/INSERT/UPDATE**
（UPDATE は `captured→linked/dismissed` の遷移のみ。DELETE/TRUNCATE 無し）。

```bash
# 1) 事前確認
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/020_inbound_contract_intake_production_preflight.sql || true

# 2) 作成＋付与
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_inbound_intake=GRANT_PRODUCTION_INBOUND_INTAKE \
  -f infra/gcp/sql/020_inbound_contract_intake_production_grants.sql

# 3) 事後確認（runtime に SELECT, INSERT, UPDATE）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/020_inbound_contract_intake_production_preflight.sql
```

有効化：`_GMAIL_INBOUND_INTAKE_ENABLED=true`（Aと同じくサービス名ガードの扱いに注意）。
`register` ルートは Gmail 受信 live（`GMAIL_INBOUND_MODE=live`＋scope `gmail-inbound`）も必要。
ロールバック：`_GMAIL_INBOUND_INTAKE_ENABLED=false` で従来動作（閲覧+DLのみ）へ。

---

## C. Slack 依頼者メール露出（`matter_overview_v` 拡張・gap ⑥）

**背景**：アプリの `mapSummary`（`matters/repository.ts`）は依頼者メールを
`requester_email → created_by → requester` の順で読む。スライス5-3 で
「全メールを null 化していた正規表現バグ」は修正済み。**残るのは、ビューが上記いずれかの
列で依頼者メールを実際に露出すること**。

**注意**：`matter_overview_v` の現行定義は本 repo に無い（V1本番側の既存ビュー）。
`CREATE OR REPLACE VIEW` は**全既存カラムを保持したまま**1列追加する必要があり、
現行定義を知らずに書くと既存カラムを壊す。よって **introspect → 定義確定 → 適用**の順で行う。

### C-1. 現行定義と候補列の調査（読取専用）

```bash
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/021_matter_overview_requester_introspect.sql
```

出力で確認すること：
- (1) `pg_get_viewdef` の現行 SELECT 全文（＝拡張の土台）。
- (2) 既に `requester_email`/`created_by` 等が出ていないか（出ていれば C は不要、コードが解決可能）。
- (3) `matters` の依頼者メール候補列（`created_by` / `requester_email` / `*owner*` / `*email*` 等）。

### C-2. 拡張ビューの適用（定義確定後）

(1) の現行 SELECT をベースに、末尾へ依頼者メール列を1つ追加する。派生元は (3) の実列に
合わせて決める。典型例（`matters.created_by` に依頼者メールが入っている場合）：

```sql
-- ※ 下の SELECT 本体は 021 の (1) 出力で置き換えること（既存カラムを一切変えない）。
--   ここでは「末尾に requester_email を1列追加する」差分だけを示す。
CREATE OR REPLACE VIEW public.matter_overview_v AS
SELECT
  <<-- 021(1) の現行カラムをそのまま列挙 -->>,
  -- 追加：依頼者メール（実列に合わせて派生。例は created_by をそのまま露出）
  m.created_by AS requester_email
FROM <<-- 021(1) の現行 FROM/JOIN をそのまま -->>;
-- 権限はビュー再作成でも保持されるが、念のため：
GRANT SELECT ON public.matter_overview_v TO legalbridge_v2_runtime;
```

適用は管理接続で。`CREATE OR REPLACE VIEW` はカラムの**追加は可**だが、既存カラムの
名前/型/順序変更や削除は不可（その場合 `DROP VIEW` が要り依存に波及するため、まず追加のみで）。

### C-3. 検証

```bash
# runtime 接続で依頼者メールが乗ること（値はマスクせず生で返るのは view→repo 間のみ、
# API 応答は resolver 側でマスク）
psql "$RUNTIME_APP_DSN" -c \
  "SELECT id, requester_email FROM matter_overview_v WHERE requester_email IS NOT NULL LIMIT 5;"
```

その後アプリ側は無変更で解決可能：`GET /api/v2/matters` の各行 `requesterEmail` が非 null に
なり、Slack 候補フローの `resolve()` が `SLACK_DRY_RUN_USER_MAP` と突合して宛先解決できる。

ロールバック：`CREATE OR REPLACE VIEW` で追加列を外した現行定義に戻す（データ影響なし）。

---

## D. CloudSign 依頼の冪等履歴（`lb_v2_cloudsign_requests`・スライス5-7）

append＋status・`idempotency_key` 一意・`cloud_sign_document_id` 永続化・**SELECT/INSERT/UPDATE**
（UPDATE は締結状況の反映のみ。DELETE/TRUNCATE 無し）。Gmail 送信履歴(A)と同型。

```bash
# 1) 事前確認
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/022_cloudsign_request_history_production_preflight.sql || true

# 2) 作成＋付与
psql "$RUNTIME_ADMIN_DSN" \
  -v confirm_cloudsign_history=GRANT_PRODUCTION_CLOUDSIGN_HISTORY \
  -f infra/gcp/sql/022_cloudsign_request_history_production_grants.sql

# 3) 事後確認（runtime に SELECT, INSERT, UPDATE）
psql "$RUNTIME_ADMIN_DSN" -f infra/gcp/sql/022_cloudsign_request_history_production_preflight.sql
```

有効化：`_CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`（Aと同じくサービス名ガードの扱いに注意）。
併せて **`_CLOUDSIGN_ALLOWED_RECIPIENTS`（宛先allowlist）** を設定する（verify は live 点火時に必須）。
検証DB用は `022_cloudsign_request_history_validation.sql`。ロールバックは
`_CLOUDSIGN_REQUEST_HISTORY_ENABLED=false`（従来動作・履歴無しの毎回送信）。

## まとめ（適用順）

1. A・B（本番作成＋付与）… 独立、順不同。preflight→grants→preflight。
2. C-1 introspect → C-2 定義確定・適用 → C-3 検証。
3. 有効化は各フラグ（`_GMAIL_SEND_HISTORY_ENABLED` / `_GMAIL_INBOUND_INTAKE_ENABLED`）と
   本番サービスの verify ガード拡張後に。C はフラグ不要（露出後は自動で解決）。
4. 残る唯一の hard-block は **④ CloudSign 認証の実API突合**（本ドキュメント対象外・外部依存）。
