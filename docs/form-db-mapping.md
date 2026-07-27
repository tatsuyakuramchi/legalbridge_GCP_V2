# Template Form / DB Mapping

## 正本

| 対象 | 既存DB |
|---|---|
| template一覧 | `document_templates` |
| 現行版 | `document_templates.current_version_id` |
| HTML・入力定義 | `document_template_versions.html_source` / `field_schema` |
| 下書き | `document_drafts` |
| 発行済み文書 | `documents` |

## 保存マッピング

| フォーム要素 | 下書き | 正式発行 |
|---|---|---|
| template key | `document_drafts.template_type` | `documents.template_type` |
| 入力値 | `document_drafts.form_data` | `documents.form_data` |
| 課題キー | `document_drafts.issue_key` | `documents.issue_key` |
| 文書番号 | `document_drafts.document_number` | `documents.document_number` |
| template版 | API DTOで保持 | `documents.template_version_id` |
| 操作者 | `updated_by` | `created_by` |

`field_schema[].name`を`form_data`のキーとしてそのまま利用する。英大文字、日本語、camelCaseを変換しない。

## `dbField`

`dbField`は自動補完元であり、フォーム保存時の更新先ではない。

- `auto.docNumber`
- `auto.today`
- `backlog.issueKey`
- `backlog.summary`
- `company.*`
- `staff.*`
- `vendor.*`

フォーム上で補完値を変更しても、参照元マスターは暗黙更新しない。文書用スナップショットとして`form_data`へ保存する。

## コンテキスト合成順

1. `field_schema`から空のフォームを構築
2. `dbField`の自動補完
3. template固有の既存計算値
4. 下書きの上書き
5. 現行互換の別名正規化
6. 未知の旧キーを互換データとして保持

