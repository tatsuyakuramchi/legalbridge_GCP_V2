# LegalBridge V3 予備系（ローカル版）

GCP（Cloud Run・Cloud SQL）が止まったときに、手元の PC で前夜までの案件・条件・文書を
**見られる**ようにする構成。開発・実証実験にも同じものを使う。

- 本番の `v3` スキーマの写しを毎晩取り、ローカルの PostgreSQL に入れ直す
- アプリは本番と同じ `Dockerfile.v3` で動く。既定は **読み取り専用**
- Backlog・Slack・メール・CloudSign は止めたまま（設定しない＝送らない）
- ファイルは Google Drive のリンクのまま。GCP と Google Workspace は別物なので、
  Cloud Run が落ちても Drive のリンクは開けることが多い
- 本番 DB へ書き込むことはない。つなぐのは写しを取るとき（`ops sync`）と、
  読むだけの照会を流すとき（`ops sql-prod`）だけ。どちらも読み取り専用ロール

停止中に文書を **作る**（決定・送信）ことは、この段階では対象外。

## いまの状態（2026-09-10 時点）

**開発・実証実験用としては動く。予備系としての同期は保留中。**

- 動くもの: ローカルの DB とアプリ、模擬データでの開発（`ops fresh`）、
  手元の写しの取り込み（`ops restore`）
- 保留: 本番からの自動同期（`ops sync`）。下の理由で経路が塞がっている

同期の 2 経路とも、この会社のネットワークと GCP の契約では通せなかった。

| 経路 | 使う口 | 止まった理由 |
| --- | --- | --- |
| Cloud SQL Auth Proxy | 443 と 3307 | 社内ネットワークが 3307 番を拒否（443 は通る） |
| Cloud Storage 経由 | 443 のみ | GCP の契約の都合でバケットを作れない |

自動同期は使えないが、**本番の中身を手作業で持ってくる経路はある**。
Cloud SQL Studio は使えるので、そこから取り出して取り込む（下の「Studio から本番の中身を入れる」）。

**再開するとき**は、どちらか一方が解ければそのまま動く。

- ネットワークの担当者から外向き TCP 3307 番の許可が取れた →
  `.env` を `SYNC_MODE=proxy` にして `ops sync`
- Cloud Storage のバケットが作れるようになった →
  「443 番だけで写す」の手順どおりに `SYNC_MODE=export`
- サービスアカウントの鍵が作れるようになった →
  `keys/sa.json` を置けば `login` は要らない

**保留中にやっておくこと**: 同期に使うログイン情報（`keys/adc.json`）は使わないので
消しておく。再開のときに `docker compose run --rm login` でまた作れる。

```powershell
Remove-Item keys\adc.json -ErrorAction SilentlyContinue
```

## 構成

```
infra/local/
  docker-compose.yml   db（PostgreSQL）／app（V3）／ops（同期・復元の作業用）
  .env.example         設定のひな形。.env に写して埋める
  bin/ops.sh           ops コンテナの中で走るスクリプト（sync / restore / fresh / upgrade / grants / status）
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

## 照会を流す

棚卸しや診断の SQL は `infra/v3` に置いてあり、ops コンテナから `/v3/…` で指せる。

```bash
# 手元の写しに対して流す
docker compose run --rm ops sql /v3/diag/orphan-documents.sql
docker compose run --rm ops sql /v3/diag/party-documents.sql q=取引先名

