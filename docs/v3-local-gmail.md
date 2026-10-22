# 予備系（ローカル版）からメール（Gmail）を送る・Drive に保存する・CloudSign で送る・Slack で送る

本番が止まっている間、予備系で決定した文書を予備系から相手へ送るための設定。
既定はメールを止めている（`GMAIL_MODE=off`）。使うときだけ開ける。

送った記録も予備系の DB に残るので、**予備系で書く記録（`ops backup-begin`）を始めてから**送ること。
復旧後に `ops backup-export` で本番へ持ち帰ると、本番にも「送った」記録が入る
（`docs/v3-backup-merge.md`）。記録を始めずに送ると、本番には送った跡が残らない。

## しくみ

本番の V3 と同じく、Workspace のドメイン全体委任で送信元（`GMAIL_SENDER`）の代理として送る。
署名に使うサービスアカウント（`GMAIL_DELEGATION_SA`）も本番と同じものを使う。

本番（Cloud Run）はそのサービスアカウントとして動くので鍵が要らない。予備系の PC は GCP の外なので、
**人のログイン（`keys/adc.json`）でそのサービスアカウントに署名を頼む**。組織ポリシーで
サービスアカウントの鍵が作れなくても使える。

要るもの:

| 何 | どこで | 一度だけ |
|---|---|---|
| 本番と同じ送信元・署名用 SA の値 | Cloud Shell で読む（下の 1） | ○ |
| ログインする人に、署名用 SA の「サービス アカウント トークン作成者」 | Cloud Console の IAM（下の 2） | ○ |
| 人のログイン `keys/adc.json` | 予備系の PC（同期で使っているものと同じ） | ○（期限が切れたら取り直す） |

ドメイン全体委任は本番の設定をそのまま使うので、Workspace 側の作業は要らない。

## 1. 本番の値を読む（Cloud Shell）

```bash
gcloud run services describe legalbridge-v3 --region=asia-northeast1 \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E 'GMAIL_SENDER|GMAIL_DELEGATION_SA'
```

`GMAIL_SENDER`（送信元のアドレス）と `GMAIL_DELEGATION_SA`（`…@…iam.gserviceaccount.com` または
`…-compute@developer.gserviceaccount.com`）を控える。`GMAIL_DELEGATION_SA` が出なければ、
本番は実行中の SA で署名している。その SA は次で分かる:

```bash
gcloud run services describe legalbridge-v3 --region=asia-northeast1 \
  --format='value(spec.template.spec.serviceAccountName)'
```

## 2. ログインする人に署名の権限を付ける（Cloud Console・一度だけ）

IAM と管理 → サービス アカウント → 1 で控えた SA → 「権限」→「アクセス権を付与」で、
予備系の PC でログインする人（自分の Google アカウント）に
**サービス アカウント トークン作成者（roles/iam.serviceAccountTokenCreator）** を付ける。

Cloud Shell なら:

```bash
gcloud iam service-accounts add-iam-policy-binding <GMAIL_DELEGATION_SA> \
  --member="user:<ログインする人のアドレス>" --role="roles/iam.serviceAccountTokenCreator"
```

この権限は「その SA として署名できる」強いものなので、付ける人を絞る。

## 3. 予備系の PC で設定する（PowerShell、infra\local で）

1. 人のログインが無ければ取る（同期で使っていればそのままでよい）:
   ```powershell
   docker compose run --rm login
   ```
   `keys\adc.json` ができる。

2. `.env` に足す（`.env.example` の末尾にひな形がある）。まずは **dry_run**（送らずに中身だけ見る）で:
   ```
   GMAIL_MODE=dry_run
   GMAIL_SENDER=<1 で控えた送信元>
   GMAIL_DELEGATION_SA=<1 で控えた SA>
   GMAIL_ADC_PATH=/keys/adc.json
   DISPATCH_ALLOWLIST=<自分のアドレス>
   READ_ONLY=false
   ```
   `READ_ONLY=true` のままだとメールは送られない（読み取り専用の予備系からは送らない）。

3. app を上げ直す:
   ```powershell
   docker compose up -d app
   ```

## 4. 試してから開ける

1. **dry_run** のまま、文書の送付画面で送る操作をする。「検証モードのため送信しません」と出て、
   宛先・件名・本文・添付が見えれば設定は読めている。
2. `.env` を `GMAIL_MODE=live` にして `docker compose up -d app`。`DISPATCH_ALLOWLIST` に自分の
   アドレスだけを入れたまま、自分宛てに 1 通送る。届くこと、送信元が本番と同じこと、PDF が付いていることを確かめる。
