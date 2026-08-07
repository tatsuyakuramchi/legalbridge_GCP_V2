# Phase 5：外部連携の実地点火 — レディネス・レビュー

Gmail送受信 / CloudSign / Slack / Drive を1つずつ本番相当で点火するための、コネクタ別「実装状態・有効化手順・残ギャップ・検証」レビュー。コード監査に基づく（実トークンは未使用）。

## 0. 全体像と最優先ブロッカー

- **総元栓 `INTEGRATION_MODE`**：Gmail送信 / CloudSign依頼 / Slack配信 の**送信系ゲートは `INTEGRATION_MODE=live` を要求**する（各ハンドラ内 `*-dispatch-gate.ts` の `integration_local` ブロッカー）。従来 `cloudbuild-write-test.yaml` はこれを **`local` にハードコード**しており、各 `*_MODE=live`＋確認トークンを揃えても実送信は 409 で止まっていた（＝パリティ表「停止中」の正体）。
  - **本レビューで修正済**：`INTEGRATION_MODE` を substitution `_INTEGRATION_MODE`（既定 `local`）へ変更。`live` は `verify-write-test.sh` で **write-test サービス＋IAP/Cloud Run IAM 必須**にガード。既定 `local` は挙動不変（default検証パス）。
  - 読取系（Gmail受信・CloudSignステータスGET・Drive）は `INTEGRATION_MODE` 非依存。
- **capability と実送信の乖離**：`/api/v2/runtime` の `writeCapabilities` は scope/flag のみ反映するため、capability が「on」でも `INTEGRATION_MODE=local` の間は送信がブロックされる。`/api/v2/admin/diagnostics` は `externalWritesDisabled = (INTEGRATION_MODE==='local')` を表示する。

## 1. 推奨点火順序（低リスク→高リスク）

1. **Drive**（最も安全・実クライアント・V1実績）→ 2. **Gmail受信**（読取のみ）→ 3. **Slack**（配信・履歴/冪等が堅牢・要実xoxb）→ 4. **Gmail送信**（DWD必須・冪等は5-1で対応済）→ 5. **CloudSign**（**API契約はV1準拠で確定・要実client_id**／永続化・冪等は小項目）。

---

## 2. コネクタ別レディネス

### ① Drive保管（PDF）— ✅ ほぼそのまま点火可
- **状態**：`documents/drive-storage.ts` に実クライアント（`drive` スコープ・鍵ファイル/ADC・`appProperties` で document-id/環境タグ付け・`findByDocumentId` で重複回避）。想定APIでなく実Google Drive API。
- **点火手順**：共有ドライブフォルダID `GOOGLE_DRIVE_FOLDER_ID`、鍵（`_GWS_SA_KEY_SECRET`）**または**ランタイムSAを対象フォルダのメンバーに（ADC）、`DRIVE_STORAGE_ENABLED=true`・`CONFIRM_DRIVE_STORAGE=DRIVE_LEGALBRIDGE_VALIDATION_ONLY`・scope `drive`・AUTH iap/cloudrun-iam。`INTEGRATION_MODE` 不要。
- **ギャップ**：なし（write-safety診断が warning に落ちるのは想定内）。
- **検証**：`POST /api/v2/documents/:id/drive` → Driveにファイル生成・`legalbridgeDocumentId` appProperty 付与・再実行で重複しないこと。

