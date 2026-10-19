# 予備系（ローカル版）からメール（Gmail）を送る

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
3. 問題が無ければ `DISPATCH_ALLOWLIST=` を空にして `docker compose up -d app`（宛先の制限を外す）。

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

## うまくいかないとき

| 画面・ログに出る言葉 | 見るところ |
|---|---|
| 接続情報が設定されていません | `GMAIL_SENDER` が空。`.env` と `docker compose up -d app` |
| 読み取り専用で動作しています | `READ_ONLY=false` にしていない |
| 検証中の宛先許可リストに入っていません | `DISPATCH_ALLOWLIST` に無い宛先（cc・bcc も含む） |
| GMAIL_DELEGATION_SA（署名に使う SA）が要ります | `.env` の `GMAIL_DELEGATION_SA` が空 |
| ログインの認証情報…からトークンを取れませんでした | `keys\adc.json` が無いか期限切れ。`docker compose run --rm login` で取り直す |
| `EACCES: permission denied, open '/keys/adc.json'` | app が認証情報を読めない（古い login で作ったファイル）。`docker compose run --rm --entrypoint chown login 1000:1000 /keys/adc.json` |
| `invalid_grant`・`reauth related error (invalid_rapt)` | 組織の再認証ポリシーでログインが切れた。ログインし直して写す（下の「ログインし直す」）。app の上げ直しは要らない |
| JWT に署名できませんでした（403…） | 2 の権限がログインした人に付いていない（付けてから数分かかることがある） |
| 代理トークンを得られませんでした（unauthorized_client） | 署名用 SA が本番と違う（ドメイン全体委任が付いていない SA）。1 の値を見直す |

アプリのログは `docker compose logs -f app`。

### ログインし直す

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
