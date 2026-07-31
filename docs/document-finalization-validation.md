# 文書確定・発番の分離検証設計

## 目的

下書きから正式文書レコードを作成する最小工程を、検証DB内だけで確認する。
本番DB、Backlog、Drive、PDF生成、外部送信には接続しない。

## 使用する既存テーブル

テーブル構造は変更せず、次の既存構造を使用する。

- `document_templates`: template keyと文書prefix
- `document_template_versions`: 確定対象のtemplate版
- `document_drafts`: 確定前の入力内容
- `documents`: 確定した文書レコード
- `document_sequences`: 文書種別・年単位の採番値

## 確定トランザクション

1. 現行template版と入力必須項目を検証する
2. 下書きの`updated_at`が画面表示時と一致することを確認する
3. 有効templateの`document_prefix`を取得する
4. `document_sequences`をupsertし、採番値を排他的に増加させる
5. `documents`へレコードを追加する
6. 対象下書きを`id`・案件キー・template・更新日時一致で削除する
7. すべて成功した場合だけcommitする

途中で失敗した場合は、発番・文書追加・下書き削除をすべてrollbackする。

## 機能ガード

文書確定APIには次の条件をすべて要求する。

- `DB_ACCESS_MODE=readwrite`
- `WRITE_FEATURES_ENABLED=true`
- `WRITE_SCOPES`に`documents`を含む

既存の書込検証Cloud Buildは引き続き`WRITE_SCOPES=drafts`のため、
このPRをデプロイしただけでは文書確定APIは403となる。

## 外部連携

確定APIのレスポンスは、外部処理を明示的に次の状態で返す。

- PDF: `pending`
- Drive: `disabled`
- Backlog: `disabled`

検証DBの必要テーブルと権限確認が完了するまで、Cloud Buildへ
`documents`スコープを追加しない。

## 検証DB準備の次工程

本番データをコピーせず、次の構造だけを検証DBへ追加する。

- `documents`: schema、sequence、index、constraintのみ
- `document_sequences`: schema、index、constraintのみ

初期件数が両方0件であること、検証ユーザーが本番DBの両テーブルへ
INSERT・UPDATE・DELETE権限を持たないことを確認してから、
検証環境だけで`documents`スコープを有効にする。