# 本番に対して流す（読むだけ）
docker compose run --rm ops sql-prod /v3/diag/orphan-documents.sql
docker compose run --rm ops sql-prod /v3/diag/party-documents.sql q=取引先名
```

`名前=値` を足すと、照会の中の `:'名前'` に入る。ファイルを書き換えなくてよい。

`sql-prod` は書き込みを口ごと閉じる（`default_transaction_read_only`）。
照会に UPDATE が紛れ込んでいても本番では実行されない。つなぐのも写しを取る役
（読み取り専用ロール）なので、二重に守られている。`SYNC_DB_PASSWORD` が要る。

Cloud SQL Studio でも同じ照会を流せるが、`\set` も `\echo` も効かない。
先頭の `\` で始まる行を消し、`:'q'` を `'値'` のように引用符ごと置き換えること。

## コードを更新したとき

列が増える変更を取り込んだら、手元の DB も合わせる。入っているデータはそのまま。

```powershell
git pull
docker compose up -d --build app
docker compose run --rm ops upgrade
```

`upgrade` を忘れると、アプリが新しい列を読もうとして画面に
「サーバ内部でエラーが発生しました」と出る。何度流しても同じ結果になる。
`upgrade` は何度流しても同じ（表を作り直したりはしない）ので、
列が増えたかどうか分からないときは流しておけばよい。

**画面が古いままのとき。** `docker compose up -d --build app` で入れ替わった
はずの画面が前のままなら、ブラウザが古い JavaScript を握っている。
入れ替わったかどうかは `/health` で分かる。

```powershell
Invoke-RestMethod http://localhost:8080/health | ConvertTo-Json
```

（PowerShell の `curl` は `Invoke-WebRequest` の別名で、中身が包み紙に
入って出る。`Invoke-RestMethod` なら中身がそのまま読める。）

`client.builtAt` が `git pull` より後の時刻なら、サーバは新しい。
そのうえで画面が古ければブラウザ側なので、Ctrl+F5（強制再読み込み）。

書き込めるかどうかは同じ答えの `readOnly` で分かる。`.env` を直接見るなら
`Select-String READ_ONLY .env`。

## 社外から使う（Cloudflare Tunnel）

別の PC や社外からブラウザで使えるようにする。PC から Cloudflare へ外向きの
トンネルを張り、手前の Cloudflare Access がログイン（Google かメールの確認コード）を
させる。ルーターのポート開放も固定 IP も要らない。50 人までは無料。

```
社外のブラウザ ──https──▶ Cloudflare（Access でログイン）
                                  │  トンネル（PC から外向き）
                      この PC の docker compose ── tunnel ─▶ app:8080
```

アプリは Access が付けてくる署名付きトークンを検証し、メールで人を見分ける
（`AUTH_MODE=cloudflare`）。役割はメールで決まり、操作の記録にも本人のメールが残る。
ヘッダのメールだけは信じないので、トンネルを通らない直アクセスで名乗ることはできない。

### 0. まず無料で試す（Quick Tunnel）

ドメインもアカウントも無しで、数分で社外から開ける URL が出る。ただし
**ログインが付かない**（URL を知っている人は誰でも入れる）ので、見せるだけ・短い間だけにする。

1. `.env` を見せるだけの設定にする（口座番号などは admin / legal にしか出ない）。

   ```
   READ_ONLY=true
   LOCAL_USER_ROLE=requester
   ```

2. 起動して、URL を拾う。

   ```powershell
   docker compose up -d app
   docker compose --profile quicktunnel up -d
   docker compose logs quicktunnel | Select-String trycloudflare
   ```

   `https://○○○.trycloudflare.com` が出る。これを見せたい人にだけ渡す。

3. 終わったら必ず閉じる。

   ```powershell
   docker compose stop quicktunnel
   ```

- 起動し直すたびに URL が変わる（前の URL は使えなくなる）。
- 同時に 200 リクエストまで。数人で見る分には足りる。
- 本格的に使うなら下の 1〜4（専用ドメイン＋Access のログイン）に移る。

### 1. ドメインを用意する（会社のドメインは使わない）

1. Cloudflare のアカウントを作る（会社のメールで）。
2. ダッシュボードの **Domain Registration › Register Domains** で、LegalBridge 専用の
   ドメインを 1 つ取る（例: `arclight-lb.com`）。年額は数千円程度。Cloudflare で取った
   ドメインは最初から Cloudflare の DNS に載るので、DNS の移し替えは要らない。

### 2. トンネルを作る

1. **Zero Trust › Networks › Tunnels › Create a tunnel**。種類は **Cloudflared**、名前は `legalbridge-local`。
2. 表示されるインストール用のコマンドの中の、長いトークン（`eyJ…`）だけを控える。
   インストールはしない（Docker で動かす）。
3. **Public Hostname** を 1 つ足す。
   - Subdomain: `app`、Domain: 取ったドメイン（→ `app.arclight-lb.com`）
   - Service: Type `HTTP`、URL `app:8080`

### 3. ログインを付ける（Access）

1. **Zero Trust › Access › Applications › Add an application › Self-hosted**。
   - Application domain: `app.arclight-lb.com`
   - Session Duration: 24 hours など
2. ログイン方法（**Settings › Authentication**）。まずは **One-time PIN**（メールに届く
   6 桁のコード）が設定なしで使える。Google でログインさせるなら Google を足す。
3. ポリシー: Action **Allow**、Include **Emails ending in** `@arclight.co.jp`。
   社外の人（翻訳者など）を入れるときは、Include に **Emails** でその人を足す。
