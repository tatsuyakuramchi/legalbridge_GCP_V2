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
受信メール（既存の案件のやり取りに当たらない新しいメール）──取り込み──▶ 受付箱
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
| D7 | 依頼者への連絡は Slack アプリ（`dispatch` の slack チャネル、ゲート経由）。受付・保留・重複・対象外を DM で、工程の節目を案件のスレッド（無ければ依頼者の DM）で知らせる（§6.1） |
| D8 | 受付後の文書作成は案件の中で行う（V3 の文書作成は案件の画面から）。Slack 受付時に文書は作らない |
| D9 | Backlog のステータスは起案時のまま置く。進捗は案件の工程と Slack で伝える |
| D10 | 納品・利用報告は依頼者が Slack で起票し、受付箱で既存案件に接続する（V1 の auto-chain の代わり）。履行に入ったら工程の通知で「案件番号を書いて /法務依頼 で報告」と案内する |
| D11 | 受信メールも受付箱を通す。既存の案件に当たるメール（同じスレッド・本文の案件番号・こちらが出した文書番号）は従来どおり案件のやり取りに入れる。当たらない新しいメールだけを受付箱に入れ、受付前の同じスレッドの返信は同じ依頼に書き足す |

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
| `email_thread_id` / `email_message_id` / `source_payload` | メールの原票（差出人・宛先・本文・添付と、受付前に届いた続きのメール `followUps`） |
| `counterparty_id` | 相手先の推定（メールの差出人が取引先の連絡先に1件だけ当たったとき）。受付の初期値 |
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
- `matters/flow-notice.ts` … 工程の節目を知らせるジョブ（§6.1）
- `integrations/email-intake-service.ts` … 新しいメールを受付箱へ（`queued`）、受付前の続きは書き足す（`appended`）
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
| POST | `/api/v3/jobs/flow-notice` | admin（手で1回） |
| POST | `/internal/jobs/flow-notice` | Cloud Scheduler（共有シークレット） |

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

- ナビ「入口」に **受付箱**（未処理＋返信・更新ありの件数）と **デイリータスク**（終わっていない作業の件数。§10）。
- 受付箱は振り分けだけ（A-064）: 未処理 / 保留 / 返信・更新あり / すべて のタブ。左に一覧、右に原票（読み取り専用）と振り分けのフォーム。振り分けは 2 択＋例外：**軽微 → デイリータスク**（種別・件名・担当・期日。検収書・計算書は対象の番号と条件）／**大きい → 案件にする**（繋ぎ先・依頼の種類・件名・担当・期日）／保留・重複・対象外。迷ったら軽微で受けてよい（デイリータスクから「案件に移す」ことができる）。
- 振り分けた依頼は受付箱から消える。「すべて」では行き先（デイリーへ／案件へ）と作業の状態で見分ける。
- 案件詳細: 工程バー先頭の「受付」を押すと「やり取り」タブへ移り、接続された依頼の一覧（原票・Backlog 状態・更新あり）を出す。案件の中の作業は「作業」タブ（§10）。

### 6.1 工程の節目の通知

V3 は工程を保存しないので、「工程が進んだ」という出来事は起きない。定期ジョブ（`flow-notice`）で各案件の工程を導き直し、前回までに知らせた節目と比べて**新しく成り立ったものだけ**を知らせる。

| 段 | いつ | 知らせる内容 |
|---|---|---|
| 相手方の文書を確認 | いまの段になった | 相手方の文書を確認中（相手方との調整に入った） |
| 基本契約の確認 ／ 契約書の締結 ／ 条件の合意 | 済になった | 契約を確認・締結した ／ 条件がまとまった |
| 発注 ／ 文書の決定（ひな形・自社ドラフト・相手方文書） | 済になった | 文書を決定した。送付・署名に進む |
| 納品・報告 | いまの段になった | 履行に入った。納品を受けたら /法務依頼 で案件番号を書いて報告を |
| 検収 ／ 支払 | 済になった | 検収が済んだ ／ 支払まで済んだ |
| 実績の受領 | いまの段になった | 実績が出たら /法務依頼 で案件番号を書いて報告を |
| 計算書と分配 | 済になった | 計算書を出した |
| 決定（その他案件） | 済になった | 法務の対応が決まった |
| 案件の状態が完了 | — | 案件を完了した |

