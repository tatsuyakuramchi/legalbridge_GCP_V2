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

## ④-2 CloudSign：電子署名依頼（足場実装済み）

確定済み文書のPDF（Drive連携と同じ描画パイプラインで生成）を CloudSign に送り、署名者へ依頼を発行する。API契約は CloudSign v2 の一般形（OAuth2 で `client_id` からトークン取得 → `/documents` 作成 → ファイル添付 → 参加者追加 → 送信）を想定した足場で、実URL・`client_id` は有効化時に確定する。

### API

- `POST /api/v2/documents/:id/cloudsign/preview`（admin/legal）
  - 送信せず、署名者一覧・文書タイトル・**ゲートのブロック理由**を返す。`documents` スコープ配下。
- `POST /api/v2/documents/:id/cloudsign/dispatch`（**admin限定**）
  - ゲート通過時のみ、文書PDFを描画して CloudSign に署名依頼。ブロック時409。`cloudsign` スコープ配下。

### 有効化（デプロイ substitution 追加）

`_WRITE_SCOPES` 末尾に `,cloudsign` を追加（順序：`...,gmail,cloudsign`）し、次を追加:

```
|_CLOUDSIGN_MODE=live|_CONFIRM_CLOUDSIGN_DISPATCH=CLOUDSIGN_DISPATCH_VALIDATION_ONLY|_CLOUDSIGN_CLIENT_ID=<CloudSignのclient_id>
```

`_CLOUDSIGN_BASE_URL` は既定 `https://api.cloudsign.jp`。かつ `INTEGRATION_MODE=live` が必要（未設定なら `integration_local` でブロック）。実発火前に、CloudSign の実APIエンドポイント／認証方式を最終確認して調整すること（足場は差し替え可能な client 層に分離済み）。

## ④-3 CloudSign：署名完了ステータス取込（足場実装済み）

CloudSign の `GET /documents/:id` からステータス（draft/sent/completed/canceled）と参加者の署名状況を取得し、正規化して返す（**表示のみ・DBテーブル変更なし**）。

- `GET /api/v2/cloudsign/:cloudSignDocumentId/status`（admin/legal・read）
  - ライブ未設定なら `{ live: false, status: null }`。ライブ時は `{ live: true, status: { status, completed, participants[] } }`。
  - `CLOUDSIGN_MODE=live`＋`CLOUDSIGN_CLIENT_ID` があれば有効（④-2と同じ設定を共有、追加スコープ不要）。

## ④-4 Gmail：受信メールから契約PDF取込（予定）

## 参照

- [Slack配信ゲート（同型の実績パターン）](../apps/legalbridge/src/server/integrations/slack-dispatch-gate.ts)
