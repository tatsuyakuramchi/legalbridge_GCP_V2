# V1 の完全停止（V3 だけで回す）

決定（2026-09-26）:

- `/法務検索` を V3 に取り込み、V1 の業務の入口は V3 だけにする。
- **release/api（`legalbridge-search-api`）は残す。** V3 は戦略上の非保守対象で、
  **DB と法務ガイドのポータルは release/api 側で保守する**。
- 関連当事者チェック（RPT）・稟議・依頼者の資料アップロードは V3 に入れる。
- 納期変更の依頼は使った実績が無い（0 件）ので V3 に移さない。
- 発注書の納期アラートは V3 に足し、通知の内容と通知先を設定画面で変えられるようにする。

止めるのは `legalbridge-document-worker`・GAS・`legalbridge-admin-ui`。release/api は
法務ガイドのポータルと DB の保守のために動かし続け、それ以外の入口（Slack の受け口・
`/api/contract-check/*`・`/api/intake/*`）は使われなくなる。

V1 とは、リポジトリ `LegalBridge_AI_GCP` から動いている次のもの。

| 名前 | 中身 | デプロイ元 |
|---|---|---|
| `legalbridge-search-api` | 読取の API、`/法務検索` の契約状況、ポータル、Slack の受け口（Phase 31） | `release/api` |
| `legalbridge-document-worker` | Backlog の webhook、文書の生成、日次のアラート、CloudSign、メール送信 | `release/worker` |
| GAS（Slack ゲートウェイ） | `/法務依頼`・`/法務検索` の受け口、ポータルの `doGet`、関連当事者（`RPT.gs`） | Apps Script |
| `legalbridge-admin-ui` | 旧一体型。上の2つに置き換え済み | top-level `server.ts` |

## 1. V1 がやっていることと、V3 での扱い

凡例：✅ V3 で済み ／ 🔧 V3 で要対応（止める前に） ／ ❓ 残すか止めるかを決める ／ 🗑 止めてよい

### Slack

| V1 | V3 | 扱い |
|---|---|---|
| `/法務依頼` のモーダル（GAS・search-api が `views.open`） | `/internal/slack/commands` が `views.open` で開く（2026-09-26 に修正。それまでは開いていなかった） | ✅ |
| `/法務依頼` の送信 → Backlog 起票・`legal_requests`・文書の自動生成 | 受付箱に登録し、Backlog に起案。案件・文書は受付箱で受け付けてから（`docs/v3-request-inbox.md`） | ✅（流れを変えた） |
| `/法務検索`（契約状況・稟議番号・Web 詳細リンク） | `/法務検索`：契約チェックと同じ判定＋直近の文書・進行中の案件、番号・REQ・Backlog キーでも引ける | ✅（稟議番号は下の❓） |
| 納期変更の依頼（`/api/intake/deadline-change-request`）→ 承認で反映 | 無し | 🗑（実績 0 件。移さない） |
| 既存課題への紐付け起票 → 文書の自動生成（link-trigger） | 受付箱で既存案件へ接続（文書は案件から作る） | ✅（流れを変えた） |

### Backlog

| V1 | V3 | 扱い |
|---|---|---|
| webhook：課題の追加 → 文書を生成して Slack へ | 取得ジョブ（`/internal/jobs/backlog-pull`）で受付箱へ | ✅（流れを変えた） |
| webhook：状態の変更 → 依頼者へ DM・部署チャンネルへ | 工程の節目の通知（`/internal/jobs/flow-notice`） | ✅（知らせ方を変えた） |
| 子課題が全部完了したら親を完了に | 無し | 🗑（V3 は Backlog の状態を動かさない：D9） |
| 親の完了で子課題を自動起票（発注→納品報告、許諾→利用報告） | 工程の通知で「/法務依頼 で報告を」と案内（D10） | ✅（流れを変えた） |

### 日次の知らせ

| V1 | V3 | 扱い |
|---|---|---|
| 発注書ごとの納期 7・3・1 日前と超過のアラート（依頼者 DM・部署チャンネル） | 納期アラートを足す（通知の内容・通知先は設定画面で） | 🔧 対応中 |
| 契約ごとの更新通知を、その契約のチャンネルへ | 同上（1通の一覧） | 🔧 か、一覧で足りるなら ✅ |
| 検収待ちのダイジェスト（`inspection-digest`） | 無し | 🔧 か 🗑 |
| 期間満了の契約を自動で `expired` に | 無し（判定は日付から導く） | 🗑（V3 は状態を保存せず導く） |
| データ品質の夜間の再検査 | `daily` ジョブに含まれる | ✅ |

### 画面・ポータル