4. 保存したアプリの **Overview** にある **Application Audience (AUD) Tag** を控える。
5. チームのドメイン（`xxxx.cloudflareaccess.com`）を控える
   （**Settings › Custom Pages** の Team domain）。

### 4. この PC に設定する

`.env` に足す（`.env.example` の「社外から使う」の欄）。

```
APP_PORT=127.0.0.1:8080
TUNNEL_TOKEN=eyJ…（2 で控えたもの）
AUTH_MODE=cloudflare
CF_ACCESS_TEAM_DOMAIN=xxxx.cloudflareaccess.com
CF_ACCESS_AUD=（3 で控えた AUD タグ）
ADMIN_EMAILS=kuramochi@arclight.co.jp
LEGAL_EMAILS=
REQUESTER_DOMAINS=arclight.co.jp
```

- `APP_PORT=127.0.0.1:8080` で、LAN からの直アクセスを塞ぐ。この PC のブラウザも
  `https://app.arclight-lb.com` から入る（`localhost:8080` はログインが無いので 401 になる）。
- 役割は ADMIN_EMAILS（管理者）→ LEGAL_EMAILS（法務）→ REQUESTER_DOMAINS（依頼者）の順に当てる。
  どれにも当たらない人は Access を通っても 403。
- 書き込ませるなら `READ_ONLY=false`。

起動する。

```powershell
docker compose up -d --build app
docker compose --profile tunnel up -d
```

`https://app.arclight-lb.com` を開き、ログインを通ると画面が出る。

### 止める・戻す

```powershell
docker compose stop tunnel        # 社外からの口だけ閉じる
```

認証なしの手元専用に戻すなら、`.env` の `AUTH_MODE` と `APP_PORT` を消して
`docker compose up -d app`。

### 気をつけること

- **この PC を切ると誰も使えない。** 電源の設定でスリープを止める。Windows の更新で
  再起動したあとは Docker Desktop が自動で立ち上がるようにしておく（コンテナは
  `restart: unless-stopped` で戻る）。
- **データはこの PC の中にある。** BitLocker でディスクを暗号化し、写しを取っておく。
- **通信は Cloudflare を通る。** 経路は暗号化されるが、中継で一度復号される。
  口座番号や個人の連絡先が載る画面なので、社内で了承を取っておく。
- **トンネルのトークンは鍵と同じ。** 漏れたら Tunnels の画面でトンネルを消して作り直す。
- 51 人目からは 1 人あたり月 $7 かかる（Zero Trust の有料プラン）。

## 支払文書処理を使うとき

「文書」と「お金」のあいだの**支払文書処理**は、予定 → 実績 → 決済文書 → 支払を
まとめて進める画面で、**書き込む**。`READ_ONLY=true`（予備系の既定）では
「まとめて締める」が断られる。手元で試すときは `.env` を書き換える。

```powershell
# infra/local/.env の READ_ONLY=true を false にしてから
docker compose up -d app
```

試し終えたら `READ_ONLY=true` に戻す。予備系を書ける状態のまま置くと、
本番のつもりで手元を直してしまう。

この画面は列を増やしていないので `ops upgrade` は要らない。

作られるもの（本番と同じ経路を通る）：

| 押すと | できるもの |
|---|---|
| まとめて締める | 実績（予定どおりの額）・決済文書（検収書／計算書）・支払（立てるまで） |
| 算定期間を並べる | 料率の条件に 0 円の予定明細（締め日だけを並べる） |

支払は「立てる」まで。払った事実は銀行にしかないので、この画面から
まとめて支払済みにはしない。

## Studio から本番の中身を入れる

自動同期が使えない環境で、ローカル版に本番のデータを入れる手順。
Cloud SQL Studio だけで完結する。読み取りしかしないので本番は変わらない。

**1. 取り出す**

`infra/v3/094_export_rows.sql` を Studio に貼る。

- 「1.」を流すと行数とページ数が出る（1ページ 5000 行）。**この数を控える**
- 「2.」を流して結果を CSV で落とす。`OFFSET` の数字を 0 → 5000 → 10000 … と
  増やし、ページ数の分だけ繰り返す。ファイル名は何でもよく、順番も問わない

**ページは毎回すべて落とす。** 前に落とした CSV を残したまま新しいページを足すと、
同じ行が重なって取り込みが止まる（下の「取り込みが止まる場合」）。

**2. 取り込む**

落とした CSV を `infra/local/dumps/rows/` に置いて、