3. 問題が無ければ宛先の制限を外す。運用 › 設定 › 「送る宛先の制限」で「制限しない」を選んで保存する
   （保存した瞬間から効く。app の上げ直しは要らない）。`.env` の `DISPATCH_ALLOWLIST=` を空にして
   `docker compose up -d app` でも同じ。設定の画面は .env より優先する（「.env のとおり」を選ぶと .env に戻る）。

## 終わったら

本番が戻ったら、予備系のメールを止める:

```
GMAIL_MODE=off
READ_ONLY=true
```

```powershell
docker compose up -d app
```

そのあと `docs/v3-backup-merge.md` の手順で本番へ持ち帰る。

## Drive へ保存する（任意）

既定では、予備系で作った PDF などは手元の `infra\local\data\files` に置かれ、本番へ持ち帰るときに
本文から作り直す。予備系からも本番と同じ Drive のフォルダへ保存したいときは、次を足す。
**本番が Drive に使っているサービスアカウントになりすまして**保存するので、フォルダ・共有・
ファイルの持ち主は本番と同じになる。

1. 本番の値を読む（Cloud Shell）:
   ```bash
   gcloud run services describe legalbridge-v3 --region=asia-northeast1 \
     --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' \
     | grep -E 'GOOGLE_DRIVE_FOLDER_ID|DRIVE_ENVIRONMENT_TAG|DRIVE_MATTER_PARENT_FOLDER_ID|GOOGLE_SERVICE_ACCOUNT_KEY_PATH'
   gcloud run services describe legalbridge-v3 --region=asia-northeast1 \
     --format='value(spec.template.spec.serviceAccountName)'
   ```
   `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` が出なければ、本番は実行中の SA（2 行目）で Drive を使っている。
   それを `DRIVE_IMPERSONATE_SA` にする。出た場合は、その鍵の SA（鍵の `client_email`）を使う。
2. その SA に、ログインする人の Token Creator を付ける（メールと同じ SA なら 2 で付け済み）。
3. `.env` に足して `docker compose up -d app`:
   ```
   DRIVE_STORAGE=drive
   GOOGLE_DRIVE_FOLDER_ID=<本番の値>
   DRIVE_ENVIRONMENT_TAG=<本番の値>
   DRIVE_MATTER_PARENT_FOLDER_ID=<本番の値。無ければ空>
   DRIVE_IMPERSONATE_SA=<1 の SA>
   GMAIL_ADC_PATH=/keys/adc.json
   ```
   `GMAIL_ADC_PATH`（人のログイン）はメールを開けないときも要る。
4. 決定済みの文書で「Drive に保存」を押し、本番の Drive のフォルダにファイルができること、
   画面のリンクが `https://drive.google.com/…` になることを確かめる。

Drive に保存した文書は、本番へ持ち帰ったあともそのリンクのまま使える（ローカルにしか無い
`/local-files/` のリンクだけが持ち帰りで外される）。戻すときは `DRIVE_STORAGE=local`。

## CloudSign で送る（任意）

既定では予備系から CloudSign へは送らない（`CLOUDSIGN_MODE=off`）。そのときは CloudSign の画面から直接
送り、文書の「CloudSign の状態を記録」で送った・締結したを手で入れる。予備系から本番と同じ CloudSign の
アカウントへ署名依頼を作りたいときは、次を足す。

CloudSign は client_id だけでつながる（人のログイン `keys/adc.json` は要らない）。

1. 本番の client_id を読む（Cloud Shell）:
   ```bash
   gcloud secrets versions access latest --secret=cloudsign-client-id --project legalbridge-488506
   ```
   これは CloudSign のアカウントの鍵なので、`.env` 以外（チャット・メール・リポジトリ）に貼らない。

2. `.env` に足す（`.env.example` の末尾にひな形がある）。まずは **dry_run** で:
   ```
   CLOUDSIGN_MODE=dry_run
   CLOUDSIGN_CLIENT_ID=<1 の値>
   DISPATCH_ALLOWLIST=<自分のアドレス>
   READ_ONLY=false
   ```
   `CLOUDSIGN_AUTO_SEND` は既定（false）のままにする。CloudSign に下書きができるだけで、相手には
   届かない。中身を CloudSign の画面で確かめてから、そこで送信する。

3. `docker compose up -d app` → 署名依頼の操作で「検証モードのため送信しません」と宛先・書類が出ること。

4. `CLOUDSIGN_MODE=live` にして上げ直し、自分を署名者にした 1 件で CloudSign に下書きができることを確かめる
   （確かめたら CloudSign の画面で消す）。問題が無ければ `DISPATCH_ALLOWLIST=` を空にする。

**気をつけること**

- **本番と同じアカウントを使う。** 本番と予備系の両方から同じ文書を送ると、二重に依頼が出る。
  予備系から送るのは本番が止まっている間だけ。メールと同じく `ops backup-begin` のあとで送る
  （送った記録が本番へ持ち帰られる）。
