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
  admin-ui/       法務オペレーション・コックピット
  worker/         Admin UI向けWorker API v2
packages/
  shared/         API DTOとtemplateフォーム型
docs/
  architecture.md
  form-db-mapping.md
```

## 起動

```bash
npm install
npm run dev
```

- Admin UI: http://localhost:5173
- Worker API: http://localhost:8080

## 現在の実装範囲

- 案件・期限・工程を一覧できるコックピットUI
- Worker APIのヘルスチェックとダッシュボードAPI
- DB template駆動フォームのDTOと描画基盤
- `field_schema`、`document_drafts.form_data`、`documents.form_data`の互換マッピング

本番DB接続、認証、既存業務Commandの移植は後続フェーズで実装します。
