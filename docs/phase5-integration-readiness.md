# Phase 5：外部連携の実地点火 — レディネス・レビュー

Gmail送受信 / CloudSign / Slack / Drive を1つずつ本番相当で点火するための、コネクタ別「実装状態・有効化手順・残ギャップ・検証」レビュー。コード監査に基づく（実トークンは未使用）。

## 0. 全体像と最優先ブロッカー

- **総元栓 `INTEGRATION_MODE`**：Gmail送信 / CloudSign依頼 / Slack配信 の**送信系ゲートは `INTEGRATION_MODE=live` を要求**する（各ハンドラ内 `*-dispatch-gate.ts` の `integration_local` ブロッカー）。従来 `cloudbuild-write-test.yaml` はこれを **`local` にハードコード**しており、各 `*_MODE=live`＋確認トークンを揃えても実送信は 409 で止まっていた（＝パリティ表「停止中」の正体）。
  - **本レビューで修正済**：`INTEGRATION_MODE` を substitution `_INTEGRATION_MODE`（既定 `local`）へ変更。`live` は `verify-write-test.sh` で **write-test サービス＋IAP/Cloud Run IAM 必須**にガード。既定 `local` は挙動不変（default検証パス）。
  - 読取系（Gmail受信・CloudSignステータスGET・Drive）は `INTEGRATION_MODE` 非依存。
- **capability と実送信の乖離**：`/api/v2/runtime` の `writeCapabilities` は scope/flag のみ反映するため、capability が「on」でも `INTEGRATION_MODE=local` の間は送信がブロックされる。`/api/v2/admin/diagnostics` は `externalWritesDisabled = (INTEGRATION_MODE==='local')` を表示する。

## 1. 推奨点火順序（低リスク→高リスク）

1. **Drive**（最も安全・実クライアント・V1実績）→ 2. **Gmail受信**（読取のみ）→ 3. **Slack**（配信・履歴/冪等が堅牢・要実xoxb）→ 4. **Gmail送信**（DWD必須・冪等未実装）→ 5. **CloudSign**（**認証未確定・要最終確認**）。

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
- **ギャップ**：**取得PDFはクライアントへ返すのみで、文書レジストリ/Driveへ保存する書込導線が無い**（＝ブラウズ＋DLまで）。SA鍵マウントがDriveブランチに従属（下記共通ギャップ）。
- **検証**：`GET /gmail-inbound/contracts?q=` が対象箱のPDF添付課題を返すこと。

### ③ Slack配信 — 🟡 実xoxbトークン待ち（パイプラインは堅牢）
- **状態**：`slack-delivery-adapter.ts`（gate→履歴重複チェック→送信→受領検証→履歴追記）＋`slack-web-api-adapter.ts`（`xoxb-` 必須・`conversations.open`→`chat.postMessage`）。**冪等/履歴が堅牢**：`(issue_key, fingerprint)` の一意インデックス（grant 001）＋承認テーブル（grant 002）＋`ON CONFLICT DO NOTHING`。
- **点火手順**：実 **`xoxb-` bot token** を Secret Manager（`_SLACK_BOT_TOKEN_SECRET`）へ、V2デプロイSAに secretAccessor 付与。grant 001/002（履歴/承認・追記のみ）を適用。`SLACK_DELIVERY_MODE=live`＋`SLACK_DISPATCH_ENABLED=true`＋`CONFIRM_SLACK_DISPATCH=SLACK_DISPATCH_VALIDATION_ONLY`＋履歴/承認/承認書込を全て true＋`SLACK_DRY_RUN_USER_MAP`（`email=SlackID`・検証宛先限定）＋scope `slack,slack-dispatch(,slack-approvals)`＋AUTH＋**`INTEGRATION_MODE=live`**。
- **ギャップ**：`matter_overview_v` に依頼者メールが無く、候補フロー実送信は宛先解決不可 → まず `POST /admin/slack-notifications/test-dispatch`（固定文＋指定userId）でトークン/経路を検証。
- **検証**：test-dispatch で1通到達 → 候補フローはDBビュー整備後。

