# V3 の外向きの口（legalbridge-v3-gateway）と資料アップロードの設定

## なぜ別のサービスにするか

V3 本体（`legalbridge-v3`）は `--no-allow-unauthenticated`・`AUTH_MODE=disabled` で動いている。
社内の人は `gcloud run services proxy` で開き、守りは Cloud Run の呼び出し権限だけ。
V3 本体を外に開くと、画面も API も全部開いてしまう。

一方で、次の 2 つは外から届く必要がある。

- Slack（`/法務依頼`・`/法務検索` とモーダルの送信）
- 依頼者の資料アップロード（依頼者は V3 に入れない）

そこで、**決まった 4 つのパスだけを V3 本体へ中継する小さな公開サービス**を別に置く
（`infra/v3/gateway/server.mjs`。依存パッケージなし）。

| 通すもの | 守り |
|---|---|
| `POST /internal/slack/commands` | Slack の署名（V3 本体で検証。署名シークレットが無ければ常に 401） |
| `POST /internal/slack/interactions` | 同上 |
| `GET /internal/upload` | 署名付きリンク（HMAC・30 日） |
| `POST /internal/upload/file` | 同上。1 ファイル 30MB まで |

これ以外のパスは 404（`..` を使った抜け道も含む）。V3 本体へは口のサービスアカウントの
ID トークンを付けて呼ぶので、V3 本体は非公開のまま。社内の人の使い方は変わらない。

## 手順（Cloud Shell）

```bash
cd ~/lb_v2_main && git fetch origin main && git checkout -q origin/main -- infra/v3 docs
PROJECT=legalbridge-488506; REGION=asia-northeast1
gcloud config set project $PROJECT
V3_URL=$(gcloud run services describe legalbridge-v3 --region=$REGION --format='value(status.url)'); echo $V3_URL
```

### 1. 口のサービスアカウント（V3 本体を呼べる権限だけ）

```bash
gcloud iam service-accounts create legalbridge-v3-gateway --display-name="LegalBridge V3 gateway"
GW_SA=legalbridge-v3-gateway@${PROJECT}.iam.gserviceaccount.com
gcloud run services add-iam-policy-binding legalbridge-v3 --region=$REGION \
  --member="serviceAccount:${GW_SA}" --role=roles/run.invoker
```

### 2. 口をデプロイする

```bash
gcloud run deploy legalbridge-v3-gateway \
  --source=infra/v3/gateway --region=$REGION \
  --allow-unauthenticated --service-account="${GW_SA}" \
  --set-env-vars="UPSTREAM=${V3_URL}" \
  --memory=256Mi --max-instances=3
GW_URL=$(gcloud run services describe legalbridge-v3-gateway --region=$REGION --format='value(status.url)'); echo $GW_URL
```

初回は「Artifact Registry のリポジトリを作るか」を聞かれるので `Y`。

確かめる（`ok` と `404` が出ればよい）:

```bash
curl -s ${GW_URL}/healthz; echo
curl -s -o /dev/null -w "%{http_code}\n" ${GW_URL}/api/v3/ringi
```

> `--allow-unauthenticated` が組織のポリシー（許可するドメインの制限）で断られたら、
> エラーをそのまま法務システム担当へ。口だけを例外にするか、ロードバランサ経由に切り替える。

### 3. 資料アップロードの鍵と URL を V3 本体に入れる

```bash
create_secret() {  # $1=名前 $2=値
  printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic 2>/dev/null \
  || printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=-
}
create_secret legalbridge-v3-upload-signing-secret "$(openssl rand -hex 32)"
gcloud secrets add-iam-policy-binding legalbridge-v3-upload-signing-secret \
  --member="serviceAccount:legalbridge-v3@${PROJECT}.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

デプロイは main への push で自動（Cloud Build のトリガー）なので、トリガーの置換変数に足す。
`cloudbuild.yaml` は `--set-env-vars` で毎回入れ直すので、`gcloud run services update` で
直接入れても次のデプロイで消える。必ずトリガーに入れる。

```bash
gcloud builds triggers list --format="table(name,filename,triggerTemplate.branchName,github.push.branch)"
TRIGGER=<上の一覧で filename が infra/v3/cloudbuild.yaml のもの>
gcloud builds triggers update github "$TRIGGER" \
  --update-substitutions="_PUBLIC_BASE_URL=${GW_URL},_UPLOAD_SECRET=legalbridge-v3-upload-signing-secret"
gcloud builds triggers run "$TRIGGER" --branch=main     # すぐ反映させる
```

> トリガーが GitHub 連携の第 2 世代（リポジトリ接続）なら `update github` が通らないことがある。
> そのときはコンソールの Cloud Build → トリガー → 編集 → 置換変数に同じ 2 つを足す。

反映を確かめる（ビルドが終わってから）:

```bash
gcloud run services describe legalbridge-v3 --region=$REGION \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E "PUBLIC_BASE_URL|UPLOAD_SIGNING_SECRET"
```

画面の受付箱で依頼を1つ開き、「依頼者の資料」→「アップロード用リンクを作る」。
`https://legalbridge-v3-gateway-…/internal/upload?t=…` のリンクが出れば完了。
スマートフォン（社外の回線）でそのリンクを開き、小さなファイルを上げて、受付箱に出ることを確かめる。

### 4. Slack を V3 に向けるとき（あとで）

Slack の切り替えは V1 の停止手順（`docs/v1-shutdown-plan.md` §2）の順番で行う。
そのときの Request URL は口の URL を使う:

| 設定 | 値 |
|---|---|
| Slash Command `/法務依頼`・`/法務検索` | `${GW_URL}/internal/slack/commands` |
| Interactivity の Request URL | `${GW_URL}/internal/slack/interactions` |

## 口を止める・戻す

- 止める：`gcloud run services delete legalbridge-v3-gateway --region=$REGION`
  （V3 本体には影響しない。Slack とアップロードのリンクだけが届かなくなる）
- 口の権限を外す：`gcloud run services remove-iam-policy-binding legalbridge-v3 --region=$REGION --member="serviceAccount:${GW_SA}" --role=roles/run.invoker`
