# V3 構築計画

`docs/core-schema-redesign.md` の設計を、稼働中のV1・V2を止めずに実装するための手順。

## 決めたこと

| 論点 | 決定 | 理由 |
|---|---|---|
| V3テーブルの置き場所 | **同一DB内の `v3` スキーマ** | V1が `public` で動いたまま、移行が1DB内の `INSERT ... SELECT` で完結する。クロスDB同期が要らない |
| 接頭辞かスキーマか | スキーマ | 設計どおりのテーブル名が使え、GRANTがスキーマ単位。作り直しは `DROP SCHEMA v3 CASCADE` |
| 旧IDの扱い | 各表に `legacy_id`（＋作品は `legacy_table`）を持つ | 並行稼働中に新旧を突き合わせられる。移行スクリプトの再実行も冪等にできる |
| アプリの置き場所 | `apps/legalbridge-v3`（同一リポジトリ） | 文書生成・外部連携アダプタを現行から流用するため |
| 切替方式 | Cloud Run に別サービスとして立て、切替後にV1を停止 | 切戻しがサービス単位で済む |

## Step 1 — テーブルとデータ

| # | 成果物 | 状態 |
|---|---|---|
| 1-1 | `infra/v3/001_schema.sql` — 28テーブル | **完了**（PostgreSQL 16 で実行検証・冪等） |
| 1-2 | `infra/v3/002_views.sql` — 6ビュー | **完了**（権利包絡の積演算を実データで検証） |
| 1-3 | `infra/v3/010_migrate_master.sql` — 取引先・担当者・作品・パート | 未 |
| 1-4 | `infra/v3/020_migrate_core.sql` — 合意・条件・範囲・予定・実績 | 未 |
| 1-5 | `infra/v3/030_migrate_documents.sql` — テンプレ・文書・文書条件 | 未 |
| 1-6 | `infra/v3/040_migrate_matters.sql` — 案件・リンク・タスク | 未 |
| 1-7 | `infra/v3/090_verify.sql` — 件数・整合・欠落の検算 | 未 |
| 1-8 | `infra/v3/003_grants.sql` — `legalbridge_v3_runtime` の権限 | 未 |

移行スクリプトはすべて**冪等**（`ON CONFLICT (legacy_id) DO UPDATE`）とし、
何度でも流し直せるようにする。並行稼働中は日次で流し直して差分を取り込む。

### 最難関：`form_data` の解決

`documents.form_data` に散った値を、`conditions` と `agreements` の列へ確定させる工程。
現行は「読むときにフォールバック」で逃げているが、移行では全件を決め切る必要がある。

- 相手先 … 10種のキー（`VENDOR_NAME` / `Licensor_氏名会社名` / `Licensor_名称` / `許諾者` /
  `相手先` / `取引先` / `counterparty` / `LICENSOR_NAME` / `licensor` / `designerName` / `PARTY_A_NAME`）
- 件名 … 6種のキー（`PROJECT_TITLE` / `CONTRACT_TITLE` / `基本契約名` / `件名` / `title` / `contractTitle`）

優先順位表を1本に決め、解決できない行は `v3.data_quality_issues` に落として人手で潰す。
**この工程だけは全件を目視で確認できる規模**（案件約218件・依頼約466件）なので、
自動解決＋残りを一覧化する方式で足りる。

## Step 2 — UIとアプリケーション

`apps/legalbridge-v3` に一括で構築する。画面構成はモックのとおり。

- 入口：ホーム／案件（制御レイヤー・フロー種別で分岐）
- 横断：条件／作品／取引先・担当／文書／お金
- 監視：フロー監視（取適法の遵守一覧・作品ごとの権利上限）／運用

現行から**移植**するもの（作り直さない）。

| 領域 | 移植元 |
|---|---|
| 文書生成（Handlebars → HTML → Chromium PDF） | `documents/` の描画・PDF・採番 |
| Drive 保存 | `documents/drive-storage.ts` |
| Slack（受付・通知・スレッド） | `slack-intake/` `integrations/slack-*` |
| Gmail（送信・受信取込） | `integrations/gmail-*` |
| CloudSign | `integrations/cloudsign-*` |
| Backlog | `integrations/backlog-*` |
| ロイヤリティ計算（MG/AG・源泉・為替） | `royalty/` `documents/royalty-normalization.ts` |

新規に書くのは**書込層だけ**。事実単位のサービスが `v3` の保存先を1トランザクションで更新する
（`docs/edit-fanout-audit.md` の対処B）。

## Step 3 — Cloud Run へのデプロイ

- 既存の `legalbridge` サービスとは別に `legalbridge-v3` を作成
- 接続先は同一Cloud SQLインスタンス、`search_path=v3`
- ロールは `legalbridge_v3_runtime`（`v3` スキーマのみ・`public` への権限を与えない）
- IAP・監視・アラートは現行の設定を複製
- 切替後、V1・V2を停止。`public` は当面残す（切戻しとデータ突き合わせのため）

## 実行順序と依存

```
1-1 ── 1-2 ──┬── 1-3 ── 1-4 ── 1-5 ── 1-6 ── 1-7
             └── 1-8
                       ↓
                    Step 2（1-4 まで通れば着手可能）
                       ↓
                    Step 3
```

Step 2 は移行の完了を待たない。1-4（条件まで）が通れば実データで開発できる。
