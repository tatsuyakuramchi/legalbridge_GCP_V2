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

## ④-2 CloudSign：電子署名依頼（予定）
## ④-3 CloudSign：署名完了ステータス取込（予定）
## ④-4 Gmail：受信メールから契約PDF取込（予定）

## 参照

- [Slack配信ゲート（同型の実績パターン）](../apps/legalbridge/src/server/integrations/slack-dispatch-gate.ts)
