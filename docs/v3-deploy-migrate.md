# デプロイで DB を自動でそろえる（Cloud Build の migrate の段）

`main` へのマージで走るデプロイ（トリガー `legalbridge-v3-deploy`）が、アプリを出す**前に**本番の DB を今のコードにそろえる。
手で Cloud Shell から SQL を流さなくてよくなる。ローカルの `ops upgrade` も同じものを流す。

## 何が流れるか（`infra/v3/deploy-migrate.sh`）

1. **`catchup_schema.sql`**（毎回）：004_amend → 004 に入っていない番号付きの作りの変更 → 004_amend → 002_views → 003_grants。
   表・列・制約・引き金・ビュー・権限。何度流しても同じ結果
2. **`deploy-migrations.txt` に書いた SQL**（1 回だけ）：ひな形の登録など中身の変更。流したものは
   `lb_ops.deploy_migrations` に控え、次のデプロイからは流さない

どこかで止まると、**デプロイしない**（今のリビジョンのまま動き続ける）。それより前に当てた分は残るが、どれも流し直してよい。
表を長くつかむ変更で待たされないよう、`lock_timeout=30s`・`statement_timeout=15min` で流す。

### これから SQL を足すとき

- 表・列・制約・ビュー・権限 → `004_amend.sql`（または番号付きの作りの変更を `catchup_schema.sql` に並べる）
- ひな形の登録・中身の直し → 番号付きの SQL を作り、`deploy-migrations.txt` の末尾に 1 行足す
  （何度流しても同じ結果になるように書く。上の行は消さない・並べ替えない）

## はじめに 1 回だけ（Cloud Shell）

### 1. 表の持ち主（postgres）のパスワードを Secret Manager に入れる

```bash
read -rsp "postgres のパスワード: " P; echo
printf '%s' "$P" | gcloud secrets create legalbridge-v3-admin-db-password --data-file=- --replication-policy=automatic
unset P
```

### 2. ビルドのサービスアカウントに権限を付ける

```bash
SA=legalbridge-v3-build@legalbridge-488506.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding legalbridge-488506 --member="serviceAccount:$SA" --role=roles/cloudsql.client
gcloud secrets add-iam-policy-binding legalbridge-v3-admin-db-password --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
```

### 3. トリガーで動かす

Cloud Build → トリガー → `legalbridge-v3-deploy` → 編集 → 代入変数に **`_MIGRATE` = `on`** を足して保存。
（既定は `off`。off の間は migrate の段は何もせずに通る）

### 4. 試す

```bash
gcloud builds triggers run legalbridge-v3-deploy --branch=main
```

ビルドのログの `migrate` の段に「つないだ先: postgres@legalbridge」「== 完了」が出て、そのあと `deploy` が走れば OK。

## 止まったとき

| ログ | 意味と対処 |
|---|---|
| Cloud SQL につながりません | 2 の `roles/cloudsql.client` が無い。proxy のログが上に出る |
| PERMISSION_DENIED … secrets | 2 のシークレットの権限が無い／1 のシークレット名が違う（代入変数 `_DB_ADMIN_PASSWORD_SECRET`） |
| password authentication failed | 1 のパスワードが違う。`gcloud secrets versions add legalbridge-v3-admin-db-password --data-file=-` で入れ直す |
| canceling statement due to lock timeout | アプリが表をつかんでいた。少し待ってトリガーを流し直す |
| それ以外の SQL のエラー | 出たファイルと行を貼って相談。デプロイはされていない |
