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

- 案件・期限・工程を一覧できるコックピットUI
- 統合アプリ内APIのヘルスチェックとダッシュボードAPI
- DB template駆動フォームのDTOと描画基盤
- `field_schema`、`document_drafts.form_data`、`documents.form_data`の互換マッピング
- 下書き保存・復元・競合検出API
- ローカルPostgreSQL fixture
- 外部連携の送信なしモック
- Cloud BuildからCloud Runへデプロイする設定

詳しい手順は[`docs/local-to-gcp.md`](docs/local-to-gcp.md)を参照してください。

本番認証、文書レンダリング・発行、既存業務Command及び外部連携live adapterの移植は後続フェーズで実装します。
