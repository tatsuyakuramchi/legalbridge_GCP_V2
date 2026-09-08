# V3 デプロイ：Cloud Shell 実行手順（コピペ用）

[`docs/v3-deploy-runbook.md`](./v3-deploy-runbook.md) の内容を、Cloud Shell で
上から順に貼り付けられる形にしたもの。**判断基準や背景は手順書のほうを見ること。**
ここはコマンドだけを並べてある。

---

## ⚠️ 最初に：Cloud SQL Studio でできないこと

**移行スクリプトは Cloud SQL Studio では実行できない。** Studio は psql の
メタコマンド（`\set` `\echo` `\if` `\pset`）を解釈しないため、9本すべてが
そのままでは動かない。特に危険なのは2つ:

| ファイル | Studio に貼るとどうなるか |
|---|---|
| `003_grants.sql` | `\if :{?confirm_v3_grants}` の**安全確認をすり抜ける**か構文エラーになる。権限付与が確認なしで走る危険がある |
| `005_preflight.sql` | `CREATE TEMP TABLE` がセッション単位。Studio は実行ごとにセッションが変わるため、宣言した内容が消えて**空の結果が返る**（＝「問題なし」に見えてしまう） |

**SQLの実行はすべて Cloud Shell の psql で行う。** Cloud SQL Studio は
最後にまとめた「検算クエリ集」を眺める用途にだけ使う（表形式で見やすいため）。

---

## A. Cloud Shell の準備

```bash
gcloud config set project legalbridge-488506

cd ~
git clone https://github.com/tatsuyakuramchi/legalbridge_GCP_V2.git
cd legalbridge_GCP_V2
git checkout claude/v3
git log --oneline -1
```

V3 が V2 に手を入れていないことを確認する（**この2行以外が出たら中止**）:

```bash
git fetch origin v3-base
git diff --name-status origin/v3-base...claude/v3 | grep -v '^A'
# 期待:
#   M	package-lock.json
#   M	package.json
```

---

## B. Cloud SQL Auth Proxy

```bash
# 最新版は https://github.com/GoogleCloudPlatform/cloud-sql-proxy/releases で確認する
VERSION=v2.14.1
curl -Lo ~/cloud-sql-proxy \
  "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/${VERSION}/cloud-sql-proxy.linux.amd64"
chmod +x ~/cloud-sql-proxy
~/cloud-sql-proxy --version
```

貼り直しはリポジトリのスクリプトで行う:

```bash
infra/gcp/start-sql-proxy.sh
```

> **トークンは約1時間で失効する。** psql が `ACCESS_TOKEN_TYPE_UNSUPPORTED` や
> 401 で落ちたら、このスクリプトを再実行してから続きを流す。
> 手順5（移行）は長いので、その直前に必ず貼り直しておく。

---

## C. 接続情報

パスワードを履歴に残さず、URLエンコードも不要な libpq 環境変数で持つ。

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=legalbridge
export PGUSER=postgres          # 管理ロール
read -rsp "postgres のパスワード: " PGPASSWORD; echo; export PGPASSWORD

psql -c "SELECT current_user, current_database(), version();"
```

これが通れば以降の `psql -f ...` はすべてこの接続を使う
（手順書の `$ADMIN_DSN` に相当）。

---

## 手順0：GCP 側の前提（初回のみ）

### 0.1 Artifact Registry

```bash
gcloud artifacts repositories describe legalbridge --location=asia-northeast1 \
  || gcloud artifacts repositories create legalbridge \
       --repository-format=docker --location=asia-northeast1
```

### 0.2 サービスアカウント

```bash
gcloud iam service-accounts create legalbridge-v3 \
  --display-name="LegalBridge V3 runtime" 2>/dev/null || true

for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding legalbridge-488506 \
    --member="serviceAccount:legalbridge-v3@legalbridge-488506.iam.gserviceaccount.com" \
    --role="$ROLE" --condition=None
done
```

Cloud Build 側にも権限が要る:

```bash
PROJECT_NUMBER="$(gcloud projects describe legalbridge-488506 --format='value(projectNumber)')"
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding legalbridge-488506 \
  --member="serviceAccount:${CB_SA}" --role=roles/run.admin --condition=None
gcloud iam service-accounts add-iam-policy-binding \
  legalbridge-v3@legalbridge-488506.iam.gserviceaccount.com \
  --member="serviceAccount:${CB_SA}" --role=roles/iam.serviceAccountUser
```

### 0.3 Secret Manager

`cloudbuild.yaml` が6本すべてを参照する。**1本でも無いとデプロイ段で失敗する。**
まだ使わないチャネルは空で作っておく（モードが `off` なので読まれない）。

```bash
create_secret() {  # $1=名前 $2=値
  printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic 2>/dev/null \
  || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=-
}

