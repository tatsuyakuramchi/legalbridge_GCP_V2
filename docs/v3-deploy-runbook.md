# LegalBridge V3 デプロイ手順書

V3 は **V1・V2 を止めずに** 立ち上げる。同じ Cloud SQL インスタンスを使うが、
V3 が触るのは `v3` スキーマだけで、`public`（V1・V2 の表）には権限すら持たない。
Cloud Run も別サービス（`legalbridge-v3`）なので、失敗したらサービスを消すだけで
元に戻る。

- 対象プロジェクト: `legalbridge-488506`
- リージョン: `asia-northeast1`
- Cloud SQL: `legalbridge-488506:asia-northeast1:legalbridge-db` / DB `legalbridge`
- サービス: `legalbridge-v3`（V2 の `legalbridge-v2-preview` とは別）
- ランタイムロール: `legalbridge_v3_runtime`

所要時間の目安は、0〜5（DB 側）で 1〜2 時間、6〜7（デプロイと確認）で 30 分。
8（外部連携の開放）は日をまたいで段階的に行う。

---

> **Cloud Shell で実行する場合** は、この手順書をそのまま貼れる形にした
> [docs/v3-deploy-cloudshell.md](./v3-deploy-cloudshell.md) を使う。
> **Cloud SQL Studio では移行スクリプトを実行できない**（psql のメタコマンドを
> 解釈しないため、003 の安全確認がすり抜け、005 は空の結果を返す）。
> Studio 用の検算クエリはそちらの末尾にまとめてある。

## 用語：3つの接続先

手順の中で DSN を使い分ける。混ぜると事故になるので最初に用意しておく。

| 変数 | ロール | 用途 |
|---|---|---|
| `ADMIN_DSN` | 既存の管理ロール（`postgres` 等） | スキーマ作成・移行・権限付与 |
| `READONLY_DSN` | 参照権限のあるロール | preflight（読むだけ） |
| `RUNTIME_DSN` | `legalbridge_v3_runtime` | 権限確認・アプリと同条件の疎通 |

Cloud SQL Proxy 経由で組み立てる:

```bash
infra/gcp/start-sql-proxy.sh          # 127.0.0.1:5432 に貼る

export ADMIN_DSN="postgres://postgres:***@127.0.0.1:5432/legalbridge"
export READONLY_DSN="$ADMIN_DSN"      # 参照ロールがあればそちらを使う
export RUNTIME_DSN="postgres://legalbridge_v3_runtime:***@127.0.0.1:5432/legalbridge"
```

> プロキシのアクセストークンは約1時間で失効する。psql が
> `Error 401 ... ACCESS_TOKEN_TYPE_UNSUPPORTED` で落ちたら
> `infra/gcp/start-sql-proxy.sh` を再実行する。長い移行の途中で切れるので、
> 手順5の前に貼り直しておくとよい。

---

## 0. 前提の用意（初回のみ）

### 0.1 Artifact Registry

```bash
gcloud artifacts repositories describe legalbridge \
  --location=asia-northeast1 --project=legalbridge-488506 \
  || gcloud artifacts repositories create legalbridge \
       --repository-format=docker --location=asia-northeast1 \
       --project=legalbridge-488506
```

### 0.2 実行サービスアカウント

```bash
gcloud iam service-accounts create legalbridge-v3 \
  --display-name="LegalBridge V3 runtime" --project=legalbridge-488506

for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding legalbridge-488506 \
    --member="serviceAccount:legalbridge-v3@legalbridge-488506.iam.gserviceaccount.com" \
    --role="$ROLE"
done
```

Cloud Build のサービスアカウントには、このアカウントを使ってデプロイするための
`roles/iam.serviceAccountUser` と、`roles/run.admin` が要る。

### 0.3 Secret Manager

`cloudbuild.yaml` が `--set-secrets` で参照する。**すべて先に作っておく**
（1つでも欠けるとデプロイ段階で失敗する）。まだ使わないチャネルの分は
空文字を入れておけばよい（モードが `off` なので読まれない）。