- 初めて見る案件は、いまの状態を記録するだけで送らない（動かし始めた日に過去の節目が一斉に届かない）。
- 同じ節目は二度送らない（`audit_events` の `matter.flow_notice`、冪等キー `flow-notice:<案件>:<節目>`）。1回の実行で1案件1通にまとめる。
- 送り先は案件のスレッド → 案件の依頼者の DM（`MatterCommunicationService.sendSlack`。案件のやり取りに記録される）。受付箱から繋いだ別の依頼者にも DM。
- Slack のゲートで止まっても節目は記録する。止めるときは `settings` の `flow_notice` に `{"disabled": true}`、段ごとに外すなら `{"off": ["検収"]}`。

## 7. 段階の開放

1. `004_amend.sql` と `003_grants.sql` を流す（表が増えるので 003 も流し直す）
2. `BACKLOG_MODE=dry_run` で `POST /api/v3/jobs/backlog-pull` を手で回し、受付箱に入る件数を確かめる
3. Cloud Scheduler: `/internal/jobs/backlog-pull` を 5 分ごと、`/internal/jobs/flow-notice` を 15 分ごと（どちらも `x-lb-webhook-token`）。メール取込（`/internal/jobs/mail-intake`）は既存のまま。新しいメールは受付箱に入るようになる
   - 工程の通知は、Slack を開ける前（`SLACK_MODE=off`）から動かしておくと、開けた時点で過去分が溜まらない（止まっている間の節目も記録だけされる）
4. Slack App の Request URL を V3 に切り替える（`docs/slack-intake-redesign.md` の条件を満たしてから）。切り替えるまでは V1 が Slack を受けて Backlog に起案し、V3 は pull で拾う
   - V3 はモーダルの送信に対し、受付箱へ登録した時点で応答する（Slack の 3 秒制限）。Backlog の起案と依頼者への確認はその後に行う。Cloud Run が応答後に CPU を絞る設定だと後続が遅れることがあるが、依頼は受付箱に入っており、課題キーは取得で件名の `[REQ-…]` から繋がる
5. `SLACK_MODE=live` で依頼者への DM を開ける

## 8. 支払文書の依頼を案件にせず処理（A-058）

> A-064（§10）で、「案件にせず処理」は受付箱の「軽微 → デイリータスク」になった。依頼を小さなチケットにする代わりに、依頼から作業（`tasks`）を 1 行起こして追う。この節の 引き当て・工程・依頼者への連絡 の仕組みはそのまま生きている。担当・期日・完了（`assignee_staff_id`・`done_at`）は依頼ではなく作業に持つ。

検収書・利用許諾計算書の依頼（`/法務依頼` の「納品を受けたので支払いたい」「利用許諾料を支払いたい」）は、毎期の定型業務で、案件にしても Slack・Backlog・Drive の入れ物を使う場面がほとんど無い。一方で「誰がいつまでにやるか」と「依頼者への連絡」は要る。そこで**依頼（REQ-…）を作業テーブルの 1 行にして追う**。

### 8.1 受け付け方

受付フォームの接続先に「案件にせず処理（検収書・利用許諾計算書）」がある。

| 依頼 | 既定の受け方 |
|---|---|
| 利用許諾計算書 | 案件にせず処理。契約書番号（`agreements.agreement_no` か契約書の文書番号）から、その契約の許諾（IN）の条件を引き当てる |
| 検収書（発注書が案件に入っていない） | 案件にせず処理。発注書番号から、発注書に載っている条件（`document_conditions`）を引き当てる |
| 検収書（**発注書が案件に入っている**） | **その案件へ接続するほかは受けない**（サーバも止める）。検収書はその案件の中で作り、案件の工程・スレッドに揃える |

- 引き当てた条件は画面で外せる。番号を直したら、受け付けるときに引き当て直す。
- 担当（`assignee_staff_id`）と期日（`due_on`）は依頼に持つ。受け付けたあとも変えられる。
- 手で登録した依頼・メールの依頼も、依頼の内容（検収書／計算書）を選べば案件にせず処理できる。

### 8.2 工程（保存しない。事実から導く）

| 段 | 済になる条件 |
|---|---|
| 受付 | 受け付けた |
| 作成 | 依頼の文書が決定（issued）になった。下書きだけなら「下書きあり」と出す |
| 送付 | その文書をメール（`gmail.send`）か CloudSign（`cloudsign.send`）で送った |
| 支払予定 | その文書の実績（`condition_events.document_id`）に割り当てた支払がある（取消は除く） |
| 支払 | その支払がすべて支払済み |