- **締結の知らせ（webhook）は予備系に届かない。** CloudSign は知らせを、アカウントに登録した URL
  （本番）へ送る。本番が止まっている間の知らせは失われる。次のどちらかで補う。
  - **手で記録する（勧める）**：相手が締結したら、文書の「CloudSign の状態を記録」で「締結した」と締結日を入れる。
    本番が戻ってから、止まっていた間に締結したものを CloudSign の画面で見て記録してもよい。
  - **トンネルで受ける**：`docker compose --profile tunnel up -d` で外からの口を開け、`.env` に
    `WEBHOOK_TOKEN=<長い乱数>` を足して上げ直す。CloudSign の設定で webhook の URL を一時的に
    `https://<トンネルのホスト>/internal/webhooks/cloudsign?key=<WEBHOOK_TOKEN>` に替える
    （`/internal/` は人のログインの外で、合言葉で守る）。Cloudflare Access を掛けているなら、
    Access 側でも `/internal/webhooks/*` をログインなし（Bypass）にする。
    **本番が戻ったら、webhook の URL を必ず本番に戻す。**
- 終わったら `CLOUDSIGN_MODE=off`（`WEBHOOK_TOKEN` も空に）にして `docker compose up -d app`。

## Slack で送る（任意）

既定では予備系から Slack へは送らない（`SLACK_MODE=off`）。依頼者への DM・案件のスレッド・工程の通知・
納期アラートを予備系から送りたいときは、次を足す。Slack は Bot トークンだけでつながる（人のログインは要らない）。

1. 本番の Bot トークンを読む（Cloud Shell）:
   ```bash
   gcloud secrets versions access latest --secret=legalbridge-v3-slack-bot-token --project legalbridge-488506
   ```
   `xoxb-` で始まる。Slack のワークスペースの鍵なので、`.env` 以外（チャット・メール・リポジトリ）に貼らない。

2. `.env` に足す（`.env.example` の末尾にひな形がある）。まずは **dry_run** で:
   ```
   SLACK_MODE=dry_run
   SLACK_BOT_TOKEN=<1 の値>
   READ_ONLY=false
   ```

3. `docker compose up -d app` → 運用 › 外部連携 の「送信の段階」で slack が `dry_run`・接続情報が「設定済み」になること。
   送る操作で「検証モードのため送信しません」と宛先・中身が出ること。

4. `SLACK_MODE=live` にして `docker compose up -d app`。

**気をつけること**

- **宛先の許可リストは Slack にも効く。** Slack の宛先はメールアドレスではなくユーザー ID・チャンネル ID なので、
  許可リスト（運用 › 設定 › 送る宛先の制限、または `DISPATCH_ALLOWLIST`）にメールだけを入れていると
  Slack は全部止まる。Slack を開けるときは許可リストを空（制限しない）にするか、送ってよい ID も足す。
- **本番と同じ Bot を使う。** 本番と予備系の両方で動かすと、工程の通知や納期アラートが二重に届く。
  予備系から送るのは本番が止まっている間だけ。`ops backup-begin` のあとで送る。
- **`/法務依頼`・`/法務検索` は予備系に届かない。** Slack はアプリに登録した URL（本番の口）へ送る。
  予備系で受けるには、トンネル（`docker compose --profile tunnel up -d`）を開け、`.env` に
  `SLACK_SIGNING_SECRET`（Secret Manager の `legalbridge-v3-slack-signing-secret`）を足し、
  Slack アプリの Request URL を一時的にトンネルのホストへ替える。**本番が戻ったら必ず戻す。**
- 終わったら `SLACK_MODE=off`（`SLACK_BOT_TOKEN` も空に）にして `docker compose up -d app`。

## うまくいかないとき

