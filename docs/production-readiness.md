# Production Readiness Runbook

LegalBridge V2を旧サービスと置き換える前に確認するゲートを定義する。各ゲートは順番に完了し、未完了の項目がある状態で次の書込み範囲を開放しない。

## 1. 常時維持する安全境界

- 既存テーブル構造、DB template本文、`field_schema`を変更しない
- Backlogの課題種別、ステータス、カスタムフィールド、運用を変更しない
- 外部連携はadapter単位で明示的に有効化する
- 本番DB参照環境は`DB_ACCESS_MODE=readonly`を維持する
- 検証書込みは`legalbridge_v2_validation`だけを使用する
- 書込み範囲は`WRITE_SCOPES`で個別に開放する
- Drive、Slack、Gmail、CloudSign、Backlogを一括で有効化しない

## 2. Gate A — コード品質

- [ ] pull requestのCIが成功
- [ ] `npm run typecheck`が成功
- [ ] `npm test`が全件成功
- [ ] `npm run build`が成功
- [ ] 依存パッケージの既知脆弱性が0件
- [ ] read-only、write scope、role authorizationの拒否テストが成功

Gate Aが失敗した変更はデプロイしない。

## 3. Gate B — 主要文書の回帰試験

最低限、次の文書群を検証DBで1件ずつ作成し、旧文書と比較する。

- [ ] NDA
- [ ] 業務委託基本契約
- [ ] ライセンス契約
- [ ] 個別利用許諾条件
- [ ] 売買契約（当社買手）
- [ ] 売買契約（当社売手・標準）
- [ ] 売買契約（当社売手・保証金掛け売り）
- [ ] 発注書
- [ ] 企画発注書
- [ ] 出版発注書
- [ ] 納品リクエスト
- [ ] 製造案件
- [ ] 売上報告案件

各文書で次を確認する。

- [ ] 入力項目、必須判定、初期値
- [ ] 取引先・作品等のマスター自動入力
- [ ] 下書き保存、復元、削除、競合防止
- [ ] 文書確定、文書番号、作成者、確定日時
- [ ] HTML表示、日本語、金額、日付、条件分岐、明細
- [ ] PDFの改ページ、余白、署名欄、ページ数
- [ ] 文書一覧・詳細への反映
- [ ] 他ユーザーからの所有者分離
- [ ] 外部連携が発生していないこと

差異は「V2不具合」「旧template由来」「入力データ差」のいずれかに分類して記録する。

## 4. Gate C — 認証・権限

このゲートはIAP・ドメイン作業を再開した際に実施する。

- [ ] 管理者アカウントで管理画面を利用できる
- [ ] 法務担当が管理APIを利用できない
- [ ] 依頼者が自分の下書き・文書だけを利用できる
- [ ] 許可対象外アカウントを拒否する
- [ ] Cloud Runの直接経路を利用できない
- [ ] IAP経由のメールが`created_by`、`updated_by`へ記録される

## 5. Gate D — 本番書込みの限定開放

開放単位ごとに、実行前後の件数と対象IDを記録する。

1. 下書き
2. 文書確定・発番
3. PDF
4. Drive
5. Slack・Gmail・CloudSign
6. Backlog

各段階で確認する。

- [ ] 対象scope以外がHTTP 403
- [ ] 重複実行時に二重登録・二重送信しない
- [ ] 失敗時にDBと外部サービスの状態が不整合にならない
- [ ] 操作者、対象文書、実行時刻を追跡できる
- [ ] 直前段階へ戻す手順が確認済み

## 6. 監視

日常確認:

- `/health`のサービス・DB到達性・read-only状態
- Cloud Runの5xx、レイテンシ、コンテナ再起動
- Cloud SQLの接続数、エラー、容量
- 文書確定、PDF生成、外部連携のエラーログ
- 最新Ready Revisionとトラフィック配分

異常とする条件:

- DB到達不能
- read-only環境でread-only判定がfalse
- PDF要求直後のコンテナ再起動
- 同一文書番号又は外部ファイルの重複
- 外部連携無効環境からの送信
- 認証メールと文書所有者の不一致

## 7. 障害時の初動

1. 新規書込みを停止する
2. `WRITE_FEATURES_ENABLED=false`又は対象`WRITE_SCOPES`を除外する
3. 影響したリビジョン、時刻、文書ID、文書番号を記録する
4. Cloud RunログとDB状態を保存する
5. 必要に応じて直前の正常リビジョンへトラフィックを戻す
6. DBレコードを自動削除・自動巻戻ししない
7. 外部送信済みの場合は各サービス側の状態を個別確認する

直前リビジョンの確認:

```bash
gcloud run revisions list \
  --service=SERVICE_NAME \
  --region=asia-northeast1 \
  --project=legalbridge-488506
```

トラフィックを戻す場合は、対象リビジョンを確認したうえで実行する。

```bash
gcloud run services update-traffic SERVICE_NAME \
  --region=asia-northeast1 \
  --project=legalbridge-488506 \
  --to-revisions=KNOWN_GOOD_REVISION=100
```

## 8. 本番切替判定

次をすべて満たすまで旧サービスを停止しない。

- [ ] Gate A〜Dが完了
- [ ] 主要文書の実帳票回帰が完了
- [ ] 旧サービスとの並行稼働期間を完了
- [ ] 外部連携ごとの冪等性と切戻しを確認
- [ ] 監視担当、障害連絡先、初動手順を確定
- [ ] 本番切替日時と旧サービス停止日時を承認
- [ ] 切替後に件数、発番、PDF、外部連携を再照合

## 9. 現在の保留事項

- Google Driveフォルダ権限
- IAPのDNS・証明書・実アカウント確認
- `kadokawa.jp`外部ユーザー認証
- Slack、Gmail、CloudSign、Backlogのlive adapter
- 本番DB書込み