| V1 | V3 | 扱い |
|---|---|---|
| 作品・受取マップ・条件明細・支払の Excel・文書の生成・取込 | 各画面 | ✅ |
| 契約チェックのポータル（GAS `doGet`、`contract_check.html`） | 画面「契約チェック」と `/法務検索` | ✅（入口の URL が変わる） |
| 法務ガイド（`/portal`・`/guide`・`/g/:key`、版と閲覧制限つき） | release/api に残す（保守対象） | ✅（移さない） |
| 関連当事者（RPT：`gas/RPT.gs`、取締役会の議題） | V3 に入れる | 🔧 対応中 |
| 稟議（`/search/ringi`、稟議と文書の紐付け） | V3 に入れる | 🔧 対応中 |
| 依頼者の資料アップロード（署名付きリンク、課題キーで紐付け） | V3 に入れる | 🔧 対応中 |
| CloudSign の一括状態同期（定期） | 文書ごとの状態確認はある。定期の同期は無し | 🔧 か 🗑（webhook が届けば不要） |
| Drive リンクの健全性チェック | 無し | 🗑 |

## 2. 止める前に要るもの（順番どおり）

1. **`/internal/slack/*` を外から届くようにする。** V3 は `--no-allow-unauthenticated` なので、
   このままでは Slack から届かない。`/internal/slack/commands` と `/internal/slack/interactions`
   だけを通す経路を用意する（Load Balancer＋サーバーレス NEG で、パスを絞る）。この 2 つは
   Slack の署名で守っている（署名シークレットが無ければ常に 401）。
   Backlog は取得（pull）にしたので、Backlog の webhook を外から受ける必要は無い。
   CloudSign の webhook を受けるなら、同じ経路に `/internal/webhooks/cloudsign` を足し、
   `x-lb-webhook-token` は経路側で付けるか IP で守る（`v3-deploy-cloudshell.md` 手順8.7）。
2. **V3 の定期実行を入れる**（Cloud Scheduler、OIDC＋`x-lb-webhook-token`）:
   `daily`（平日朝）・`mail-intake`・`backlog-pull`（5 分ごと）・`flow-notice`（15 分ごと）。
3. **SQL を流す**：`004_amend.sql` → `003_grants.sql`（受付箱の表）。
4. **🔧 の穴を埋める**（最低限：発注書の納期アラート）。❓ は決めてから。
5. **Slack アプリの Request URL を V3 に切り替える**（`/法務依頼`・`/法務検索`・Interactivity）。
   切り替えた時点で V1 の GAS には届かなくなる。`SLACK_SEARCH_CHANNELS` に V1 の
   `ALLOWED_SEARCH_CHANNEL_IDS` と同じ値を入れておく。
6. **V1 の Backlog webhook を外す**（Backlog のプロジェクト設定）。外さないと、V3 が起案した
   課題を V1 も処理して文書を二重に作る。
7. **V1 の Cloud Scheduler を止める**（`daily-checks`・`inspection-digest`・`drive-verify-files`・
   `lb-dq-nightly-rescan` など）。止め忘れると V1 から古いアラートが飛び続ける。
8. 1〜2 週間、V1 のアクセスログが 0 のままであることを見る。
9. **V1 を止める**：`legalbridge-document-worker` と `legalbridge-admin-ui` を削除（か最小インスタンス 0・
   呼び出し権限の剥奪）、GAS のデプロイを無効化、`release/worker` の Cloud Build トリガーを無効化。
   **`legalbridge-search-api`（release/api）は止めない**（法務ガイドのポータル・DB の保守）。
   Slack の受け口と `/法務検索` は V3 に移ったので、release/api 側のそれらは使われなくなる。
10. `public` スキーマは消さずに読取専用にして残す（V3 の `legacy_id` で遡れるように）。
    040 は V1 が止まった後は流す必要が無い。

## 3. データの状態（2026-09-26 に本番で確認：`infra/v3/149_diagnose_v1_v3_documents.sql`）

- 文書番号の二重発行は 0 件。V3 は文書の連番を 1000 から先に飛ばしてあり、V1 とは番号帯が分かれている。
- ひな形 28 件のうち 22 件は V1 と一致。4 件（検収書・海外発注書・発注書・計算書）は V3 で改版済み、
  2 件は V3 で追加。`040` はこの 4 件を V1 の版に戻さないように直した（2026-09-26）。
- V3 だけで発行した文書が 224 件ある。V1 の検索・一覧には出ない（V1 を止めれば問題でなくなる）。
- V1 の文書で V3 に無いものが 3 件（2026-07-21 作成・番号なし）。中身を確かめて要否を決める。
