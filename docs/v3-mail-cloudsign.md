# V3 のメール送信と CloudSign の接続

文書の「送る」（内容確認のメール → 相手の確認 → CloudSign で署名依頼 → 締結）を本番で動かす手順。
V1（`legalbridge-document-worker`）で使っていた送信元・委任・CloudSign の設定をそのまま引き継ぐ。

## メールの文面

運用 → 設定 → 「メールの文面」で 5 通りの件名・本文と共通の署名を変える（`settings.mail_templates`）。

| 文面 | 宛先（送る画面で組む下書き） |
|---|---|
| 担当者への確認 | 案件の依頼者（事業部の担当者）。法務の担当を cc |
| 取引先への内容確認 | 取引先の主担当（無ければ連絡先の全員・取引先のメール）。依頼者を cc |
| 検収書の送付 | 取引先の請求先（無ければ主担当）。依頼者を cc |
| 利用許諾計算書の送付 | 同上 |
| その他の書類の送付 | 同上 |

送る画面では「担当者への確認／取引先への内容確認／取引先へ送付」を選ぶと、宛先・件名・本文が入る。
送付は文書の種類で検収書・利用許諾計算書・その他の文面を使い分ける。既定の文面は V1 のもの。

## Gmail（送信元の代理で送る）

Gmail API はサービスアカウント自身としては送れない。Workspace のドメイン全体委任で
「この SA は送信元（例：legal@…）として gmail.send してよい」を許し、V3 は鍵なしで
（IAM Credentials の signJwt → JWT-bearer）トークンを得る（`integrations/gmail-auth.ts`）。

V1 の worker で委任を済ませた SA をそのまま使えば、Workspace の設定をやり直さずに済む。

```bash
PROJECT=legalbridge-488506; REGION=asia-northeast1
V1_SA=$(gcloud run services describe legalbridge-document-worker --region=$REGION --format='value(spec.template.spec.serviceAccountName)')
V3_SA=legalbridge-v3@${PROJECT}.iam.gserviceaccount.com
echo "V1 の SA: $V1_SA"   # 空なら Compute の既定の SA（<番号>-compute@developer.gserviceaccount.com）

# V3 が V1 の SA として JWT に署名できるようにする
gcloud iam service-accounts add-iam-policy-binding "$V1_SA" \
  --member="serviceAccount:${V3_SA}" --role=roles/iam.serviceAccountTokenCreator
gcloud services enable iamcredentials.googleapis.com
```

送信元のアドレスは V1 の設定（`public.app_settings` の `EMAIL_SENDER`、無ければ worker の環境変数）と同じにする。

トリガーの置換変数（`gcloud beta builds triggers export/import`。`docs/v3-gateway.md` 参照）:

| 置換変数 | 値 |
|---|---|
| `_GMAIL_SENDER` | 送信元のアドレス |
| `_GMAIL_DELEGATION_SA` | `$V1_SA` |
| `_GMAIL_MODE` | 最初は `dry_run`（送らずに宛先と本文を確かめる）→ 確かめたら `live` |

> 受信メールの取り込み（`mail-intake`）は gmail.readonly の委任が要る。V1 の SA が gmail.send しか
> 委任されていなければ、Workspace 管理画面で readonly を足すまで取り込みは動かない（送信は動く）。

## CloudSign

### 1. API のクライアント ID を Secret Manager に入れる

V1 の値（`public.app_settings` の `CLOUDSIGN_CLIENT_ID`）を、画面に出さずにそのまま入れる。

```bash
psql -tA -c "SELECT value FROM public.app_settings WHERE key = 'CLOUDSIGN_CLIENT_ID'" \
  | tr -d '"\n' | gcloud secrets create legalbridge-v3-cloudsign-client-id --data-file=- --replication-policy=automatic
gcloud secrets add-iam-policy-binding legalbridge-v3-cloudsign-client-id \
  --member="serviceAccount:${V3_SA}" --role=roles/secretmanager.secretAccessor
gcloud secrets versions access latest --secret=legalbridge-v3-cloudsign-client-id | wc -c   # 0 でなければ入っている
```

行が無ければ worker の環境変数にある：
`gcloud run services describe legalbridge-document-worker --region=$REGION --format=yaml | grep -A2 CLOUDSIGN_CLIENT_ID`

トリガーの置換変数：`_CLOUDSIGN_SECRET=legalbridge-v3-cloudsign-client-id`、`_CLOUDSIGN_MODE=live`。

署名依頼は**下書きで止める**（V1 と同じ）。CloudSign の画面で中身を見て送る。
送られると webhook（下）で V3 の文書が「送信済」になる。

### 2. 口（gateway）を更新する

CloudSign の webhook の受け口（`POST /internal/webhooks/cloudsign`）を足したので、口をデプロイし直す。

```bash
cd ~/lb_v2_main && git fetch origin main && git checkout -q origin/main -- infra/v3
gcloud run deploy legalbridge-v3-gateway --source=infra/v3/gateway --region=$REGION --format=none
```

（環境変数・サービスアカウントは前の設定が引き継がれる。）

### 3. CloudSign の webhook の宛先を V3 に替える

CloudSign は見出しを足せないので、共有シークレットは URL の `?key=` で渡す。

```bash
GW_URL=https://legalbridge-v3-gateway-lkyrgniooa-an.a.run.app
echo "${GW_URL}/internal/webhooks/cloudsign?key=$(gcloud secrets versions access latest --secret=legalbridge-v3-webhook-token)" > ~/cloudsign-webhook-url.txt
chmod 600 ~/cloudsign-webhook-url.txt   # チャットなどに貼らない
```

CloudSign の管理画面 → 設定 → Web API → Webhook の URL に、ファイルの中身を入れる
（それまでは V1 の worker 宛て。worker は内部専用にしたので、もう届いていない）。

- webhook トークン（`legalbridge-v3-webhook-token`）を入れ替えたら、この URL も入れ替える。
- 状態の対応（V1 が本番で確かめた値）：1 = 先方確認中（送信済）、2 = 締結済、3 = 取消・却下。
- V1 から CloudSign に出した封筒の結果は V3 の文書に繋がらない（V3 は自分の送信記録で突き合わせる）。
  残っていれば、文書の「送る」→ CloudSign の状態を手で記録する。
