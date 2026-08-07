# Gmail・CloudSign ライブ化（外部送信）手順

Slack配信と同じ guarded-write モデルで、Gmail送信・CloudSign連携を段階的にライブ化する。**既定は全てOFF**（`INTEGRATION_MODE=local` かつ各 `*_DELIVERY_MODE=disabled`・`WRITE_SCOPES`に無し）。DBテーブル・templateは変更しない。

外部への実送信は不可逆のため、以下を全て満たしたときだけ発火する（多重ゲート）:

1. `INTEGRATION_MODE=live`
2. 各連携の `*_DELIVERY_MODE=live` と送信元設定
3. `WRITE_SCOPES` に該当スコープ（`gmail` 等）
4. デプロイ確認トークン（`CONFIRM_GMAIL_DISPATCH` 等）
5. 実行者ロール（実送信は `admin` 限定）

## ④-1 Gmail：文書確定・成立通知メール（実装済み）

確定済み文書のメタ情報（文書番号・件名・相手方・Driveリンク）から通知メールを組み立て、Gmail API（ドメイン全体委任で送信元ユーザーとして送信）で送る。

### API

- `POST /api/v2/documents/:id/gmail-notification/preview`（admin/legal）
  - 送信せずに件名・本文・**ゲートのブロック理由**を返す。`documents` スコープ配下。
- `POST /api/v2/documents/:id/gmail-notification/dispatch`（**admin限定**）
  - ゲートを再評価し、`dispatchAllowed` のときだけ実送信。ブロック時は409＋理由。`gmail` スコープ配下。

### 送信元認証

Driveと同じ Workspace サービスアカウント鍵を再利用できる（`GMAIL_SA_KEY_PATH` 未指定時は `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` にフォールバック）。当該SAに **`gmail.send` スコープのドメイン全体委任**と、`GMAIL_SENDER`（送信元アドレス）の送信権限が必要。

### 有効化（デプロイ substitution 追加）

`_WRITE_SCOPES` 末尾に `,gmail` を追加（順序は `verify-write-test` と一致：`...,materials,gmail`）し、次を追加:

```
|_GMAIL_DELIVERY_MODE=live|_CONFIRM_GMAIL_DISPATCH=GMAIL_DISPATCH_VALIDATION_ONLY|_GMAIL_SENDER=<送信元アドレス>
```

かつ `INTEGRATION_MODE=live`（現状 `local`）にする必要がある。`INTEGRATION_MODE=local` のままなら、ゲートが `integration_local` でブロックし送信しない（プレビューは可能）。

### 検証

デプロイ後 `/api/v2/runtime` の `writeCapabilities` に `gmail` が出れば能力ON。実送信は `integration_mode=live` かつ上記が揃ったときのみ。

## ④-2 CloudSign：電子署名依頼（実装済み・API契約はV1準拠で確定）

確定済み文書のPDF（Drive連携と同じ描画パイプラインで生成）を CloudSign に送り、署名者へ依頼を発行する。**API契約は V1（LegalBridge_AI_GCP）の実動クライアントに突合して確定済み**（スライス5-6）：`POST /token` に **`client_id` のみを form-urlencoded**（client_secret 不要）→ `expires_in` 尊重・401再取得、`POST /documents`（form-urlencoded `title`）→ `POST /documents/:id/files`（multipart `uploadfile`）→ `POST /documents/:id/participants`（form-urlencoded）→ `POST /documents/:id`（送信確定）。

**送信堅牢化（スライス5-7）**：二重依頼防止の冪等履歴 `lb_v2_cloudsign_requests`（`CLOUDSIGN_REQUEST_HISTORY_ENABLED=true`＋grant 022）と、**宛先allowlist `CLOUDSIGN_ALLOWED_RECIPIENTS`**（設定時は全宛先が集合内であることを要求・検証中は必須）。

### API

- `POST /api/v2/documents/:id/cloudsign/preview`（admin/legal）
  - 送信せず、署名者一覧・文書タイトル・**ゲートのブロック理由**を返す。`documents` スコープ配下。