create_secret legalbridge-v3-webhook-token "$(openssl rand -hex 32)"

gcloud secrets list --filter="name~legalbridge-v3" --format="value(name)"
```

> **空のシークレットを作らないこと。** `--data-file=-` に空を渡すと箱だけ
> できてバージョンが作られず、`versions/latest` が解決できずデプロイが
> 失敗する（Cloud Run は "was not found" と言うが、実際は中身が無い）。
>
> 外部連携の資格情報は**実際に使うときに作り**、`_SECRETS_EXTRA` で
> 配線する。持っていない資格情報は配線しない:
>
> ```bash
> create_secret legalbridge-v3-slack-bot-token "xoxb-..."
> create_secret legalbridge-v3-slack-signing-secret "..."
>
> gcloud builds submit --config infra/v3/cloudbuild.yaml \
>   --substitutions=^@^_GIT_SHA=$(git rev-parse --short HEAD)@_SECRETS_EXTRA=SLACK_BOT_TOKEN=legalbridge-v3-slack-bot-token:latest,SLACK_SIGNING_SECRET=legalbridge-v3-slack-signing-secret:latest \
>   .
> ```

---

## 手順1：ランタイムロールを作る

```bash
V3_PASSWORD="$(openssl rand -base64 24)"

psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v3_runtime') THEN
    CREATE ROLE legalbridge_v3_runtime LOGIN PASSWORD '${V3_PASSWORD}';
  ELSE
    ALTER ROLE legalbridge_v3_runtime PASSWORD '${V3_PASSWORD}';
  END IF;
END
\$\$;
SQL

create_secret legalbridge-v3-runtime-db-password "$V3_PASSWORD"
unset V3_PASSWORD
```

---

## 手順2：preflight（移行前に必ず1回）

読むだけ。移行スクリプトが参照する `public` 側の列が実在するかを確認する。

```bash
psql -v ON_ERROR_STOP=1 -f infra/v3/005_preflight.sql | tee ~/v3-preflight.log
```

**★ 止まる条件**

```bash
# required=t の欠落があるか
grep -A100 '欠落している列' ~/v3-preflight.log | grep ' t$' || echo "OK: 必須列の欠落なし"
```

`required = t` の行が1つでも出たら、その列を使う移行スクリプト
（`used_by` に 010/020/030/040 が出る）を直すまで**先へ進まない**。
`required = f` の欠落は問題ない（その項目が NULL で入るだけ）。

---

## 手順3：スキーマとビューを作る

```bash
psql -v ON_ERROR_STOP=1 -f infra/v3/001_schema.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/002_views.sql
```

**★ 確認：表28 / ビュー6**

```bash
psql -c "SELECT count(*) FILTER (WHERE table_type='BASE TABLE') AS tables,
                count(*) FILTER (WHERE table_type='VIEW')       AS views
           FROM information_schema.tables WHERE table_schema='v3';"
```

---

## 手順4：権限を与える

確認変数なしでは実行できない作りになっている。

```bash
psql -v ON_ERROR_STOP=1 -v confirm_v3_grants=GRANT_V3_RUNTIME \
  -f infra/v3/003_grants.sql | tee ~/v3-grants.log
```

**★ 止まる条件：「想定外の権限」が0行であること**

```bash
sed -n '/想定外の権限/,$p' ~/v3-grants.log
# → "(0 rows)" 以外なら、その権限が付いた原因を潰すまで先へ進まない
```

ランタイムロールで実際に境界を確かめる:

```bash
PGPASSWORD_ADMIN="$PGPASSWORD"
export PGPASSWORD="$(gcloud secrets versions access latest --secret=legalbridge-v3-runtime-db-password)"

psql -U legalbridge_v3_runtime -c "SET search_path=v3; SELECT count(*) FROM conditions;"
# → 通る

psql -U legalbridge_v3_runtime -c "SELECT count(*) FROM public.condition_lines;"
# → ERROR: permission denied（42501）。これが出るのが正常

export PGPASSWORD="$PGPASSWORD_ADMIN"; unset PGPASSWORD_ADMIN
```

---

## 手順5：データを移行する

**順番が意味を持つ**（案件が文書より先）。全部冪等なので途中で失敗しても流し直せる。

> **`set -e` を対話シェルに貼らないこと。** 有効にすると、次に非ゼロを返した
> コマンドでシェル自体が終了する（Cloud Shell のセッションが切れる）。
> スクリプトファイルにして子プロセスで走らせる。

```bash
infra/gcp/start-sql-proxy.sh      # トークンを貼り直してから始める

cat > ~/run-v3-migrate.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd ~/legalbridge_GCP_V2
for f in 010_migrate_master 020_migrate_core 030_migrate_matters 040_migrate_documents; do
  echo "=== $f ==="
  psql -v ON_ERROR_STOP=1 -f "infra/v3/${f}.sql"
