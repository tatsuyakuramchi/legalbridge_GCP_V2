# V3 依頼の受付箱

対象: `apps/legalbridge-v3`（v3 スキーマ）
画面モック: 旧リポジトリで作成したもの（https://claude.ai/artifact/J3xWx8jK5mafi9YFMwojrA ）。画面の構成はこれに合わせる。

## 1. 何をするか

V3 はこれまで、Slack `/法務依頼` とメール取込が**届いた時点で案件を立てていた**（`integrations/intake-service.ts`・`email-intake-service.ts`）。誤起票・重複・情報不足の依頼も案件になり、法務が「受け付けた」という判断を置く場所が無い。

依頼と案件の間に**受付箱**を置く。

```
依頼者 ── Slack /法務依頼 ──▶ 受付箱に登録 ＋ Backlog に起案（ゲート経由）
                                   │
Backlog（V1 の Slack 受付・GAS・直接起票）──読みに行く（pull）──▶ 受付箱
                                   │
             法務が受付箱で判断：新規案件で受付／既存案件へ接続／重複／保留／対象外
                                   │
                                   ▼
          案件の工程バー先頭「受付」に依頼が接続される → 以後は案件の工程で進む
```

## 2. 決めたこと

| # | 決定 |
|---|---|
| D1 | 入口は Slack `/法務依頼`。送信時に**受付箱へ登録し、Backlog にも課題を起案する**（V1 と同じ体験）。Backlog への書込みはこの起案と、既存の「案件から課題を立てる」だけ |
| D2 | 取り込んだ依頼は必ず受付箱を通し、**人が受け付ける**。自動で案件にしない |
| D3 | 受け付けた依頼は案件の工程バー先頭「受付」に接続する。工程は保存しない（V3 の方針どおり導出） |
| D4 | Backlog は定期的に**読みに行く**（pull）。V1 の Slack 受付・GAS・Backlog 直接起票で立った課題もここで受付箱に入る。案件に繋がっている課題（`matter_links.backlog_issue`）は取り込まない |
| D5 | 受付後に Backlog 側が更新されたら「更新あり」で知らせるだけ。案件は自動で動かさない |
| D6 | 依頼の番号は `REQ-YYYY-NNNNN`。Backlog を経由しない依頼（口頭・メール）も手動で登録できる |
| D7 | 依頼者への連絡は Slack アプリ（`dispatch` の slack チャネル、ゲート経由）。受付・保留・重複・対象外を DM で知らせる |
| D8 | 受付後の文書作成は案件の中で行う（V3 の文書作成は案件の画面から）。Slack 受付時に文書は作らない |
| D9 | Backlog のステータスは起案時のまま置く。進捗は案件の工程と Slack で伝える |
| D10 | 納品・利用報告は依頼者が Slack で起票し、受付箱で既存案件に接続する（V1 の auto-chain の代わり） |

## 3. データ（`infra/v3/004_amend.sql` A-052）

`v3.intake_requests`（受付箱の1行＝依頼1件）

| 列 | 意味 |
|---|---|
| `request_no` | `REQ-YYYY-NNNNN`（`core/numbering.ts` の採番） |
| `source` | `slack` / `backlog` / `manual` |
| `state` | `new` 未処理 / `on_hold` 保留 / `accepted` 受付済 / `duplicate` 重複 / `dismissed` 対象外 |
| `kind` | 案件の取引モデル（`work` / `outsourcing` / `single`）。Slack の選択、または推定 |
| `title` / `detail` / `counterparty_name` / `due_on` | 依頼の中身 |
| `requester_slack_id` / `requester_name` / `requester_email` | 依頼者 |
| `backlog_issue_key` / `backlog_issue_id` / `backlog_status` / `backlog_updated_at` / `backlog_snapshot` | Backlog の原票（読み取り専用の写し） |
| `has_unseen_update` | 受付後に Backlog が更新された |
| `matter_id` / `duplicate_of_id` | 接続先 |
| `reason` / `hold_until` | 保留・対象外の理由、保留の再確認日 |
| `handled_at` / `handled_by` | 判断した日時と人 |

削除はしない（`DELETE` 権限を与えない）。誤って対象外にしたものは「受付箱に戻す」。
取得の栞は `settings`（`backlog_pull_cursor`）、実行記録と操作の記録は `audit_events`（V3 の流儀どおり専用の表は作らない）。

