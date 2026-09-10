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

## コードを更新したとき

列が増える変更を取り込んだら、手元の DB も合わせる。入っているデータはそのまま。

```powershell
git pull
docker compose up -d --build app
docker compose run --rm ops upgrade
```

`upgrade` を忘れると、アプリが新しい列を読もうとして画面に
「サーバ内部でエラーが発生しました」と出る。何度流しても同じ結果になる。

## Studio から本番の中身を入れる

自動同期が使えない環境で、ローカル版に本番のデータを入れる手順。
Cloud SQL Studio だけで完結する。読み取りしかしないので本番は変わらない。

**1. 取り出す**

`infra/v3/094_export_rows.sql` を Studio に貼る。

- 「1.」を流すと行数とページ数が出る（1ページ 5000 行）
- 「2.」を流して結果を CSV で落とす。`OFFSET` の数字を 0 → 5000 → 10000 … と
  増やし、ページ数の分だけ繰り返す。ファイル名は何でもよく、順番も問わない

**2. 取り込む**

落とした CSV を `infra/local/dumps/rows/` に置いて、

```powershell
mkdir dumps\rows -Force
# 落としたファイルだけを名指しで移す。*.csv にすると関係ない CSV まで巻き込む。
Move-Item "$HOME\Downloads\studio_results_<日付>_<時刻>.csv" dumps\rows\
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
| v3 に無い表が入っています | CSV が別のスキーマのもの | 落とし直す |

**気をつけること**

- 1行が1件で、中身は JSON。NULL・日本語・配列・jsonb・改行も崩れない。
  記号（`<` や `&`）も含めて、取り出しと取り込みで一致することを確認済み。
- 取り込むと手元の v3 は入れ替わる。ローカルで作った下書きなどは消える。
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
Move-Item "$HOME\Downloads\studio_results_<日付>_<時刻>.csv" dumps\contacts\
docker compose run --rm ops import-contacts /dumps/contacts
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
