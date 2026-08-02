# LegalBridge GCP V2

LegalBridgeのAdmin UIとDocument Workerを再構築するためのV2リポジトリです。

## 固定する互換境界

- 既存テーブル構造を変更しない
- DBの`document_templates.current_version_id`が指すtemplate本文を変更しない
- DBの現行`field_schema`とHandlebars変数名を変更しない
- Backlogのプロジェクト、課題種別、ステータス、カスタムフィールド、運用を変更しない

## 構成

```text
apps/
  legalbridge/    Admin UI・API・業務処理を統合した単一アプリ
docs/
  architecture.md
  form-db-mapping.md
```

## 起動

```bash
cp .env.example .env
npm install
docker compose up -d db
npm run dev
```

- 開発UI: http://localhost:5173
- 開発API: http://localhost:8080

本番ではAPIがビルド済みUIを配信し、1つのサービスとして起動します。

コンテナを含む本番相当の確認:

```bash
docker compose up --build
```

## 現在の実装範囲

- 案件、文書、取引先、作品、金銭条件の統合UI・API
- 横断検索、管理概要、DB template互換性レポート
- DB template駆動フォームと既存`field_schema`互換マッピング
- 特殊フォーム、マスターデータ自動入力、HTMLプレビュー
- 下書き保存・復元・削除・競合防止
- 文書確定、既存形式の発番、確定後の文書一覧・詳細
- ChromiumによるPDF生成・ダウンロード
- Drive保存adapter（実環境のフォルダ権限確認は保留）
- 締結済イン契約の登録wizard（原作・素材・自社作品・イン条件をイン先確定として登録）
- 登録済み契約への後日アウト条件追記（`condition_lines`）と、許諾先ごとの個別利用許諾条件書・利用許諾料明細書の作成
- 登録済み契約取込の一覧・再選択レジストリ
- 管理者・法務担当・依頼者のロール認可
- 依頼者本人の下書き・文書だけを返す所有者分離
- 読取専用本番プレビューと独立書込み検証環境
- IAP接続を前提とした認証モードとデプロイガード
- 外部連携を送信しない`INTEGRATION_MODE=local`
- pull requestと`main`を検証するGitHub Actions CI

## 現在の安全境界

- 書込み検証は独立DBだけを使用
- 書込み機能は`WRITE_FEATURES_ENABLED`と`WRITE_SCOPES`で限定
- Drive、Slack、Gmail、CloudSign、Backlogを一括で有効化しない
- 本番DB参照環境ではアプリとDBセッションの両方をread-onlyにする
- Backlog、Slack、メール、CloudSignへのlive送信は未開放

詳しい環境構築は[ローカル・GCP手順](docs/local-to-gcp.md)、本番移行条件は[Production Readiness Runbook](docs/production-readiness.md)、締結済契約取込の書込みデプロイは[契約取込デプロイ手順](docs/contract-intake-deploy.md)を参照してください。

## 次のフェーズ

1. 主要文書類型の実帳票回帰
2. IAP実アカウント確認
3. 本番書込みの段階的開放
4. Drive権限の解決
5. Slack UXプレビュー、検証チャンネル、live adapterの段階開放
6. Gmail、CloudSign、Backlogのadapter単位の移植
7. 旧サービスとの並行稼働、監視、切戻し、本番切替
