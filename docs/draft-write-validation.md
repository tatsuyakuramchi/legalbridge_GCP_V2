# 下書き書込検証環境

## 目的

V2の最初の書込機能として、`document_drafts`への保存・復元・競合検知だけを検証する。
発番、正式文書作成、PDF、Drive、案件・タスク更新、外部送信は対象外とする。

## 分離条件

- Cloud Runサービス: `legalbridge-v2-write-test`
- Database: `legalbridge_v2_validation`
- DB user: `legalbridge_v2_validation_writer`
- Secret: `legalbridge-v2-validation-writer-db-password`
- Integration mode: `local`
- Write scope: `drafts`

本番DB `legalbridge`および本番プレビューサービス`legalbridge-v2-preview`は使用しない。

## アプリケーション側の安全条件

下書き保存には、次のすべてが必要となる。

1. `DB_ACCESS_MODE=readwrite`
2. `WRITE_FEATURES_ENABLED=true`
3. `WRITE_SCOPES`に`drafts`を含む

いずれかが欠ける場合、書込リクエストは`403 WRITE_SCOPE_DISABLED`または
`403 READ_ONLY_MODE`となる。`drafts`を有効にしても、案件・文書・台帳等の
その他の書込は許可されない。

## デプロイ前提

検証DB、検証ユーザー、Secretの準備と権限確認が完了するまではデプロイしない。
`cloudbuild-write-test.yaml`は、`_CONFIRM_ISOLATED_DB=ISOLATED_DRAFT_TEST`
が明示されない限りデプロイを停止する。