done
echo "=== すべて完了 ==="
EOF

bash ~/run-v3-migrate.sh 2>&1 | tee ~/v3-migrate.log

psql -v ON_ERROR_STOP=1 -f infra/v3/090_verify.sql | tee ~/v3-verify.log
```

ファイルを作らずに対話シェルのまま流すなら:

```bash
for f in 010_migrate_master 020_migrate_core 030_migrate_matters 040_migrate_documents; do
  echo "=== $f ==="
  psql -v ON_ERROR_STOP=1 -f "infra/v3/${f}.sql" || { echo "★ $f で失敗しました"; break; }
done
```

**★ 止まる条件**

1. **金額の突き合わせが一致すること。** JPY は最小単位が円なので
   `src_amount_ex_tax = dst_flat_amount`、`src_mg = dst_mg`。
   ズレたら移行のバグなので進まない。
2. **件数差の理由を全部説明できること。** 説明できる差:
   - 作品：`works + source_ips` を1つに寄せている（重複分だけ `dst` が減る）
   - 条件：相手先が解決できなかった行は落ちる。落ちた件数は
     `MIGRATION_CONDITION_NO_PARTY` の件数と**一致する**
   - 文書：版チェーンでまとめた分だけ減ることがある

```bash
sed -n '/金額の突き合わせ/,/向きの分布/p' ~/v3-verify.log
sed -n '/件数の突き合わせ/,/金額の突き合わせ/p' ~/v3-verify.log
sed -n '/未解決の移行課題/,$p' ~/v3-verify.log
```

`severity=high` は人手で潰す対象。残っていても V3 は起動できるが、
本番切替の前には0にする。

### やり直したいとき

```bash
psql -c "DROP SCHEMA v3 CASCADE;"   # V1・V2 は無傷
```

---

## 手順6：ビルドとデプロイ

```bash
cd ~/legalbridge_GCP_V2
git status --short        # 空であること

gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=_GIT_SHA="$(git rev-parse --short HEAD)" \
  .
```

参照専用で立てるなら:

```bash
gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=_READ_ONLY=true,_GIT_SHA="$(git rev-parse --short HEAD)" \
  .
```

ビルドは `test` → `build-image` → `push-image` → `deploy` の4段。
**`test` 段で型検査とテスト115件が通らなければ image も作られない。**

---

## 手順7：デプロイ後の確認

```bash
URL="$(gcloud run services describe legalbridge-v3 --region=asia-northeast1 --format='value(status.url)')"
TOKEN="$(gcloud auth print-identity-token)"
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/health" | jq .
```

**★ `database.schema` が `v3` であること。** `public` を含んでいたら接続設定の誤り。

載せたコミットを確認:

```bash
gcloud run revisions list --service=legalbridge-v3 --region=asia-northeast1 \
  --format='table(metadata.name, metadata.labels.git-sha, metadata.creationTimestamp)'
```

画面を見る:

```bash
gcloud run services proxy legalbridge-v3 --region=asia-northeast1 --port=8080
# Cloud Shell の「ウェブでプレビュー」→ ポート 8080
```

9画面（ホーム／案件／条件／文書／お金／作品／取引先／フロー監視／運用）を開き、
**日付が `2026-04-01` の形で出ること**を確認する（`Wed Apr 01` は不具合）。

---

## 手順9：切戻し

```bash
# アプリだけ戻す（データは残す）
gcloud run services delete legalbridge-v3 --region=asia-northeast1

# 全部消す
psql -c "DROP SCHEMA v3 CASCADE;"
psql -c "DROP ROLE legalbridge_v3_runtime;"
```

`public` と V1・V2 のサービスはどの操作でも影響を受けない。

---

# Cloud SQL Studio 用：検算クエリ集

ここから下は**メタコマンドを含まない**ので、Cloud SQL Studio にそのまま貼れる。
Studio へは DB ユーザー（`postgres`）とパスワードでサインインする。
**確認専用。** 移行スクリプトは上の Cloud Shell 手順で流すこと。

## S1. 作られたもの（手順3のあと）

```sql
SELECT table_type, count(*)
  FROM information_schema.tables
 WHERE table_schema = 'v3'
 GROUP BY table_type ORDER BY table_type;
-- BASE TABLE = 28 / VIEW = 6
```

## S2. 権限の境界（手順4のあと）★最重要

```sql
SELECT table_schema, table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime'
   AND (table_schema <> 'v3'
        OR privilege_type = 'TRUNCATE'
        OR table_name = 'party_bank_accounts'
        OR (table_name IN ('document_templates', 'document_template_versions')
            AND privilege_type <> 'SELECT')
        OR (table_name = 'audit_events' AND privilege_type IN ('UPDATE', 'DELETE'))
        OR (table_name LIKE 'v\_%' AND privilege_type <> 'SELECT'))
 ORDER BY table_schema, table_name, privilege_type;