- 依頼の文書＝**依頼より後に作られた文書のうち、依頼の条件（改訂の系列ごと）に載っていて、種類が合うもの**（検収書のテンプレート／計算書）。当たらない文書（依頼の前に作った、別の条件で作った）は画面で文書番号を入れて手で繋ぐ（`intake_request_links` の `document`）。
- 支払まで済むか、人が「対応完了にする」と完了。完了したものは「対応中」から消える（「すべて」で見られる）。

### 8.3 依頼者への連絡（Slack の DM のスレッド）

- 依頼者への DM は**依頼ごとに1本のスレッド**にまとめる。最初の DM（送信の確認）が親で、その ts を `intake_requests.slack_thread_ts` に持つ。受付・保留・工程の知らせはすべてそのスレッドに返す（案件で受けた依頼も、受付の知らせまでは同じスレッド）。
- 工程の知らせは案件の工程の知らせと同じ定期ジョブ（`flow-notice`）で回す。知らせるのは 作成・送付・支払予定・支払（受付は受け付けたときに送る）と、人が完了にしたときの完了。同じ節目は二度送らない（`audit_events` の `intake.progress_notice`、冪等キー `intake-progress:<依頼>:<節目>`）。1回の実行で1依頼1通。
- 止めるのは案件と同じ `settings` の `flow_notice`（`{"disabled": true}`）。段ごとに外すなら `{"off": ["送付"]}`（段の名前は 作成・送付・支払予定・支払）。
- 依頼者がスレッドに返信すると、案件にせず処理している依頼なら依頼に残り（`audit_events` の `intake.reply`）、受付箱の「更新あり」に出る。案件に繋いだ依頼なら案件のやり取りに入る。

### 8.4 データ（`infra/v3/004_amend.sql` A-058）

- `intake_requests`：`handling`（matter / direct）、`assignee_staff_id`、`done_at`・`done_by`、`slack_thread_ts`。受付済は「案件が要る」を「案件で対応なら」に緩めた（`intake_requests_accepted_chk`）。
- `intake_request_links(request_id, target_type, target_id)`：`condition`（引き当てた条件）と `document`（手で繋いだ文書）。付け外しできる。

### 8.5 経路

| メソッド | パス | 権限 |
|---|---|---|
| GET | `/api/v3/tasks?tab=open` | 閲覧（デイリータスク。工程つき。§10） |
| POST | `/api/v3/intake/:id/accept`（`mode: "direct"`、`purpose`・`targetDocNo`・`conditionIds`） | admin / legal |
| PATCH | `/api/v3/tasks/:id`（担当・期日・状態。§10） | admin / legal |
| POST / DELETE | `/api/v3/intake/:id/documents`（文書を手で繋ぐ・外す） | admin / legal |

### 8.6 開放

1. `004_amend.sql`（A-058）を流す。Studio なら `004_amend_studio.sql`
2. 何も切り替えなくても使える。工程の知らせは既存の `flow-notice` の定期実行に乗る

## 9. このあと

- 受付時の文書下書き自動作成（種別ごとの既定テンプレート）
- 依頼者本人が自分の依頼の状況を見る画面（requester ロール）
- 定型文書・その他のデイリータスクの自動完了（締結・送付の記録から）。いまは人が完了にする

## 10. デイリータスク：受付箱は振り分けだけ、作業は作業テーブルで（A-064）

受付箱が「振り分け」と「作業」の両方を担っていて、状態の物差しが 4 つ（依頼の `state`、`handling`＋`done_at`、案件の `status`、文書の段階）に散っていた。支払が済んでも依頼が「対応中」に残る、案件化した依頼はずっと「受付済」、受け付けた依頼を軽微↔案件で切り替えられない、`tasks` は作るだけで状態を変える経路が無い、が画面で迷う原因だった。

```
依頼 ─▶ 受付箱（振り分けだけ）
          ├─ 軽微 ─▶ デイリータスク（tasks。matter_id なし）─ 大きくなったら ─▶ 案件に移す
          ├─ 大きい ─▶ 案件 ─▶ 案件の中の作業（tasks。matter_id あり）
          └─ 保留／重複／対象外
```

### 10.1 決めたこと

