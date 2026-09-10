# LegalBridge V3 予備系（ローカル版）

GCP（Cloud Run・Cloud SQL）が止まったときに、手元の PC で前夜までの案件・条件・文書を
**見られる**ようにする構成。開発・実証実験にも同じものを使う。

- 本番の `v3` スキーマの写しを毎晩取り、ローカルの PostgreSQL に入れ直す
- アプリは本番と同じ `Dockerfile.v3` で動く。既定は **読み取り専用**
- Backlog・Slack・メール・CloudSign は止めたまま（設定しない＝送らない）
- ファイルは Google Drive のリンクのまま。GCP と Google Workspace は別物なので、
  Cloud Run が落ちても Drive のリンクは開けることが多い
- 本番 DB にはつながない。同期のときだけ読み取り専用ロールで写しを取る

停止中に文書を **作る**（決定・送信）ことは、この段階では対象外。

## 構成

```
infra/local/
  docker-compose.yml   db（PostgreSQL）／app（V3）／ops（同期・復元の作業用）
  .env.example         設定のひな形。.env に写して埋める
  bin/ops.sh           ops コンテナの中で走るスクリプト（sync / restore / fresh / grants / status）
  db/init/             ローカル DB の初回起動でランタイムロールを作る
  ops/Dockerfile       psql・pg_dump と Cloud SQL Auth Proxy を入れた作業用イメージ
  sql/backup_role.sql  本番に作る読み取り専用ロール（Studio で1回）
  dumps/               写し（git には入らない）
  data/                データの時点の印と、ローカル保存のファイル（git には入らない）
  keys/                同期に使うサービスアカウントの鍵（git には入らない）
```

## 事前準備（平時に1回）

1. **PC に Docker Desktop** を入れる。ディスクは暗号化しておく（本番データの写しが置かれる）。
2. **設定ファイル**：`infra/local/.env.example` を `infra/local/.env` に写して埋める。
   ローカル DB の 2 つのパスワードは新しく決める。
3. **本番に読み取り専用ロール**を作る：`infra/local/sql/backup_role.sql` の `<PASSWORD>` を
   置き換えて Cloud SQL Studio で流し、同じ値を `.env` の `SYNC_DB_PASSWORD` に書く。
4. **同期に使う認証情報**。次のどちらか。
   - **人のログイン（組織ポリシーで鍵が作れないときはこちら）**：Cloud SQL クライアント以上の
     権限を持つ自分のアカウントでログインし、その認証情報を `keys/adc.json` に置く。
     まずコンテナから Google に届くかを見て、届くならコンテナ側でログインする。
     ```powershell
     docker compose run --rm ops netcheck
     docker compose run --rm login
     ```
     `login` は PC の gcloud にブラウザを開かせるだけで、Google への通信はコンテナが行う。
     画面に出る `gcloud auth application-default login --remote-bootstrap="..."` を
     **コマンドごと**もう1つの PowerShell に貼って実行し、ブラウザで許可したあとに
     PowerShell へ出る `https://localhost:8085/?...` を `login` の画面に貼り返す。
     URL だけをブラウザに貼ると `Missing required parameter: redirect_uri` になる。

     PC の gcloud が普通に動く環境なら、PC 側で取って写すだけでもよい。
     ```powershell
     gcloud auth application-default login --project legalbridge-488506
     Copy-Item "$env:APPDATA\gcloud\application_default_credentials.json" keys\adc.json
     ```
     （macOS / Linux は `~/.config/gcloud/application_default_credentials.json`）
   - **サービスアカウントの鍵**：「Cloud SQL クライアント」役割だけを持つサービスアカウントを作り、
     JSON 鍵を `infra/local/keys/sa.json` に置く。両方あれば鍵が優先。
5. 起動：

   ```bash
   cd infra/local
   docker compose up -d --build        # db と app が上がる（初回はビルドに数分）
   docker compose run --rm ops sync    # 本番の写しを取って入れる
   docker compose run --rm ops status  # 写しの一覧と、いま入っているデータの時点
   ```

   http://localhost:8080 を開くと、左下に「予備系／データ YYYY-MM-DD HH:MM 時点」と出る。

## 毎晩の同期

`docker compose run --rm ops sync` を毎晩走らせる。PC は付けたままにする。

- Windows：タスクスケジューラで「プログラム」に `docker`、「引数」に
  `compose run --rm ops sync`、「開始」に `infra/local` のフルパスを指定
- macOS / Linux：`crontab -e` に
  `0 2 * * * cd /path/to/legalbridge_GCP_V2/infra/local && docker compose run --rm ops sync >> dumps/sync.log 2>&1`

同期のたびに `dumps/v3_YYYYmmdd_HHMM.dump` が増え、`KEEP_DUMPS` 世代を超えた古いものから消える。
同期が失敗しても前の写しはそのまま残る（入れ替えは1つの取引で行う）。

同期が止まっていないかは、画面左下の「データ … 時点」か `ops status` で分かる。
**時点が古いまま数日たっていたら、それ自体が異常**（鍵の失効・パスワード変更・PC の停止）。