| シークレット名 | 中身 |
|---|---|
| `legalbridge-v3-runtime-db-password` | 手順1で決める DB パスワード |
| `legalbridge-v3-webhook-token` | 受信口の共有シークレット（`openssl rand -hex 32`） |

外部連携の資格情報（Slack・CloudSign・Backlog）は**実際に使うときに作る**。
`cloudbuild.yaml` は既定では配線しないので、無くてもデプロイできる。
使うときは値を入れて作り、`_SECRETS_EXTRA` で配線する。

**空のシークレットを作ってはいけない。** `--data-file=-` に空を渡すと箱だけ
できてバージョンが作られず、`versions/latest` が解決できない。Cloud Run は
"Secret ... was not found" と言うが、実際は「中身が無い」という意味。

```bash
create_secret() {  # $1=名前 $2=値
  printf '%s' "$2" | gcloud secrets create "$1" --data-file=- \
    --replication-policy=automatic --project=legalbridge-488506 2>/dev/null \
  || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- \
       --project=legalbridge-488506
}
create_secret legalbridge-v3-webhook-token "$(openssl rand -hex 32)"
```

---

## 1. ランタイムロールを作る

パスワードは Secret Manager に入れる値と同じにする。

```bash
V3_PASSWORD="$(openssl rand -base64 24)"

psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 <<SQL
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
```

この時点でロールは `public` に対する既定権限しか持たない。手順4の
`003_grants.sql` を流すまで `v3` は見えない。

---

## 2. preflight（移行前に必ず1回）

移行スクリプトが読む `public` 側の列が実在するかを、**読むだけ**で確認する。
V1・V2 の運用でスキーマがずれていると、ここで気づける。

```bash
psql "$READONLY_DSN" -f infra/v3/005_preflight.sql | tee /tmp/v3-preflight.log
```

**判定**

- `exists = false` の行が **必須（required=true）** に1つでもあれば **止まる**。
  その列を使う移行スクリプト（`used_by` 列に 010 / 020 / 030 / 040 が出る）を
  実データに合わせて直してから先へ進む。
- 任意（required=false）の欠落は問題ない。その項目が NULL で入るだけ。
- 末尾に出る `form_data` の取引先キー分布は、040 の文書移行が拾うキーの当たりを
  確認するためのもの。想定外のキーが上位に来ていたら 040 を見直す。

---

## 3. スキーマとビューを作る

```bash
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f infra/v3/001_schema.sql
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f infra/v3/002_views.sql
```

どちらも冪等。`002` は先頭で `DROP VIEW IF EXISTS` してから作り直すので、
列を増やした版に入れ替えるときもそのまま流せる。

**`002` を流し直したら `003_grants.sql` も流し直すこと。** ビューを作り直すと
ランタイムロールにビューへの書込権限が付く経路がある（003 がそれを剥がす）。

確認:

```bash
psql "$ADMIN_DSN" -c \
  "SELECT count(*) FILTER (WHERE table_type='BASE TABLE') AS tables,
          count(*) FILTER (WHERE table_type='VIEW')       AS views
     FROM information_schema.tables WHERE table_schema='v3';"
```

表 28 / ビュー 7 になっていること。

---

## 3.5 あとから足した変更を当てる

`001_schema.sql` は `CREATE TABLE IF NOT EXISTS` で書いてあるため、既に作った
表には流し直しても効かない。制約・列の変更は `004_amend.sql` に積む。冪等。

```bash
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f infra/v3/004_amend.sql
```

初回は `A-001: matter_links.target_type に email_thread を足した`、2回目以降は
`A-001: 適用済み`。**新しい表を足す変更を入れたときは `003_grants.sql` も
流し直すこと**（新しい表にランタイムロールの権限が付かない）。

---

## 4. 権限を与える