- `POST /api/v2/documents/:id/cloudsign/dispatch`（**admin限定**）
  - ゲート通過時のみ、文書PDFを描画して CloudSign に署名依頼。ブロック時409。`cloudsign` スコープ配下。

### 有効化（デプロイ substitution 追加）

`_WRITE_SCOPES` 末尾に `,cloudsign` を追加（順序：`...,gmail,cloudsign`）し、次を追加:

```
|_CLOUDSIGN_MODE=live|_CONFIRM_CLOUDSIGN_DISPATCH=CLOUDSIGN_DISPATCH_VALIDATION_ONLY|_CLOUDSIGN_CLIENT_ID=<CloudSignのclient_id>|_CLOUDSIGN_ALLOWED_RECIPIENTS=<検証宛先1,検証宛先2>|_CLOUDSIGN_REQUEST_HISTORY_ENABLED=true
```

`_CLOUDSIGN_BASE_URL` は既定 `https://api.cloudsign.jp`（sandbox は `https://api-sandbox.cloudsign.jp`）。かつ `INTEGRATION_MODE=live` が必要（未設定なら `integration_local` でブロック）。**verify は live 点火時に `CLOUDSIGN_ALLOWED_RECIPIENTS` 必須**（検証中の誤送信防止）。`CLOUDSIGN_REQUEST_HISTORY_ENABLED=true` は事前に grant 022 の適用が前提（`docs/phase5-db-followups.md` §D）。詳細な点火手順は **`docs/phase5-cloudsign-ignition.md`**。

## ④-3 CloudSign：署名完了ステータス取込（足場実装済み）

CloudSign の `GET /documents/:id` からステータス（draft/sent/completed/canceled）と参加者の署名状況を取得し、正規化して返す（**表示のみ・DBテーブル変更なし**）。

- `GET /api/v2/cloudsign/:cloudSignDocumentId/status`（admin/legal・read）
  - ライブ未設定なら `{ live: false, status: null }`。ライブ時は `{ live: true, status: { status, completed, participants[] } }`。
  - `CLOUDSIGN_MODE=live`＋`CLOUDSIGN_CLIENT_ID` があれば有効（④-2と同じ設定を共有、追加スコープ不要）。

## ④-4 Gmail：受信メールから契約PDF取込（足場実装済み）

対象メールボックスを `gmail.readonly` のドメイン全体委任で impersonate し、PDF添付のある契約候補メールを検索・取得する**読取専用**連携。外部メールボックス閲覧は機微なため、専用スコープ `gmail-inbound` ＋ live ＋ 対象メールボックス設定が揃わない限り無効。

### API

- `GET /api/v2/gmail-inbound/contracts?q=`（admin/legal・read）
  - PDF添付のあるメールを件名・差出人・日付・添付名で一覧。未有効なら `{ live: false, messages: [] }`。既定クエリは `GMAIL_INBOUND_QUERY`（既定 `has:attachment filename:pdf newer_than:180d`）。
- `GET /api/v2/gmail-inbound/messages/:messageId/attachments/:attachmentId`（admin/legal・read）
  - 添付PDFを `application/pdf` で返す（%PDF マジックバイト検証あり）。未有効なら409。

### 有効化（デプロイ substitution 追加）

`_WRITE_SCOPES` 末尾に `,gmail-inbound` を追加（順序：`...,cloudsign,gmail-inbound`）し、次を追加:

```
|_GMAIL_INBOUND_MODE=live|_CONFIRM_GMAIL_INBOUND=GMAIL_INBOUND_VALIDATION_ONLY|_GMAIL_INBOUND_MAILBOX=tatsuya.kuramochi@arclight.co.jp
```

送信元認証はGmail送信(④-1)と同じSA鍵を再利用。当該SAに `gmail.readonly` のドメイン全体委任と、対象メールボックスへの委任が必要。

## 参照

- [Slack配信ゲート（同型の実績パターン）](../apps/legalbridge/src/server/integrations/slack-dispatch-gate.ts)

## 参照

- [Slack配信ゲート（同型の実績パターン）](../apps/legalbridge/src/server/integrations/slack-dispatch-gate.ts)