## 同期が失敗するとき

`ops sync` が「写しを取れませんでした」で止まり、proxy log に `invalid_grant` や
`reauthentication` と出ていたら、人のログインの認証情報が切れている（組織の再認証ポリシー）。
ログインし直して写し直す。

```powershell
gcloud auth application-default login --project legalbridge-488506
Copy-Item "$env:APPDATA\gcloud\application_default_credentials.json" keys\adc.json -Force
docker compose run --rm ops sync
```

`password authentication failed` なら `.env` の `SYNC_DB_PASSWORD` と本番のロールのパスワードが
違う。`permission denied` なら v3 に表が増えたあと `sql/backup_role.sql` の GRANT を流し直していない。

### gcloud のログインが接続エラーで落ちる（Windows）

`gcloud auth application-default login` が `ConnectionError` や
`WinError -1 / 0xffffffff` で落ちるのに、ブラウザや `Invoke-WebRequest` では
Google に届く場合、社内のセキュリティ製品が通信を検査している。Windows はその
製品の証明書を信頼しているが、gcloud に同梱の Python は自前の証明書一覧しか見ないので弾かれる。

Windows が信頼している証明書を書き出して、gcloud にそれを使わせる。

```powershell
$pem = "$HOME\.gcloud-ca.pem"
Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root |
  Sort-Object Thumbprint -Unique |
  ForEach-Object {
    "-----BEGIN CERTIFICATE-----"
    [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
    "-----END CERTIFICATE-----"
  } | Set-Content -Encoding ascii $pem
gcloud config set core/custom_ca_certs_file $pem
gcloud auth application-default login --project legalbridge-488506
```

証明書ではなく接続そのものが張れていない（`Failed to establish a new connection`）場合は、
証明書を足しても直らない。PC の gcloud は諦めて、コンテナ側でログインする。

```powershell
docker compose run --rm ops netcheck     # コンテナから Google に届くかを見る
docker compose run --rm login            # 届くならこれでログインする
```

### gcloud も Proxy も通らないとき

`ops netcheck` がコンテナからも「つながりません」と言う場合、この PC からは
Cloud SQL Auth Proxy を使えない。ネットワークの担当者に
`oauth2.googleapis.com` と `sqladmin.googleapis.com` への接続を許可してもらうのが本筋。

それが通らないなら、毎晩の自動同期は諦めて、ブラウザだけで写しを作る運用にする。

1. Cloud SQL の画面 → インスタンス → エクスポート → 形式 SQL、対象 `legalbridge`、
   出力先の Cloud Storage バケットを指定して実行
2. Cloud Storage の画面から、できたファイルをこの PC にダウンロード
3. `infra/local/dumps/` に置いて `docker compose run --rm ops restore /dumps/<ファイル名>`

この経路では写しに V1・V2 の `public` も含まれる。手元に置く範囲が広がるので、
PC の管理はいっそう厳しくすること。

## GCP が停止したとき

1. 予備系の PC で `docker compose ps` を見て db と app が上がっていることを確かめる
   （上がっていなければ `docker compose up -d`）。
2. 同じネットワークの人には `http://<PC の名前または IP>:8080` を案内する。
   認証は無いので、社内ネットワークの外に公開しないこと。
3. 画面左下の「データ … 時点」を見て、**それより後の変更は入っていない**ことを共有する。
4. 停止中の登録・決定は、復旧後に本番で行う。予備系は読み取り専用で受け付けない。

## 復旧したあと

何もしなくてよい。翌晩の同期で本番の最新に戻る。すぐ戻したければ
`docker compose run --rm ops sync`。

## 開発・実証実験で使うとき（本番データなし）

```bash
docker compose run --rm ops fresh     # V1 相当の模擬データから作る
```

書き込みも試すなら `.env` の `READ_ONLY=false` にして `docker compose up -d app`。
`LOCAL_USER_ROLE` を `legal` や `requester` にすると、その役割での見え方になる。
決定した文書の PDF や取り込んだファイルは Drive ではなく `data/files/` に置かれ、
画面からは `/api/v3/local-files/<id>` で開く。

本番の写しの上で書き込みを試すこともできる（`READ_ONLY=false`）が、
翌晩の同期で全部消える。持ち帰りたい変更は本番で入れ直すこと。

## 手元の写しを入れ直す

```bash
docker compose run --rm ops status
docker compose run --rm ops restore /dumps/v3_20260909_0200.dump
```

## 中を覗く

```bash
docker compose exec db psql -U postgres legalbridge     # 管理者
docker compose logs -f app                               # アプリのログ
```

## 気をつけること

- `dumps/` と `data/` には口座情報・個人情報を含む本番の写しが入る。
  この PC に触れる人を絞り、不要になった写しは消す。
- `keys/sa.json` と `.env` は git に入らない（`.gitignore`）。他の場所に写さない。
- 本番へ書き戻す仕組みはない。予備系で入れた変更は本番に反映されない。
- Linux の PC で `data/` に書けないときは `sudo chown -R 1000:1000 data`
  （app コンテナは uid 1000 で動く）。