## 4. サーバー

- `intake/request-service.ts` … 受付箱の書込み（Slack 受付の登録、受付・接続・重複・保留・対象外・戻す・既読、手動登録）
- `intake/repository.ts` … 受付箱の読取り（一覧・詳細・案件に接続された依頼）
- `intake/backlog-pull.ts` … Backlog を読みに行くジョブ
- `integrations/adapters.ts` … `BacklogAdapter.listIssues`（読取り）
- `matters/flow.ts` … `FlowFacts.intake` があれば全フローの先頭に「受付」段
- ルート（`routes.ts`）

| メソッド | パス | 権限 |
|---|---|---|
| GET | `/api/v3/intake?state=new\|on_hold\|updated\|all` | 閲覧 |
| GET | `/api/v3/intake/:id` | 閲覧 |
| POST | `/api/v3/intake` | admin / legal（手動登録） |
| POST | `/api/v3/intake/:id/accept` | admin / legal |
| POST | `/api/v3/intake/:id/duplicate` ・ `/hold` ・ `/dismiss` ・ `/reopen` ・ `/seen` | admin / legal |
| GET | `/api/v3/matters/:id/intake` | 閲覧 |
| POST | `/api/v3/jobs/backlog-pull` | admin（手で1回） |
| POST | `/internal/jobs/backlog-pull` | Cloud Scheduler（共有シークレット） |

Slack の `/internal/slack/interactions` は、案件を立てる代わりに受付箱へ登録し、Backlog に起案する。

## 5. Backlog の取得

- `BACKLOG_MODE` が `off` なら動かない（理由を返す）。`dry_run` / `live` で動く（読むだけなので送信の段階とは独立に使える）。接続情報（`BACKLOG_HOST` / `BACKLOG_API_KEY` / `BACKLOG_PROJECT_ID`）が無ければ動かない。
- 栞（前回見た課題の最大更新時刻）の 5 分前以降に更新された課題を、更新順に 100 件ずつ全ページ読む。栞が無い初回は 24 時間前から（本文で `since` を渡せば変えられる）。
- 課題ごとに:
  1. 案件に繋がっている課題（`matter_links` の `backlog_issue`）→ 取り込まない
  2. 受付箱にある（課題 ID かキー）→ 写しを更新。受付済みで更新時刻が進んでいれば「更新あり」
  3. どちらにも無い → 受付箱に `new` で入れる（種別は課題種別から推定）
- 1件の失敗で残りを止めない。栞は失敗より手前までしか進めない（メール取込と同じ）。

## 6. 画面

- ナビ「入口」に **受付箱**（未処理＋更新ありの件数）。
- 受付箱: 未処理 / 保留 / 更新あり のタブ。左に一覧、右に原票（読み取り専用）と受付フォーム（種別・件名・相手先・担当・期日・接続先）。
- 案件詳細: 工程バー先頭の「受付」を押すと「やり取り」タブへ移り、接続された依頼の一覧（原票・Backlog 状態・更新あり）を出す。

## 7. 段階の開放

1. `004_amend.sql` と `003_grants.sql` を流す（表が増えるので 003 も流し直す）
2. `BACKLOG_MODE=dry_run` で `POST /api/v3/jobs/backlog-pull` を手で回し、受付箱に入る件数を確かめる
3. Cloud Scheduler: `/internal/jobs/backlog-pull` を 5 分ごと（`x-lb-webhook-token`）
4. Slack App の Request URL を V3 に切り替える（`docs/slack-intake-redesign.md` の条件を満たしてから）。切り替えるまでは V1 が Slack を受けて Backlog に起案し、V3 は pull で拾う
   - V3 はモーダルの送信に対し、受付箱へ登録した時点で応答する（Slack の 3 秒制限）。Backlog の起案と依頼者への確認はその後に行う。Cloud Run が応答後に CPU を絞る設定だと後続が遅れることがあるが、依頼は受付箱に入っており、課題キーは取得で件名の `[REQ-…]` から繋がる
5. `SLACK_MODE=live` で依頼者への DM を開ける

## 8. このあと

- メール取込（`email-intake-service.ts`）も受付箱経由にする（今は従来どおり案件を直接立てる）
- 受付時の文書下書き自動作成（種別ごとの既定テンプレート）
- 依頼者本人が自分の依頼の状況を見る画面（requester ロール）