-- ★ 0行であること。1行でも出たら原因を潰すまで先へ進まない
```

付いた権限の一覧:

```sql
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime' AND table_schema = 'v3'
 GROUP BY table_name ORDER BY table_name;
```

## S3. 件数の突き合わせ（手順5のあと）

```sql
SELECT '取引先'   AS entity, (SELECT count(*) FROM public.vendors)          AS src,
                             (SELECT count(*) FROM v3.parties)              AS dst
UNION ALL SELECT '担当者',   (SELECT count(*) FROM public.staff),           (SELECT count(*) FROM v3.staff)
UNION ALL SELECT '作品',     (SELECT count(*) FROM public.works)
                           + (SELECT count(*) FROM public.source_ips),      (SELECT count(*) FROM v3.works)
UNION ALL SELECT 'パート',   (SELECT count(*) FROM public.work_materials),  (SELECT count(*) FROM v3.work_parts)
UNION ALL SELECT '合意',     (SELECT count(*) FROM public.contracts),       (SELECT count(*) FROM v3.agreements)
UNION ALL SELECT '条件',     (SELECT count(*) FROM public.condition_lines), (SELECT count(*) FROM v3.conditions)
UNION ALL SELECT '予定',     (SELECT count(*) FROM public.condition_line_installments),
                                                                           (SELECT count(*) FROM v3.condition_schedules)
UNION ALL SELECT '実績',     (SELECT count(*) FROM public.condition_events),(SELECT count(*) FROM v3.condition_events)
UNION ALL SELECT '支払',     (SELECT count(*) FROM public.payments),        (SELECT count(*) FROM v3.payments)
UNION ALL SELECT '案件',     (SELECT count(*) FROM public.matters),         (SELECT count(*) FROM v3.matters)
UNION ALL SELECT 'タスク',   (SELECT count(*) FROM public.matter_tasks),    (SELECT count(*) FROM v3.tasks)
UNION ALL SELECT '文書',     (SELECT count(*) FROM public.documents),       (SELECT count(*) FROM v3.documents)
ORDER BY 1;
```

## S4. 金額の突き合わせ ★一致すること

```sql
SELECT
  (SELECT COALESCE(sum(amount_ex_tax), 0) FROM public.condition_lines
    WHERE COALESCE(currency, 'JPY') = 'JPY')  AS src_amount_ex_tax,
  (SELECT COALESCE(sum(flat_amount), 0) FROM v3.conditions
    WHERE currency = 'JPY')                   AS dst_flat_amount,
  (SELECT COALESCE(sum(mg_amount), 0) FROM public.condition_lines
    WHERE COALESCE(currency, 'JPY') = 'JPY')  AS src_mg,
  (SELECT COALESCE(sum(mg_amount), 0) FROM v3.conditions
    WHERE currency = 'JPY')                   AS dst_mg;
-- JPY は最小単位が円。src と dst がズレたら移行のバグ
```

## S5. 未解決の移行課題

```sql
SELECT rule_code, severity, count(*) AS rows
  FROM v3.data_quality_issues WHERE status = 'open'
 GROUP BY 1, 2 ORDER BY 2, 3 DESC;
```

中身を見る:

```sql
SELECT rule_code, target_type, target_id, detail, detected_at
  FROM v3.data_quality_issues
 WHERE status = 'open' AND severity = 'high'
 ORDER BY rule_code, target_id
 LIMIT 100;
```

## S6. 条件の向きとフロー種別の分布

```sql
SELECT direction, count(*) FROM v3.conditions GROUP BY 1 ORDER BY 1;
```

```sql
SELECT kind, count(*) FROM v3.matters GROUP BY 1 ORDER BY 1;
```

## S7. 残高ビューの抜き取り確認

移行後に AG（前払保証）の消込が正しく効いているかを1件見る。

```sql
SELECT condition_no, currency, mg_amount, ag_amount,
       consumed_total, ag_consumed, ag_remaining
  FROM v3.v_condition_balance
 WHERE ag_amount > 0
 ORDER BY ag_remaining
 LIMIT 20;
```

`ag_remaining` は `GREATEST(..., 0)` で0止まりなので、**超過はこの列には出ない**。
AG を使いすぎている条件はこちらで見る:

```sql
SELECT condition_no, ag_amount, ag_consumed, ag_consumed - ag_amount AS over
  FROM v3.v_condition_balance
 WHERE ag_amount > 0 AND ag_consumed > ag_amount
 ORDER BY over DESC;
-- 0行が正常。出た場合は V1 側の相殺記録を確認する
```
