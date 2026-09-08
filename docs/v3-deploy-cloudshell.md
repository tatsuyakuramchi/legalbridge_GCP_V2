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

> **`002_views.sql` を流し直したら、必ず `003_grants.sql` も流し直すこと。**
> ビューを作り直すとランタイムロールにビューへの書込権限が付く経路がある。
> 003 がそれを剥がす。手順4の「想定外の権限 0行」で確認できる。

**★ 確認：表28 / ビュー7**

```bash
psql -c "SELECT count(*) FILTER (WHERE table_type='BASE TABLE') AS tables,
                count(*) FILTER (WHERE table_type='VIEW')       AS views
           FROM information_schema.tables WHERE table_schema='v3';"
```

---

## 手順3.5：あとから足した変更を当てる

`001_schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、**既に作った表には
流し直しても効かない**。制約や列の変更は `004_amend.sql` に積んである。
何度流しても同じ結果になる。

```bash
psql -v ON_ERROR_STOP=1 -f infra/v3/004_amend.sql
```

初回は `A-001: matter_links.target_type に email_thread を足した`、
2回目以降は `A-001: 適用済み` と出る。どちらも正常。

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

## 手順8：定期実行を仕込む

画面を開かないと気づけないもの（満了間近の契約・期日を過ぎたタスク・
支払期日）を、毎朝洗い出す。実データでは42日放置されたタスクが誰にも
知られずに残っていた。

通知は外部送信のゲートを通すので、**モードが off のあいだは送らない**
（洗い出して記録するだけ）。先に仕込んでおいて構わない。

> **叩き先は `/internal/jobs/...`。`/api/v3/...` ではない。**
> `/api/v3` は IAP のヘッダ（`x-goog-authenticated-user-email`）を見る。
> Cloud Scheduler の OIDC トークンではそのヘッダが付かないので、
> `/api/v3/jobs/daily` を指すと**毎朝401で落ちる**（しかも誰も気づかない）。
> `/internal` はユーザー認証を通さず、**Cloud Run の呼び出し権限＋共有
> シークレット**の2つで守る。

```bash
gcloud services enable cloudscheduler.googleapis.com

PROJECT=legalbridge-488506
URL="$(gcloud run services describe legalbridge-v3 --region=asia-northeast1 --format='value(status.url)')"
SA="legalbridge-v3@${PROJECT}.iam.gserviceaccount.com"
TOKEN="$(gcloud secrets versions access latest --secret=legalbridge-v3-webhook-token)"

# Cloud Run は --no-allow-unauthenticated なので、呼び出し権限を与える。
gcloud run services add-iam-policy-binding legalbridge-v3 \
  --region=asia-northeast1 --member="serviceAccount:${SA}" --role=roles/run.invoker

# 日次の点検（平日9時・東京）
gcloud scheduler jobs create http legalbridge-v3-daily \
  --location=asia-northeast1 \
  --schedule="0 9 * * 1-5" \
  --time-zone="Asia/Tokyo" \
  --uri="${URL}/internal/jobs/daily" \
  --http-method=POST \
  --headers="Content-Type=application/json,x-lb-webhook-token=${TOKEN}" \
  --message-body='{"notifyChannel":"slack","notifyTo":"C0XXXXXXX"}' \
  --oidc-service-account-email="${SA}" \
  --oidc-token-audience="${URL}"
```

`notifyTo` は Slack のチャンネルID。Gmail で送るなら
`{"notifyChannel":"gmail","notifyTo":"legal@example.com"}`。

**★ 確認：手で1回動かす**

```bash
gcloud scheduler jobs run legalbridge-v3-daily --location=asia-northeast1
gcloud scheduler jobs describe legalbridge-v3-daily --location=asia-northeast1 \
  --format='value(status.code,lastAttemptTime)'
# → status.code が空（＝成功）であること。2 や 16 が出たら401/403を疑う
```

通知せず洗い出しだけ見たいときは画面から確かめられる（運用タブ→期日）。

---

## 手順8.5：メールの取り込みを仕込む

法務の共有アドレスに届いた契約のやり取りから案件を立てる。人が転記して
いると、転記されなかったものが案件として存在しないことになる。

**取り込む範囲は Gmail 側のラベルで決める。** 受信箱すべてを対象にすると
社内の雑談まで案件になる。法務がフィルタでラベルを付け、その運用だけで
範囲を調整できるようにしてある。

| 決めること | 値 |
|---|---|
| Gmail のラベル | 例：`法務受付`（フィルタで自動付与） |
| 環境変数 | `GMAIL_INTAKE_LABEL=法務受付` |
| 追加のスコープ | `https://www.googleapis.com/auth/gmail.readonly` |