```powershell
mkdir dumps\rows -Force

# 前回の取り出しが残っていると、同じ行が重なって取り込みが止まる。先に空にする。
Remove-Item dumps\rows\*.csv -ErrorAction SilentlyContinue

# 見出しが tbl,data のものだけを拾う。関係ない CSV を巻き込まないため。
# まず何が移るのかを見る。
$src = Get-ChildItem "$HOME\Downloads\studio_results_*.csv" |
  Where-Object { ((Get-Content $_.FullName -TotalCount 1) -replace '^\uFEFF','' -replace '"','') -eq 'tbl,data' }
$src | Select-Object Name, LastWriteTime, Length

# よければ移す。
$src | Move-Item -Destination dumps\rows\
Get-ChildItem dumps\rows\*.csv | ForEach-Object { "$($_.Name): $((Get-Content $_ | Measure-Object -Line).Lines - 1)" }
docker compose run --rm ops import-rows /dumps/rows
```

`dumps\rows` には取り出した CSV だけを置く。ほかの CSV が混ざっていると
取り込みは名指しで止まる（文字コードの違うファイルで分かりにくく落ちないように）。

表の構造は手元の定義（`001_schema.sql` + `004_amend.sql`）から作り直し、
中身だけを CSV から入れる。ビューと権限もそのあと当て直す。

**取り込みが止まる場合**

黙って通すより止めるようにしてある。

| 出るもの | 意味 | どうするか |
| --- | --- | --- |
| 手元の定義に無い列があります | 本番に列が増えていて、手元の SQL が古い | `git pull` して、本番に当てた変更が `004_amend.sql` に入っているか確かめる |
| 参照先の無い行があります | ページを落とし損ねている | 足りないページを落として、`dumps/rows/` に全部そろえてからやり直す |
| 同じ行が二度入っています | 別の日に落とした CSV が残ったまま、新しいページを足した | `dumps/rows/` を空にして、094 の「1.」で出たページ数のぶんを落とし直す |
| v3 に無い表が入っています | CSV が別のスキーマのもの | 落とし直す |

**気をつけること**

- 1行が1件で、中身は JSON。NULL・日本語・配列・jsonb・改行も崩れない。
  記号（`<` や `&`）も含めて、取り出しと取り込みで一致することを確認済み。
- 取り込むと手元の v3 は入れ替わる。ローカルで作った案件・文書・下書きは消える。
  入れ替える前に `dumps/before_import_YYYYmmdd_HHMMSS.dump` を自動で取るので、
  消してしまったら `docker compose run --rm ops restore /dumps/before_import_….dump`
  で戻せる（戻すと今度は取り込んだぶんが消えるので、順番に注意）。
- CSV には口座情報や個人情報が入る。取り込んだら `dumps/rows/` は消すこと。

## 連絡先と口座だけを本番の値にする

上の `import-rows` は**全部入れ替える**。手元で作った案件も文書も消えるので、
「取引先の住所・電話・メールと、連絡先・口座だけを本番に合わせたい」ときには使えない。
そのための細い道。

**1. 取り出す**

`infra/v3/098_export_contacts.sql` の3つのクエリを Studio でそれぞれ流し、
結果を CSV で落とす（見出しは `tbl,data` の2列で、094 と同じ形）。

**2. 取り込む**

```powershell
mkdir dumps\contacts -Force

# 見出しが tbl,data のものだけを拾う。まず何が移るのかを見る。
$src = Get-ChildItem "$HOME\Downloads\studio_results_*.csv" |
  Where-Object { ((Get-Content $_.FullName -TotalCount 1) -replace '^\uFEFF','' -replace '"','') -eq 'tbl,data' }
$src | Select-Object Name, LastWriteTime, Length

# よければ移す。
$src | Move-Item -Destination dumps\contacts\
docker compose run --rm ops import-contacts /dumps/contacts

# 取り込んだら消す（口座番号・名義・個人の電話番号が入っている）。
Remove-Item dumps\contacts\*.csv
```

突き合わせは**取引先コード**（`party_code`）。id は本番と手元でずれうるので見ない。
手元に無いコードの行は飛ばして、最後に飛ばした数を出す。取引先そのものは作らない。

入れ替えるのは次だけ。ほかの表には触らない。

| 表 | 直すもの | 突き合わせ |
| --- | --- | --- |
| `parties` | 住所・電話・メール | `party_code` |
| `party_contacts` | 主担当・署名者・請求先 | `party_code` + 役割 |
| `party_bank_accounts` | 銀行・支店・種別・口座番号・名義 | `party_code` |