| 画面・ログに出る言葉 | 見るところ |
|---|---|
| 接続情報が設定されていません | `GMAIL_SENDER` が空。`.env` と `docker compose up -d app` |
| 読み取り専用で動作しています | `READ_ONLY=false` にしていない |
| 検証中の宛先許可リストに入っていません | 許可リスト（運用 › 設定 › 送る宛先の制限、または `DISPATCH_ALLOWLIST`）に無い宛先（cc・bcc・署名者も含む）。複数文書を 1 通で送るときは cc に依頼者と「いつも cc で入れる宛先」が入る |
| GMAIL_DELEGATION_SA（署名に使う SA）が要ります | `.env` の `GMAIL_DELEGATION_SA` が空 |
| ログインの認証情報…からトークンを取れませんでした | `keys\adc.json` が無いか期限切れ。`docker compose run --rm login` で取り直す |
| Drive の保存で「権限がありません（403）」 | なりすました SA が本番のフォルダに入れない。`DRIVE_IMPERSONATE_SA` が本番の Drive の SA と同じか |
| `unable to impersonate`（403） | ログインした人に、`DRIVE_IMPERSONATE_SA` の Token Creator が付いていない |
| `EACCES: permission denied, open '/keys/adc.json'` | app が認証情報を読めない（古い login で作ったファイル）。`docker compose run --rm --entrypoint chown login 1000:1000 /keys/adc.json` |
| `invalid_grant`・`reauth related error (invalid_rapt)`・Google のログインが切れています | 組織の再認証ポリシーでログインが切れた。運用 › 外部連携 の「Google にログインし直す」（下の「Google にログイン」）。gcloud なら下の「ログインし直す」。app の上げ直しは要らない |
| CloudSign のトークンを取得できませんでした・CloudSign（401・403） | `CLOUDSIGN_CLIENT_ID` が違う（本番の `cloudsign-client-id` と同じか） |
| Slack の送信で「接続情報が設定されていません」 | `SLACK_BOT_TOKEN` が空。`.env` と `docker compose up -d app` |
| Slack の送信で `invalid_auth`・`not_in_channel` | トークンが違う（本番の `legalbridge-v3-slack-bot-token` と同じか）／ Bot がそのチャンネルに招かれていない |
| CloudSign には送信する書類が必要です | 文書の PDF ができていない。先に決定して PDF を作る |
| JWT に署名できませんでした（403…） | 2 の権限がログインした人に付いていない（付けてから数分かかることがある） |
| 代理トークンを得られませんでした（unauthorized_client） | 署名用 SA が本番と違う（ドメイン全体委任が付いていない SA）。1 の値を見直す |

アプリのログは `docker compose logs -f app`。

### Google にログイン（画面から。おすすめ）

gcloud と PowerShell を使わずに、運用 › 外部連携 の「Google にログイン」で人のログインを取れる。
一度設定しておけば、切れたときもボタン 1 つで取り直せる（`src/server/integrations/google-login.ts`）。

準備（GCP コンソール、一度だけ）:

1. API とサービス › 認証情報 › 認証情報を作成 › OAuth クライアント ID。種類は **ウェブ アプリケーション**。
2. 承認済みのリダイレクト URI に `http://localhost:8080/auth/google/callback` を登録する。
   社外から（Cloudflare Tunnel で）使うなら `https://<その URL>/auth/google/callback` も登録する。
3. できたクライアント ID とシークレットを `infra\local\.env` に入れて `docker compose up -d app`:
   ```
   GOOGLE_LOGIN_CLIENT_ID=<クライアント ID>
   GOOGLE_LOGIN_CLIENT_SECRET=<シークレット>
   ```
   （OAuth 同意画面が「テスト中」なら、ログインする人をテストユーザーに足す。）

使い方:

- 運用 › 外部連携 の「Google のログイン（予備系）」で「Google にログイン」。ブラウザで許可すると画面に戻る。
- 「確かめる」でトークンを取り直して生きているかを見る。切れていれば「ログインし直す」。
- ログインは `data/google-login.json`（authorized_user の JSON。gcloud の ADC と同じ形）に置かれ、
  メールの署名と Drive のなりすましの両方で使われる。無ければ従来の `keys/adc.json` に戻る。
- 送るときに「Google のログインが切れています」と出たら、同じ場所で「ログインし直す」。

組織の再認証ポリシーで切れる間隔は変わらない（切れたときの手間が減るだけ）。
間隔そのものは管理コンソール › セキュリティ › Google Cloud セッション管理で、予備系を使う人の組織部門だけ長くできる。

### ログインし直す（gcloud を使うとき）

組織の再認証ポリシーで、人のログインは一定時間（組織の設定。たとえば 1 日）で切れる。
切れると `invalid_rapt` で送れなくなるので、予備系で送る日は最初にログインし直しておく（同期も同じ認証情報を使う）。

PC の gcloud が Google につながる環境なら:

```powershell
gcloud auth application-default login --project legalbridge-488506
Copy-Item "$env:APPDATA\gcloud\application_default_credentials.json" keys\adc.json -Force
docker compose run --rm --entrypoint chown login 1000:1000 /keys/adc.json
```

PC の gcloud が `Failed to establish a new connection`（社内の通信の制限）で落ちるなら、コンテナでログインする:

1. PowerShell ①（infra\local）で `docker compose run --rm login`。`Enter the output of the above command:` で待つ
2. ① に出た `gcloud auth application-default login --remote-bootstrap="…"` を、**別の PowerShell ②** に丸ごと貼って実行（`y` → ブラウザで許可）
3. ② の最後に出る `https://localhost:8085/?state=…&code=…` を ① に貼って Enter
4. 「認証情報を keys/adc.json に置きました」と出れば完了。`(Get-Item keys\adc.json).LastWriteTime` が今になっていること