サービスアカウントに **ドメイン全体の委任**（共有アドレスの代理読み取り）が
要る。Google Workspace 管理コンソール → セキュリティ → API の制御 →
ドメイン全体の委任 で、クライアントIDに上のスコープを許可する。

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars="GMAIL_INTAKE_LABEL=法務受付"

# 30分ごとに取り込む
gcloud scheduler jobs create http legalbridge-v3-mail \
  --location=asia-northeast1 \
  --schedule="*/30 * * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="${URL}/internal/jobs/mail-intake" \
  --http-method=POST \
  --headers="Content-Type=application/json,x-lb-webhook-token=${TOKEN}" \
  --message-body='{"limit":25}' \
  --oidc-service-account-email="${SA}" \
  --oidc-token-audience="${URL}"
```

取り込みの規則:

| 届いたもの | どうなるか |
|---|---|
| 初めてのスレッド | 案件が1件立つ（件名が案件名、言葉から種別を寄せる） |
| 同じスレッドの続き | 案件は増えない。紐づけに最新の件名・添付名が残る |
| 件名に `MTR-2026-00219` | その案件に寄る |
| こちらが出した文書番号への返信 | その文書の案件に寄る |
| 自動返信・不在通知・不達通知 | 取り込まない（記録もしない） |
| 差出人が取引先の連絡先に1件だけ一致 | 相手先が付く |
| 一致しない／2件以上 | **相手先を作らない**。`MAIL_SENDER_UNRESOLVED` の課題が立つ |

> 取引先をここで作らないのは意図的。依頼者は相手先を正式名称で書かない
> ので、書かれたとおりに作るとマスタが表記ゆれで膨らむ（V1 の取引先が
> 2,552件になった経路）。相手先の登録は法務が画面から行う。

**★ 確認：まず手で1回**

```bash
gcloud scheduler jobs run legalbridge-v3-mail --location=asia-northeast1
```

運用タブ→外部連携で「メールの取り込み：有効」になっていること。
立った案件は 案件一覧に `MTR-` で並ぶ。当たらなかった差出人は
運用タブ→データ品質に出る。

栞（どこまで読んだか）は `v3.settings` の `mail_intake_cursor`。
取り込みの重複はメッセージIDで弾くので、栞を戻しても案件は増えない。

```bash
psql -c "SELECT value FROM v3.settings WHERE key='mail_intake_cursor';"
```

---

## 手順8.6：Slack の受付フォーム

`/法務依頼` から案件を立てる。Slack アプリ側の設定が要る。

| 設定 | 値 |
|---|---|
| Slash Command | `/法務依頼` → `{URL}/internal/slack/commands` |
| Interactivity | Request URL → `{URL}/internal/slack/interactions` |
| Event Subscriptions | `{URL}/internal/webhooks/slack` |
| 必要な権限 | `commands`, `chat:write`, `views:open` |

署名シークレットを入れる（未設定だと**常に401**で受け付けない）:

```bash
create_secret legalbridge-v3-slack-signing-secret "<Slack の Signing Secret>"
create_secret legalbridge-v3-slack-bot-token "xoxb-..."

gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=^@^_GIT_SHA=$(git rev-parse --short HEAD)@_SLACK_MODE=dry_run@_SECRETS_EXTRA=SLACK_BOT_TOKEN=legalbridge-v3-slack-bot-token:latest,SLACK_SIGNING_SECRET=legalbridge-v3-slack-signing-secret:latest \
  .
```

受付フォーム自体は送信を伴わないので `SLACK_MODE=off` でも動く。
`dry_run` / `live` は V3 から Slack へ**送る**ときに効く。

⚠️ Cloud Run が `--no-allow-unauthenticated` のままだと Slack から
届かない。受付を有効にするタイミングで `/internal` を通す経路を用意する
（Load Balancer + Cloud Armor、または該当サービスへの `allUsers` 付与）。

## 手順8.7：Backlog と繋ぐ

案件と Backlog の課題を1対1で繋ぎ、課題の状態を案件画面に写す。
**繋いでいない課題の更新は届かない**ので、繋ぐところまでが設定。

```bash
# 課題種別IDを調べる（BACKLOG_ISSUE_TYPE_ID に使う）
curl -sS "https://xxx.backlog.jp/api/v2/projects/LEGAL/issueTypes?apiKey=${BACKLOG_API_KEY}" \
  | jq '.[] | {id, name}'

create_secret legalbridge-v3-backlog-api-key "<Backlog の API キー>"