### ② Gmail受信（契約PDF取込）— 🟡 読取点火可・ただし「取込→登録」の書込導線は未実装
- **状態**：`gmail-inbound-api-adapter.ts`（`gmail.readonly`＋DWD `subject=mailbox`）で `messages.list/get/attachments` を叩き、PDF添付メッセージのみ抽出。ルートは read（`GET /gmail-inbound/contracts`・`.../attachments/:id`）。
- **点火手順**：`gmail.readonly` のドメイン全体委任をSAに付与し対象メールボックスへ委任、`GMAIL_INBOUND_MAILBOX`、鍵secret、`GMAIL_INBOUND_MODE=live`・`CONFIRM_GMAIL_INBOUND=GMAIL_INBOUND_VALIDATION_ONLY`・scope `gmail-inbound`・AUTH。`INTEGRATION_MODE` 不要（読取）。
- **ギャップ**：(a) ~~取込→登録の書込導線が無い（閲覧+DLまで）~~ → **修正済（スライス5-2）**：隔離台帳 `lb_v2_inbound_contracts`（grant 020・append＋status）への取込登録導線を追加。`POST /gmail-inbound/messages/:m/attachments/:a/register` が添付を取得・PDF検証し台帳に1件記録（`message+attachment` 指紋で冪等・再登録は `intake="duplicate"`・200）。`GET /gmail-inbound/registered`（一覧・status絞込）と `POST /gmail-inbound/registered/:key/status`（captured→linked/dismissed）。有効化 `GMAIL_INBOUND_INTAKE_ENABLED=true`（既定OFF・write-test限定）。**本番 `documents` テーブルには触れない**（identity名前空間を汚さない）。(b) **Driveバイト保管は未対応**：受信PDFの実バイトをDriveへ格納する導線は identity方式（appProperties）決定後に別スライス。SA鍵マウントは共通ギャップ2で解消済。
- **検証**：`GET /gmail-inbound/contracts?q=` が対象箱のPDF添付課題を返すこと。

### ③ Slack配信 — 🟡 実xoxbトークン待ち（パイプラインは堅牢）
- **状態**：`slack-delivery-adapter.ts`（gate→履歴重複チェック→送信→受領検証→履歴追記）＋`slack-web-api-adapter.ts`（`xoxb-` 必須・`conversations.open`→`chat.postMessage`）。**冪等/履歴が堅牢**：`(issue_key, fingerprint)` の一意インデックス（grant 001）＋承認テーブル（grant 002）＋`ON CONFLICT DO NOTHING`。
- **点火手順**：実 **`xoxb-` bot token** を Secret Manager（`_SLACK_BOT_TOKEN_SECRET`）へ、V2デプロイSAに secretAccessor 付与。grant 001/002（履歴/承認・追記のみ）を適用。`SLACK_DELIVERY_MODE=live`＋`SLACK_DISPATCH_ENABLED=true`＋`CONFIRM_SLACK_DISPATCH=SLACK_DISPATCH_VALIDATION_ONLY`＋履歴/承認/承認書込を全て true＋`SLACK_DRY_RUN_USER_MAP`（`email=SlackID`・検証宛先限定）＋scope `slack,slack-dispatch(,slack-approvals)`＋AUTH＋**`INTEGRATION_MODE=live`**。
- **ギャップ**：候補フロー実送信の依頼者宛先解決。**コード側の潜在バグを修正（スライス5-3）**：`matters/repository.ts` の `optionalEmail` が正規表現リテラルを二重エスケープ（`\\s`/`\\.`）していたため、`matter_overview_v` が `requester_email`/`created_by`/`requester` を返しても**全メールを null 化**していた（＝宛先解決が常に失敗する隠れ原因）。単一エスケープへ修正＋回帰テスト。**残作業（DB側）**：`matter_overview_v` が上記いずれかの列で依頼者メールを実際に露出すること（露出後はコード側で解決可能）。当面は `POST /admin/slack-notifications/test-dispatch`（固定文＋指定userId）でトークン/経路を検証。
- **検証**：test-dispatch で1通到達 → 候補フローはDBビュー整備後。