| # | 決定 |
|---|---|
| T1 | 作業テーブルは `v3.tasks` の 1 つ。デイリータスク＝`matter_id` が空で `request_id` がある行。案件の中の作業＝`matter_id` がある行。新しい表は作らない |
| T2 | 作業の状態は 未着手（todo）／作業中（doing）／待ち（blocked）／完了（done）の 4 つ。待ちは「先方の返事・支払を待っている」。案件の「停滞」とは別の軸 |
| T3 | 依頼の状態は振り分けの結果だけ。受付済は `handling` で「デイリーへ（direct）」「案件へ（matter）」に読み分ける。`intake_requests.done_at`・`assignee_staff_id` は使わない（作業に持つ） |
| T4 | 進み具合（受付→作成→送付→支払予定→支払）は保存せず、§8.2 のとおり文書と支払から導く。定型文書・その他は 受付→作成→送付 まで |
| T5 | 完了は自動で入る：支払まで済んだら `flow-notice` の定期実行が作業を完了にする（`task.done`）。手でも完了にできる。定型文書・その他は人が完了にする |
| T6 | 軽微に入れる種別は 検収書／利用許諾計算書／定型文書（当社ひな形の NDA など）／その他。支払の書類だけが対象の番号から条件を引き当てる |
| T7 | 迷ったら軽微で受けてよい。デイリータスクの「案件に移す」で、同じ行の `matter_id` を埋め、依頼の原票（Backlog・メール・資料）と繋いだ条件・文書を案件に付け、依頼を「案件へ」に切り替える |
| T8 | 発注書が案件に入っている検収書は、従来どおりその案件へ繋ぐほかは受けない（§8.1） |
| T10 | 文書本文の当社担当者（【ご連絡先】・検収者。`context.owner`）は 人が選んだ担当（`manual_inputs._ownerStaffId`。文書の画面の「当社担当者」欄）→ 案件の担当 → デイリータスクの作業の担当 の順。訂正版は元の版の案件と依頼（`intake_request_links`）を引き継ぐので、担当が替わった決定済みの計算書は 訂正版を出し直すか、欄で選び直せば入る |
| T9 | 文書を送るメールの下書き（`documents/mail-draft.ts`）は、案件の無い文書なら繋がっている依頼と作業から同じものを取る：宛先＝依頼の依頼者のメール（無ければ Slack の ID から社員を引く。案件も同じ）、cc＝作業の担当、`{案件番号}`＝依頼番号、`{案件名}`＝作業の件名、相手先＝依頼の相手先。依頼者のメールと件名はデイリータスクの詳細で直せる（`PATCH /tasks/:id` の `requesterEmail`・`title`）。デイリータスクから作った文書は自動で依頼に繋がる（`POST /documents` ほかの `requestId`） |
| T11 | 事業部側の担当者（依頼者）のメールは、受け付けるときに当てて依頼（`intake_requests.requester_email`）と案件（`matters.requester_email`）に残す（`intake/requester.ts`）：依頼のメール → Slack の ID から社員 → 名前が 1 人に決まる社員。受付箱の振り分けの「依頼者のメール」欄に当てた値を入れておき、人が上書きできる。あとからはデイリータスクの詳細（T9）で直す |
| T12 | デイリータスクから文書を作る動線は種別で決まっており、詳細の「文書を作る」に手順として出す：検収書＝条件明細（`conditions`）→ 回 → 検収書、利用許諾計算書＝作品の台帳（`works`）→ 計算書。定型文書・その他は 作品がある ライセンス・業務委託（条件書・契約書・発注書）＝作品の画面から、作品が無い 業務委託（発注書・検収書）＝条件明細の画面から、条件の無い定型文書（NDA など）＝文書の画面の当社ひな形、外で作る文書＝番号を先に取る／登録（T13）。作品・条件・台帳の画面へは作業を持って行き（`App.tsx` の `taskCtx`）、そこで起こした文書は案件が無ければ自動でその依頼に繋がる。画面の上に「作業 #n の文書を作っています」の帯を出し、「繋がずに作る」で外せる |
| T13 | 外で作る文書（取込文書）の番号は種別ごとの接頭辞（`documents/import-kinds.ts`：業務委託契約書 SVC・秘密保持契約書 NDA・発注書 EPO・発注請書 POA・検収書 EAC・覚書 MOU・念書 LOU・通知書 NTC・利用許諾契約書 LIC・その他 IMP）。法務がワンオフで作る文書は「番号を先に取る」（`POST /documents/reserve`）で番号だけの下書き（`template_version_id` NULL・`manual_inputs.reserved`）を作り、本文に番号を書き込んでから文書の詳細の「ファイルを付ける」（`POST /documents/:id/import-file`）で発行済みにする。使わない番号は破棄（void）。入口は 文書の画面・条件明細・案件・デイリータスク（依頼に繋がる） |
| T14 | 文書と DB の整合（進行画面の前段）：基本契約書の代表者欄は個人で代表者の登録が無ければ空（名称と二重に刷らない。`legacy-variables.ts`）。個別利用許諾条件書 V3 の構成要素は素材（`work_parts`）か作品名で行を立て、条件名は使わない。許諾範囲の文（`v3_scope`）に 許諾期間・自動更新・計算書の時期・支払条件・再許諾の承諾要否 を条件明細から書き、計算モデルは条件の計算方式から（`license-terms.ts`）。許諾セット（`/conditions/license-set`）は 構成要素・再許諾の可否・計算書の時期・支払条件・定額の行 を受ける。メールの下書きの当社担当者は 文書で選んだ担当（`_ownerStaffId`）→ 案件 → 作業 の順 |