gcloud builds submit --config infra/v3/cloudbuild.yaml \
  --substitutions=^@^_GIT_SHA=$(git rev-parse --short HEAD)@_BACKLOG_MODE=dry_run@_BACKLOG_HOST=xxx.backlog.jp@_BACKLOG_PROJECT_ID=12345@_BACKLOG_ISSUE_TYPE_ID=67890@_SECRETS_EXTRA=BACKLOG_API_KEY=legalbridge-v3-backlog-api-key:latest \
  .
```

Backlog 側で webhook を登録する:

| 設定 | 値 |
|---|---|
| Webhook URL | `{URL}/internal/webhooks/backlog` |
| 通知する操作 | 課題の追加・更新・コメント |

共有シークレットのヘッダ（`x-lb-webhook-token`）を Backlog の webhook は
送れないので、`/internal` を通す経路側（Load Balancer + Cloud Armor）で
ヘッダを付与するか、Backlog 用の経路だけ IP 制限で守る。

**★ 確認：画面から1件試す**

1. 案件を1つ開き、「参照しているマスタ」の下の **Backlog に課題を立てる**
   を押す。`dry_run` のあいだは立たず、何を送るかだけが出る。
2. `_BACKLOG_MODE=live` にして押し直すと課題が立ち、課題キーで繋がる。
3. Backlog 側で状態を「処理中」に変えると、同じ表の「状態」に写る。
   **案件の状態は動かない**（人が判断する）。
4. 課題を「完了」にしても案件が開いたままなら、運用タブ→データ品質に
   `Backlog の課題は完了だが案件が開いたまま` が出る。

すでに Backlog に課題がある案件は、課題キー（例 `LEGAL-12`）を入れて
**すでにある課題に繋ぐ**を押す。課題は立たず、繋ぐだけ。

守っている規則:

- 1案件に1課題。二度押しても増えない。
- 同じ課題を2つの案件には繋げない（受信でどちらの話か決まらなくなる）。
- 外したあと同じ内容で押し直すと、新しい課題は立てずに元の課題へ繋ぎ直す。

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

S1 以降は**確認専用**。移行スクリプト（001〜090）は上の Cloud Shell 手順で流すこと。
唯一の例外が次の S0 で、これは Studio から当ててよい形に書き直してある。

## S0. 手順3.5（`004_amend.sql`）を Studio から当てる

`matter_links.target_type` に `email_thread` を足す。メールのスレッドを案件に
繋ぐのに要る。**足すまでメールの取り込みは必ず失敗する。**

`004_amend.sql` そのものは `\set` `\echo` を含むので Studio では流せない。
以下は同じことを素の SQL でやる。**上から順に1つずつ**実行する。

**S0-1 いまの状態を見る**

```sql
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'v3.matter_links'::regclass AND contype = 'c';
```

`def` に `email_thread` が既に入っていれば適用済み。ここで終わってよい。
入っていなければ次へ（`conname` は控えておく。多くは
`matter_links_target_type_check`）。

**S0-2 新しい制約を別名で足す**

```sql
ALTER TABLE v3.matter_links
  ADD CONSTRAINT matter_links_target_type_chk
  CHECK (target_type IN ('backlog_issue','document','agreement','condition',
                         'payment','slack_thread','email_thread'));
```

> 先に足してから古いのを落とす順にしてある。逆にすると、2つの文の間に
> **制約が1つも無い時間**ができる。この順なら、途中で止まってもテーブルは
> 常にどちらかの制約で守られている（この間は厳しい方＝古い方が効く）。

**S0-3 古い制約を落とす**

```sql
ALTER TABLE v3.matter_links
  DROP CONSTRAINT IF EXISTS matter_links_target_type_check;
```

S0-1 の `conname` が違う名前だったら、そちらを書くこと。

**S0-4 確かめる**

```sql
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'v3.matter_links'::regclass AND contype = 'c';
```

`matter_links_target_type_chk` が1つだけ残り、`def` に `email_thread` が
入っていること。**2つ残っていたら S0-3 が効いていない**（この状態だと
メールの取り込みは失敗し続ける）。

S0-2 を二度実行すると `constraint ... already exists` が出る。害はない。
すでに当たっている印なので、そのまま S0-4 で確かめて先へ進む。

## S1. 作られたもの（手順3のあと）

```sql
SELECT table_type, count(*)
  FROM information_schema.tables
 WHERE table_schema = 'v3'
 GROUP BY table_type ORDER BY table_type;
-- BASE TABLE = 28 / VIEW = 7
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