### ④ Gmail送信（通知メール）— 🟡 DWD鍵が必須・冪等未実装
- **状態**：`gmail-api-adapter.ts`（`gmail.send`＋DWD `subject=GMAIL_SENDER`）で実送信。ルートは preview(admin/legal)・dispatch(admin)。
- **点火手順**：`gmail.send` のドメイン全体委任SAを `GMAIL_SENDER` 送信元へ、鍵secret、`GMAIL_DELIVERY_MODE=live`・`GMAIL_SENDER`・`CONFIRM_GMAIL_DISPATCH=GMAIL_DISPATCH_VALIDATION_ONLY`・scope `gmail`・AUTH・**`INTEGRATION_MODE=live`**。
- **ギャップ**：(a) ~~SA鍵がDriveブランチ従属~~ → **修正済**（鍵マウントを Drive/Gmail送信/Gmail受信 の共有条件へ切り出し）。(b) ~~冪等未実装~~ → **修正済（スライス5-1）**：送信履歴テーブル `lb_v2_gmail_send_history`（grant 019・append専用）＋dispatch の送信前照会で二重送信を防止。有効化は `GMAIL_SEND_HISTORY_ENABLED=true`（既定OFF・write-test限定・grant 019 適用が前提）。無効時は従来通り（後方互換）。
- **検証**：preview（MIME確認）→ dispatch 1通。二重送信ガードは運用対応。

### ⑤ CloudSign（署名依頼＋ステータス）— 🟡 API契約は確定（V1準拠）・残るは永続化/安全ガード
- **状態**：`cloudsign-api-adapter.ts` の実HTTPクライアントを **V1（LegalBridge_AI_GCP `cloudSignService.ts`）の実動実装に突合して確定（スライス5-6）**。
- **確定した実仕様（V1準拠・スライス5-6で反映）**：
  - **トークン交換**：`POST /token` に **`client_id` のみを form-urlencoded body** で送る（**client_secret も grant_type も不要**）。`expires_in` を尊重してキャッシュ（30秒前倒し失効）、**401 は1回だけ再取得**。→ スライス5-4 の「secret 必須」想定は**誤りと判明**し、`CLOUDSIGN_CLIENT_SECRET` フックは撤去。
  - **createDocument**：`POST /documents`（form-urlencoded・`title` のみ）。
  - **addFile**：`POST /documents/:id/files`（multipart・項目名 **`uploadfile`**）。
  - **addParticipant**：`POST /documents/:id/participants`（form-urlencoded・`email/name/organization`）。
  - **send**：`POST /documents/:id`（本文なし）／**getDocument**：`GET /documents/:id`（既に一致）。
  - base URL：`https://api.cloudsign.jp`（sandbox: `api-sandbox.cloudsign.jp`）。
- **小項目（スライス5-7で対応）**：
  - ~~送信冪等・`cloudSignDocumentId` 永続化~~ → **対応済**：`lb_v2_cloudsign_requests`（grant 022・append＋status）＋dispatch の送信前照会で二重依頼を防止（重複は `integrations.cloudsign="duplicate"`・200）。`cloudSignDocumentId` を永続化し、`GET /cloudsign/:id/status` 取得時に締結状況を反映。有効化 `CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`（既定OFF・write-test限定）。
  - ~~宛先allowlist~~ → **対応済**：`CLOUDSIGN_ALLOWED_RECIPIENTS`（V1準拠・設定時は全宛先が集合内であることを要求・許可外は422）。verify は **live 点火時に allowlist 必須**（検証中の誤送信防止）。
  - reportees（CC共有先）は V2 未対応（必要時に追加）。
- **点火手順**：実 `client_id`、base URL、`CLOUDSIGN_MODE=live`・`CONFIRM_CLOUDSIGN_DISPATCH`・scope `cloudsign`・AUTH・`INTEGRATION_MODE=live`。**認証方式は確定済み**のため、他の送信系コネクタと同じゲート運用で点火可能。

---

## 3. 共通ギャップ（点火前の整備推奨）