### ④ Gmail送信（通知メール）— 🟡 DWD鍵が必須・冪等未実装
- **状態**：`gmail-api-adapter.ts`（`gmail.send`＋DWD `subject=GMAIL_SENDER`）で実送信。ルートは preview(admin/legal)・dispatch(admin)。
- **点火手順**：`gmail.send` のドメイン全体委任SAを `GMAIL_SENDER` 送信元へ、鍵secret、`GMAIL_DELIVERY_MODE=live`・`GMAIL_SENDER`・`CONFIRM_GMAIL_DISPATCH=GMAIL_DISPATCH_VALIDATION_ONLY`・scope `gmail`・AUTH・**`INTEGRATION_MODE=live`**。
- **ギャップ**：(a) **SA鍵はDriveブランチでのみマウント**されるため、Drive未使用でGmailを立てると鍵ファイルが無くDWDが失敗（下記共通）。(b) **冪等未実装**：`idempotencyKey` を算出するがGmailクライアントが無視・送信履歴テーブルも無し → 再POSTで再送。運用では preview→dispatch を一度だけ、を徹底。
- **検証**：preview（MIME確認）→ dispatch 1通。二重送信ガードは運用対応。

### ⑤ CloudSign（署名依頼＋ステータス）— ⚠️ 認証未確定（最終確認必須）
- **状態**：`cloudsign-api-adapter.ts` に**実HTTPクライアントの足場**あり（`POST /token?client_id=`→Bearer、`/documents`作成→ファイル→参加者→送信、`GET /documents/:id`）。ただしエンドポイント/認証は**想定値**。
- **要最終確認（点火前ブロッカー）**：
  - **トークン交換が未検証**：`POST /token?client_id=` に**クライアントシークレット無し・grant_type無し**。実CloudSign OAuthはほぼ確実にsecret/交換が必要で、`CLOUDSIGN_CLIENT_SECRET` env が存在しない → **実APIとの突合が必要**。
  - エンドポイント/送信verb（`POST /documents/:id`）も想定。
  - `cloudSignDocumentId` を永続化せず（ステータス照会は呼び出し側がID保持）・冪等未実装。
- **点火手順**：実 `client_id`（＋secret/認証方式の確定）、base URL、`CLOUDSIGN_MODE=live`・`CONFIRM_CLOUDSIGN_DISPATCH`・scope `cloudsign`・AUTH・`INTEGRATION_MODE=live`。**ただし上記認証確定が先**。

---

## 3. 共通ギャップ（点火前の整備推奨）

1. ~~`INTEGRATION_MODE=local` ハードコード~~ → **本レビューで修正**（`_INTEGRATION_MODE` 化・ガード付き）。
2. **SA鍵マウントがDriveブランチに従属**（`cloudbuild-write-test.yaml` deploy step）：Gmail送信/受信をDrive無しで立てると `/secrets/gws-service-account.json` が無くDWD不可。→ Gmail点火時はDriveも併せて有効化するか、鍵マウント条件をGmail系にも広げるcloudbuild改修が必要（**要フォロー**）。
3. **Gmail/CloudSign に送信履歴・冪等強制が無い**（キーは算出するが未使用）。多重送信は運用手順で回避。恒久対応は履歴テーブル（Slack 001/002 相当）追加＝新規GRANT判断。
4. **CloudSign認証の実突合**（上記④）。
5. **Gmail受信の取込→登録書込導線**（②）。
6. **Slack候補フローの依頼者メール**（`matter_overview_v` 拡充・DBビュー作業）。

## 4. 有効化・検証の共通チェックリスト

デプロイ後、`GET /api/v2/admin/diagnostics` と `GET /api/v2/integrations/status` を確認：
- `writeCapabilities` に対象コネクタが載る（scope/flag反映）。
- 送信系は `externalWritesDisabled=false`（＝`INTEGRATION_MODE=live`）になって初めて実送信可。
- 各コネクタの最小疎通（Drive:1ファイル / Gmail受信:一覧 / Slack:test-dispatch / Gmail送信:preview→1通 / CloudSign:認証確定後）。
- 切戻し：該当 `*_MODE=disabled`（または `INTEGRATION_MODE=local` で送信系一括停止）→ 再デプロイ。

> 詳細な env/確認トークンは `verify-write-test.sh` の各 case と `cloudbuild-write-test.yaml` の substitutions を参照。運用要点は画面内「設定＞運用ガイド」にも集約。