確認変数なしでは実行できないようにしてある（事故防止）。

```bash
psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 \
  -v confirm_v3_grants=GRANT_V3_RUNTIME \
  -f infra/v3/003_grants.sql | tee /tmp/v3-grants.log
```

**判定**：末尾の `--- 想定外の権限 ---` が **0 行**であること。1行でも出たら
その権限が付いた原因を潰すまで先へ進まない。ここが V1 との安全境界になっている。

意図している形:

- `v3` の全表・全ビューに `SELECT`
- `v3` の**基底表のみ** `INSERT / UPDATE / DELETE`（ビューには書けない）
- `audit_events` は `UPDATE / DELETE` なし（追記専用）
- `party_bank_accounts` は権限なし（口座情報はアプリから見えない）
- `document_templates` / `document_template_versions` は `SELECT` のみ
- `TRUNCATE` はどの表にも無い
- `public` スキーマには一切権限が無い

ランタイムロールで実際に確かめる:

```bash
psql "$RUNTIME_DSN" -c "SET search_path=v3; SELECT count(*) FROM conditions;"   # 通る
psql "$RUNTIME_DSN" -c "SELECT count(*) FROM public.condition_lines;"           # 42501 で弾かれる
```

---

## 5. データを移行する

**順番が意味を持つ**（案件が文書より先。文書が `matter_id` を引く）。
すべて `legacy_id` を鍵にした `ON CONFLICT DO UPDATE` なので、
途中で失敗しても最初から流し直せる。

`set -e` は対話シェルに貼らない（次に非ゼロを返したコマンドでシェルごと終了する）。
スクリプトにして子プロセスで走らせる。

```bash
cat > /tmp/run-v3-migrate.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for f in 010_migrate_master 020_migrate_core 030_migrate_matters 040_migrate_documents; do
  echo "=== $f ==="
  psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f "infra/v3/${f}.sql"
done
EOF
bash /tmp/run-v3-migrate.sh 2>&1 | tee /tmp/v3-migrate.log

psql "$ADMIN_DSN" -v ON_ERROR_STOP=1 -f infra/v3/090_verify.sql | tee /tmp/v3-verify.log
```

### 5.1 検算の読み方

`090_verify.sql` は4つの表を出す。

**件数の突き合わせ** — `src` と `dst` の差は、次の理由なら想定内:

- 作品: `works + source_ips` を1つの `works` に寄せているので、
  同一作品が両方にあれば `dst` が減る。
- 条件: 相手先が解決できなかった行は落ちる。落ちた分は
  `MIGRATION_CONDITION_NO_PARTY` として下の課題表に出る。**件数が一致すること**。
- 文書: 版チェーンでまとめた分だけ `dst` が減ることがある。

差の理由を1つずつ説明できない状態でデプロイに進まない。

**金額の突き合わせ** — JPY は最小単位が円なので `src` と `dst` は**一致する**。
一致しなければ移行のバグ。

**未解決の移行課題** — `severity='high'` は人手で潰す対象。
`v3.data_quality_issues` に残るので、V3 の運用画面から追える。
`high` が残っていても V3 は起動できる（データ品質の宿題として持ち越す）が、
本番切替の前には 0 にする。

### 5.2 やり直したいとき

```bash
psql "$ADMIN_DSN" -c "DROP SCHEMA v3 CASCADE;"   # V1・V2 は無傷
```

---

## 6. ビルドとデプロイ

### 6.0 どのブランチから実行するか

**`main` では実行できない。** V3 のファイルは `main` に1つも入っていない
（`Dockerfile.v3` も `infra/v3/` も無い）。必ず `claude/v3` に切り替えてから submit する。

```bash
git fetch origin claude/v3
git checkout claude/v3
git status --short        # 空であること。中途半端な変更を載せない
git log --oneline -1      # 載せるコミットを控える
```

V3 が V2 に何も足し引きしていないことは、いつでもここで確認できる:

```bash
git diff --name-status v3-base...claude/v3 | grep -v '^A'
# → package.json と package-lock.json の2行だけが正常。
#   apps/legalbridge/ が出てきたら V2 に手が入っている。
```

`v3-base` は V3 の分岐点を固定したブランチ。`main` が force push されても
この比較は壊れない。GitHub 上では PR #129（Draft・マージしない）が同じ差分を表示する。

### 6.1 submit

```bash
gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=_GIT_SHA="$(git rev-parse --short HEAD)" \
  --project=legalbridge-488506 .
```

`_GIT_SHA` は Cloud Run のリビジョンにラベルとして刻まれる。**渡さないと
`unknown` になり、動いているコードがどのコミットか後から追えなくなる。**
手動 submit では Cloud Build の `$SHORT_SHA` が空になるため、ここで明示する。

`.gcloudignore` は置いていないので、gcloud は `.gitignore` を流用する。
`node_modules/`（122MB）は除外されるのでアップロードは軽い。

ビルドは4段階。**`test` 段で型検査とテストが通らなければ image も作られない**。

1. `test` — `npm ci` → `typecheck:v3` → `test:v3` → `build:v3`
2. `build-image` — `Dockerfile.v3`（node:22-alpine + chromium + Noto CJK）
3. `push-image` — Artifact Registry へ
4. `deploy` — Cloud Run へ（`--no-allow-unauthenticated`）

既定の substitutions は**安全側に倒してある**:

| 変数 | 既定 | 意味 |
|---|---|---|
| `_AUTH_MODE` | `disabled` | 実アカウントを載せるまでは認証なしで立てる |
| `_READ_ONLY` | `false` | `true` にすると書込APIが 503 を返す |
| `_SLACK_MODE` 他 | `off` | 外部送信は全部止まっている |
| `_DRIVE_FOLDER_ID` | 空 | Drive 保存だけが無効。文書の作成・発行は動く |

参照専用で様子を見るなら:

```bash
gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=_READ_ONLY=true,_GIT_SHA="$(git rev-parse --short HEAD)" \
  --project=legalbridge-488506 .
```

---

## 7. デプロイ後の確認

```bash
URL="$(gcloud run services describe legalbridge-v3 \
  --region=asia-northeast1 --format='value(status.url)')"
TOKEN="$(gcloud auth print-identity-token)"

curl -sS -H "Authorization: Bearer $TOKEN" "$URL/health" | jq .
```

期待する応答:

```json
{
  "status": "ok",
  "service": "legalbridge-v3",
  "readOnly": false,
  "database": { "configured": true, "reachable": true, "schema": "v3", "readOnly": false }
}
```

**`database.schema` に `v3` が入っていること**が肝。ここが `public` を含んで
いたら接続設定が間違っている（`DB_SCHEMA` を確認する）。`reachable: false` は
Cloud SQL 接続かパスワードの問題なので、Cloud Run のログで
`db health check failed` の `code` を見る。

### 動いているのがどのコミットか

```bash
gcloud run services describe legalbridge-v3 --region=asia-northeast1 \
  --format='value(spec.template.metadata.labels.git-sha)'
```

手順6で `_GIT_SHA` を渡していれば短縮SHAが返る。`unknown` が返ったら、
そのリビジョンは**どのコードが載っているか追えない状態**。次回の submit で
必ず `_GIT_SHA` を渡し直す。

リビジョンごとに見るなら:

```bash
gcloud run revisions list --service=legalbridge-v3 --region=asia-northeast1 \
  --format='table(metadata.name, metadata.labels.git-sha, metadata.creationTimestamp)'
```

返ってきたSHAは `git show <SHA>` でそのまま辿れる。V2 側と混同しないよう、
**`git branch -a --contains <SHA>` に `claude/v3` だけが出ること**も確認しておく
（`main` が出たらそれは V2 のコミットで、V3 のイメージではない）。