1. ~~`INTEGRATION_MODE=local` ハードコード~~ → **本レビューで修正**（`_INTEGRATION_MODE` 化・ガード付き）。
2. ~~SA鍵マウントがDriveブランチに従属~~ → **修正済**：鍵マウントを共有条件へ切り出し、`_DRIVE_STORAGE_ENABLED=true` **または** `_GMAIL_DELIVERY_MODE=live` **または** `_GMAIL_INBOUND_MODE=live` のいずれかで鍵secretがあれば `/secrets/gws-service-account.json` をマウントし `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` を設定する（Drive無しでもGmail送受信のDWDが機能）。Gmail送信は `GMAIL_SA_KEY_PATH` 未設定時に同パスへフォールバック。
3. **Gmail/CloudSign に送信履歴・冪等強制が無い**（キーは算出するが未使用）。
   - **Gmail は修正済（スライス5-1）**：append専用の送信履歴テーブル `lb_v2_gmail_send_history`（grant 019・SELECT/INSERT のみ・`idempotency_key` 一意）を追加し、dispatch が送信前に既送信を照会→重複なら実送信せず受領を返す（`integrations.gmail="duplicate"`・200）。有効化は `GMAIL_SEND_HISTORY_ENABLED=true`（既定OFF・write-test限定）。
   - **CloudSign は未対応**：認証未確定（下記④）のため live 化不可。認証突合後に同型（履歴テーブル＋冪等）を追加する。
4. ~~**CloudSign認証の実突合**（上記④）~~ → **解消（スライス5-6）**：V1 実動クライアントに突合し、`/token` は `client_id` のみ form-urlencoded（secret/grant_type 不要）、`uploadfile` multipart、form-urlencoded の document/participant と確定。5-4 の client_secret フックは誤想定として撤去。残るは永続化/冪等/宛先allowlist の小項目（hard-block ではない）。
5. ~~**Gmail受信の取込→登録書込導線**（②）~~ → **修正済（スライス5-2）**：隔離台帳 `lb_v2_inbound_contracts`（grant 020・append＋status）＋登録/一覧/状態遷移ルート。冪等（message+attachment指紋）。Driveバイト保管のみ別スライスへ（identity方式決定後）。
6. **Slack候補フローの依頼者メール**：コード側の二重エスケープ・バグを修正済（スライス5-3・`optionalEmail`）。**残りは DB作業のみ** — `matter_overview_v` が `requester_email`/`created_by`/`requester` のいずれかで依頼者メールを露出すること。→ 手順・SQL を用意済：`infra/gcp/sql/021_matter_overview_requester_introspect.sql`（現行定義吸い出し）＋`docs/phase5-db-followups.md` §C（introspect→拡張ビュー適用→検証）。

> **DB適用手順（A/B/C）**：`docs/phase5-db-followups.md` に集約。A) `lb_v2_gmail_send_history` 本番作成＋付与（019 production grants/preflight）、B) `lb_v2_inbound_contracts` 本番作成＋付与（020 production grants/preflight）、C) `matter_overview_v` 依頼者メール露出（021 introspect→拡張）。いずれも preflight（読取専用）→ 本適用の順。

## 4. 有効化・検証の共通チェックリスト

デプロイ後、`GET /api/v2/admin/diagnostics` と `GET /api/v2/integrations/status` を確認：
- `writeCapabilities` に対象コネクタが載る（scope/flag反映）。
- 送信系は `externalWritesDisabled=false`（＝`INTEGRATION_MODE=live`）になって初めて実送信可。
- 各コネクタの最小疎通（Drive:1ファイル / Gmail受信:一覧 / Slack:test-dispatch / Gmail送信:preview→1通 / CloudSign:認証確定後）。
- 切戻し：該当 `*_MODE=disabled`（または `INTEGRATION_MODE=local` で送信系一括停止）→ 再デプロイ。

> 詳細な env/確認トークンは `verify-write-test.sh` の各 case と `cloudbuild-write-test.yaml` の substitutions を参照。運用要点は画面内「設定＞運用ガイド」にも集約。