### 10.2 データ（`infra/v3/004_amend.sql` A-064）

- `tasks`：`matter_id` を空にできる。`request_id`（元の依頼。1 依頼 1 行の一意索引）、`purpose`（inspection / royalty / template / other）、`done_at`・`done_by`、`created_by`・`created_at`・`updated_at`。`matter_id` か `request_id` のどちらかは要る（`tasks_owner_chk`）。
- 流したときに、受付済で `handling = 'direct'` の依頼から作業を 1 行ずつ起こす（`done_at` があれば完了）。
- `v_deadlines` は案件の無い作業も出す（参照番号は依頼番号）。

### 10.3 サーバー

- `tasks/repository.ts` … デイリータスクの一覧（やること／待ち／期限切れ／完了／すべて、担当で絞る）・件数・詳細（作業＋元の依頼の詳細）
- `tasks/write-service.ts` … 状態・担当・期日・件名の変更（案件の中の作業も同じ）、案件に移す
- `intake/request-service.ts` … `accept(mode: "direct")` が作業を起こす（`connectRequestToMatter` を受付と「案件に移す」で共用）
- `intake/progress-notice.ts` … 完了は作業の `done_at` を見る。支払まで済んだ作業を自動で完了にする

| メソッド | パス | 権限 |
|---|---|---|
| GET | `/api/v3/tasks?tab=open\|wait\|late\|done\|all&assignee=<staffId>` | 閲覧 |
| GET | `/api/v3/tasks/counts` ・ `/api/v3/tasks/:id` | 閲覧 |
| PATCH | `/api/v3/tasks/:id`（`status`・`title`・`assigneeStaffId`・`dueOn`） | admin / legal |
| POST | `/api/v3/tasks/:id/move`（`mode: "new" \| "existing"`、`matterId`・`kind`・`title`・`ownerStaffId`） | admin / legal |
| POST | `/api/v3/intake/:id/accept`（`mode: "direct"`、`purpose` に template / other が増えた） | admin / legal |

`/intake?state=direct` と `/intake/:id/assign` ・ `/done` ・ `/undone` は無くなった（作業テーブルへ）。

### 10.4 画面

- **デイリータスク**（`DailyTasksWorkspace.tsx`）：札（未着手・作業中・待ち・期限切れ・この 7 日の完了）、担当で絞る、一覧（期日・種別・件名・取引先・担当・状態・進み具合）、詳細（状態の切替、担当・期日、進み具合、条件・回・文書の繋ぎ、依頼者からの返信、案件に移す）。「文書を作る」は種別ごとの手順（T12）で、作品・条件・台帳の画面へ作業を持って行くか、その場で文書を起こす。
- **受付箱**（`IntakeWorkspace.tsx`）：「対応中」タブと対応のパネルを外し、振り分けの 2 択にした（§6）。
- **案件 › 作業**（`MatterTasks.tsx`）：案件の中の作業の一覧と状態の切替。「作業を追加」は従来のフォーム。
- **ホーム**：受付箱とデイリータスクの札。

### 10.5 開放

1. `004_amend.sql`（A-064）を流す。Studio なら `004_amend_studio.sql`。003（権限）も流し直す
2. 何も切り替えなくても使える。自動完了は既存の `flow-notice` の定期実行に乗る