**★ この CSV には口座番号・名義・個人の電話番号が入る。**
チャットや issue に貼らない。取り込んだら `dumps/contacts/` を消すこと。

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

同期は 2 種類の口を使う。片方だけ塞がれていることがあるので分けて確かめる。

| 行き先 | 番号 | 使いみち |
| --- | --- | --- |
| `oauth2.googleapis.com` / `sqladmin.googleapis.com` | 443 | ログインとインスタンスの情報 |
| Cloud SQL インスタンスの IP | 3307 | Proxy から DB への通信 |

```powershell
docker compose run --rm ops netcheck                        # 443 の 2 つ
docker compose run --rm ops netcheck 34.146.158.194 3307    # DB への口（IP は proxy log に出る）
```

`connection refused` は社内ネットワークが番号ごとに止めている典型。ネットワークの
担当者に、この PC からの **外向き TCP 3307 番**（宛先は Cloud SQL の IP）を
許可してもらうのが本筋。Cloud SQL を社外から使うときの標準的な要件なので、
依頼としては通りやすい。

### 443 番だけで写す（SYNC_MODE=export）

3307 番がどうしても通らないときの経路。Cloud SQL に書き出させて Cloud Storage に置き、
そこから落とす。通信はすべて 443 番なので、番号で止められている環境でも動く。

準備は一度だけ。必要な値は次のコマンドが出す（インスタンスのサービスアカウントを含む）。

```powershell
docker compose run --rm ops export-info
```

1. Cloud Storage でバケットを 1 つ作る。場所はインスタンスと同じ `asia-northeast1`、
   「公開アクセスの防止」を有効、均一なアクセス制御。ライフサイクルで 1 日後に削除にしておく。
2. そのバケットに、`export-info` が示したサービスアカウントを
   「Storage オブジェクト管理者」で追加する。書き出すのは自分ではなくインスタンスなので、
   この付与がないと書き出しが失敗する。
3. `.env` を 2 行変える。
   ```
   SYNC_MODE=export
   EXPORT_BUCKET=<作ったバケット名>
   ```
4. あとは同じ。`docker compose run --rm ops sync`

**この方式の中身**

- 書き出すのは v3 の表だけ（対象は `001_schema.sql` と `004_amend.sql` の
  `CREATE TABLE` から作る。表が増えても直す場所は増えない）。
- 表だけの書き出しには関数とビューが入らないので、手元の定義から作り直す。
  トリガーは表と一緒に来るので、関数だけを先に作る。
- 落とし終わったらバケットのファイルは消す。置きっぱなしにしない。
- 書き出しはインスタンス側で走るので、`sync` は待つ（最大 30 分）。
  データ量が増えると待ち時間も増える。

**注意**

- 書き出しの間、本番のインスタンスに負荷がかかる。夜間に回すこと。
- バケットには一時的とはいえ本番データが載る。公開設定にしないこと。

### Proxy を PC 側で動かす

コンテナからは 3307 番が通らないのに、Windows から直接なら通ることがある
（コンテナの通信は Docker の経路を通るので、社内の機器の扱いが変わる）。
まず PC から確かめる。

```powershell
Test-NetConnection 34.146.158.194 -Port 3307
```

`TcpTestSucceeded : True` なら、Proxy を PC 側で動かして、コンテナはそれを使う。

1. Cloud SQL Auth Proxy を落として置く（Windows 版の実行ファイル 1 つ。gcloud は要らない）
   ```powershell
   Invoke-WebRequest -Uri https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.15.0/cloud-sql-proxy.x64.exe -OutFile cloud-sql-proxy.exe
   ```
2. `.env` に次の 1 行を足す
   ```
   SYNC_DB_HOST=host.docker.internal
   ```
3. 同期のたびに、まず Proxy を上げてから `ops sync` を走らせる
   ```powershell
   Start-Process -WindowStyle Hidden .\cloud-sql-proxy.exe `
     "--credentials-file=keys\adc.json","--quota-project=legalbridge-488506","--address=0.0.0.0","--port=5433","legalbridge-488506:asia-northeast1:legalbridge-db"
   docker compose run --rm ops sync
   Get-Process cloud-sql-proxy | Stop-Process
   ```

`--address=0.0.0.0` はコンテナから届かせるために要る。この PC が社内ネットワークに
直接いる場合、5433 番が同じネットワークの他の PC からも見えることになるので、
Windows のファイアウォールで 5433 番を塞いでおくこと（Docker からの接続は影響を受けない）。

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