### 画面の確認（ブラウザ）

`--no-allow-unauthenticated` なのでプロキシ越しに開く:

```bash
gcloud run services proxy legalbridge-v3 --region=asia-northeast1 --port=8080
# → http://localhost:8080
```

9画面を順に開き、**日付が `2026-04-01` の形で出ること**を各画面で確認する
（`Wed Apr 01 ...` と出たら日付整形の回帰）。

| 画面 | 見るところ |
|---|---|
| ホーム | 件数と期限が出る |
| 案件 | 一覧 → 詳細。条件・文書・支払・連絡がぶら下がる |
| 条件 | 相手先の付け替え、経済条件の改定（改定すると `-R2` が採番される） |
| 文書 | 作成 → 発行（採番が `ARC-...-2026-0001` 形式で続く） |
| お金 | 計算書の作成、支払の登録、60日ルールの判定 |
| 作品 | 権利範囲（構成パートの IN 条件の積） |
| 取引先 | 一覧と口座以外の情報 |
| フロー監視 | 送信履歴とゲートの状態 |
| 運用 | データ品質課題（移行で残した `high` がここに出る） |

### 書込の疎通（1件だけ）

読めるだけでは権限の確認にならない。文書を1件作って消せることまで見る。
`READ_ONLY=true` で立てた場合はここは 503 が返るのが正しい。

---

## 8. 外部連携の段階開放

**いきなり `live` にしない。** 3段階で開ける。

### 8.1 まず dry_run

送信はせず「何が送られるか」だけを返す。フロー監視画面で内容を確認する。

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars="GMAIL_MODE=dry_run"
```

### 8.2 宛先を絞って live

`DISPATCH_ALLOWLIST` に入れた宛先にしか送らない。まず自分宛だけで通す。

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars="^@^GMAIL_MODE=live@GMAIL_SENDER=...@DISPATCH_ALLOWLIST=k.tk.tatsuya@gmail.com"
```

同じ内容の二度目の送信は冪等キー（チャネル・対象・宛先・本文の SHA-256）で
弾かれ、前回の外部IDが返る。これも1回試しておく。

### 8.3 制限を外す

`DISPATCH_ALLOWLIST=` を空にする。チャネルごとに 8.1 → 8.3 を繰り返す
（Gmail → Slack → CloudSign → Backlog の順を推奨。影響範囲が小さい順）。

### 8.4 受信口の登録

Webhook は `POST {URL}/internal/webhooks/{source}`（`source` は
`cloudsign` / `backlog` / `slack`）。ユーザー認証は通らない。

- **Slack** は署名検証（`x-slack-request-timestamp` + `x-slack-signature`）。
  `SLACK_SIGNING_SECRET` が未設定なら**常に 401**（fail-closed）。
- **CloudSign / Backlog** は共有シークレット。ヘッダ `x-lb-webhook-token` に
  `legalbridge-v3-webhook-token` の値を入れる。未設定なら受け口ごと 404。

外部IDは本文の `event_id` / `id` / `documentID` / `documentId`、
または `x-lb-event-id` ヘッダから取る。取れなければ 400 で受け付けない。
同じ外部IDの二度目は `{"accepted":true,"duplicated":true}` を返して何もしない。

Cloud Run が `--no-allow-unauthenticated` のままだと外部から叩けないので、
受信を有効にするタイミングで `/internal` だけを通す経路（Load Balancer + Cloud Armor、
または該当サービスへの `allUsers` 付与）を用意する。

受け取った出来事は記録するだけでなく業務に反映する:

| 受信 | 反映先 |
|---|---|
| CloudSign 署名完了 | **合意**の状態を `executed` に（文書ではない。署名されたのは合意そのもの） |
| CloudSign 辞退・取消 | 合意の状態を `terminated` に |
| CloudSign 送信済・閲覧済 | 途中経過。何も動かさない |
| Backlog 課題の更新 | 紐づけ（`matter_links`）に最新の状態を写す。**案件の状態は動かさない** |
| Backlog 課題が完了・案件は開いたまま | `BACKLOG_CLOSED_MATTER_OPEN` の課題が立つ（人が判断する） |

### 8.5 定期実行

`POST {URL}/internal/jobs/{name}`（`daily` / `mail-intake`）。共有シークレット
`x-lb-webhook-token` で守る。

**`/api/v3/jobs/...` を Cloud Scheduler から叩かないこと。** `/api/v3` は IAP の
ヘッダを見るので、OIDC トークンだけでは 401 になる（毎朝静かに落ちる）。
コマンドは `docs/v3-deploy-cloudshell.md` の手順8・8.5。

- `daily`：満了間近の契約・期日超過のタスク・支払期日を洗い出し、
  ゲートを通して通知する。off なら洗い出しと記録だけ。
- `mail-intake`：`GMAIL_INTAKE_LABEL` のラベルが付いたメールから案件を立てる。
  重複はメッセージIDで弾く。取引先は作らない（当たらなければ課題として残す）。

---

## 9. 切戻し

V3 は V1・V2 に一切触れていないので、切戻しは V3 を消すだけで完結する。

**アプリだけ戻す**（データは残す）:

```bash
gcloud run services delete legalbridge-v3 --region=asia-northeast1
```

**1つ前のリビジョンへ**:

```bash
gcloud run revisions list --service=legalbridge-v3 --region=asia-northeast1
gcloud run services update-traffic legalbridge-v3 \
  --region=asia-northeast1 --to-revisions=<REVISION>=100
```

**全部消す**:

```bash
gcloud run services delete legalbridge-v3 --region=asia-northeast1
psql "$ADMIN_DSN" -c "DROP SCHEMA v3 CASCADE;"
psql "$ADMIN_DSN" -c "DROP ROLE legalbridge_v3_runtime;"
```

`public` スキーマと V1・V2 のサービスはどの操作でも影響を受けない。

---

## 10. 並行稼働と本番切替

V3 を立てた直後は **V1 が正**。V3 は参照して突き合わせる期間を置く。

1. **参照期間** — `READ_ONLY=true` で立て、V1 と同じ数字が出るかを見る。
   金額・件数・期限の3つを実データで突き合わせる。
2. **二重入力期間** — `READ_ONLY=false` にし、新規は両方に入れる。
   移行スクリプトは冪等なので、V1 側の更新を V3 へ流し直せる（010→040 を再実行）。
3. **切替** — V3 を正にする。V1 は参照専用にする。
4. **停止** — `data_quality_issues` の `high` が 0 になり、
   1決算期を V3 だけで回せたら V1 を止める。

各段階の入口で `090_verify.sql` を流し直し、件数と金額が合うことを確認する。

---

## 付録：ローカルで同じ手順を試す

本番へ行く前に、手元の PostgreSQL で一通り流せる。

```bash
createdb legalbridge_v3_local
export ADMIN_DSN="postgres://localhost/legalbridge_v3_local"

psql "$ADMIN_DSN" -f infra/v3/testdata/mock_public.sql   # V1 形の合成データ
psql "$ADMIN_DSN" -f infra/v3/001_schema.sql
psql "$ADMIN_DSN" -f infra/v3/002_views.sql
for f in 010_migrate_master 020_migrate_core 030_migrate_matters 040_migrate_documents; do
  psql "$ADMIN_DSN" -f "infra/v3/${f}.sql"
done
psql "$ADMIN_DSN" -f infra/v3/090_verify.sql

cp apps/legalbridge-v3/.env.example apps/legalbridge-v3/.env   # DB_* を書き換える
npm run dev:v3
```

`testdata/mock_public.sql` は**本番へは絶対に適用しない**（`public` に
合成データを入れるスクリプト）。ファイル冒頭にも同じ注意書きがある。
