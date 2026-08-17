# LegalBridge V2 — 案件画面 Slack 履歴表示 修正方針

## 1. 目的

案件（Matter）画面で、その案件に関する Slack の通知・返信を時系列で確認できるようにする。

現行 V2 には Slack 通知送信・重複防止履歴・承認ゲートは存在するが、案件画面から Slack の会話履歴を読む一気通貫の経路がない。また、UX 上は「1案件 = 1 Slack スレッド」を前提としている一方、実送信では `thread_ts` を利用しておらず、通知ごとに独立した DM メッセージが生成される。

本修正では、既存 DB テーブル構造と document template を変更せず、既存の `lb_v2_slack_notification_history` に保存済みの `matter_id` / `slack_channel_id` / `slack_message_ts` をスレッドアンカーとして再利用する。

---

## 2. 現状の問題点

### 2.1 Matter 詳細 API に Slack 情報がない

`GET /api/v2/matters/:id` は以下のみを返している。

- matter
- issues
- tasks
- documents

`PgMatterRepository.find()` も `matter_overview_v`、`matter_issues`、`matter_tasks`、`documents` のみを参照し、Slack 関連情報を取得していない。

### 2.2 Matter UI に Slack 履歴表示処理がない

`MatterRegistry.tsx` の `Detail` 型および `MatterDetail` コンポーネントには Slack 履歴の型・fetch・描画がない。

したがって現状は「Slack データの取得失敗」ではなく、案件画面が Slack 会話履歴を要求していない状態である。

### 2.3 `slack-history-repository` は会話履歴ではない

`SlackNotificationHistoryRepository` は通知重複防止・冪等性管理用であり、現在の `list()` が返すのは主として以下である。

- issue_key
- fingerprint
- outcome
- recorded_at

一方、INSERT 時には以下も保存している。

- matter_id
- requester_status
- headline
- slack_channel_id
- slack_message_ts

このため、保存済み情報を Matter と Slack スレッドの接続情報として再利用できるが、現状 Repository API がそれを公開していない。

### 2.4 Slack Web API クライアントが送信専用

現在の `SlackWebApiClient` は以下のみを扱う。

- `conversations.open`
- `chat.postMessage`

会話取得用の `conversations.replies` / `conversations.history` は実装されていない。

### 2.5 「1案件 = 1 Slack スレッド」が実装されていない

`slack-ux.ts` では以下の delivery 設計が定義されている。

- 初回: `newRootMessage = true`
- 2回目以降: `useExistingMatterThread = true`

しかし `SlackDeliveryRequest` に `threadTs` 等がなく、`chat.postMessage` に `thread_ts` を渡していない。

結果として現状は、同一案件でも通知ごとに独立した root message が送信される。

---

## 3. 修正後の基本アーキテクチャ

```text
Matter
  │
  ├─ Backlog issues
  ├─ Tasks
  ├─ Documents
  │
  └─ Slack Communication
       │
       ├─ thread anchor
       │    ├─ channel_id
       │    └─ root_message_ts
       │
       ├─ LegalBridge notification
       ├─ requester reply
       ├─ LegalBridge follow-up
       └─ subsequent replies
```

原則を以下とする。

> **1 Matter = 1 canonical Slack thread**

ただし、修正前に送信された既存データには複数の独立 root message が存在し得るため、legacy message を破棄せず互換表示する。

---

## 4. 不変条件

本修正では以下を維持する。

1. **既存 DB テーブル構造を変更しない**
2. **document template を変更しない**
3. Slack 実送信は既存の guarded-write / approval / dispatch gate を維持する
4. Slack 履歴読取失敗が Matter 詳細本体の表示を失敗させない
5. Slack token / channel ID / message ts 等の内部情報は必要最小限だけ UI に露出する
6. Slack 会話履歴は初期実装では admin / legal のみ閲覧可能とする
7. requester 向け画面への Slack 生ログ開放は別途判断する

---

## 5. DB 利用方針 — スキーマ変更なし

### 5.1 既存テーブルをスレッドインデックスとして利用

`lb_v2_slack_notification_history` の以下を利用する。

```text
matter_id
issue_key
requester_status
outcome
slack_channel_id
slack_message_ts
recorded_at
```

新規テーブルは作らない。

### 5.2 canonical thread anchor の決定

Matter ごとに以下の優先順位で root thread を決定する。

1. `requester_status = 'intake'` かつ `outcome IN ('sent','acknowledged')` で、`slack_channel_id` / `slack_message_ts` が有効な最古レコード
2. 上記がなければ、有効な Slack receipt を持つ最古の送信レコード
3. 有効な receipt がなければ「Slack 未接続」

これにより、初回受付通知が存在する案件ではそれを root として再利用できる。

### 5.3 legacy root の扱い

現行方式で複数の独立 DM root が既に作られている場合、canonical root 以外を削除・書換えしない。

Repository は以下を返せるようにする。

```ts
interface MatterSlackAnchor {
  matterId: number;
  channelId: string;
  rootMessageTs: string;
  recordedAt: string;
  legacyRootCount: number;
}
```

UI では必要に応じて「旧方式の通知が別メッセージとして存在します」と表示する。

---

## 6. Repository 修正

対象:

`apps/legalbridge/src/server/integrations/slack-history-repository.ts`

既存の通知重複判定用 `list(issueKeys)` は変更せず、新たに Matter 向け read API を追加する。

例:

```ts
export interface MatterSlackThreadAnchor {
  matterId: number;
  issueKey: string;
  channelId: string;
  rootMessageTs: string;
  recordedAt: string;
  legacyRootCount: number;
}

export interface SlackNotificationHistoryRepository {
  list(issueKeys: string[]): Promise<NotificationHistoryRecord[]>;
  append(entry: NotificationHistoryAppend): Promise<void>;
  findMatterThreadAnchor(matterId: number): Promise<MatterSlackThreadAnchor | null>;
  listMatterDeliveries(matterId: number): Promise<MatterSlackDeliveryRecord[]>;
}
```

既存の deduplication API と案件履歴用 API を分離し、用途混同を防ぐ。

---

## 7. Slack Web API 読取 Adapter

### 7.1 クライアント責務を分離

送信 Adapter に会話読取を直接混在させず、以下を追加する。

```ts
interface SlackConversationReader {
  configured: boolean;
  getThread(channelId: string, rootMessageTs: string): Promise<SlackThread>;
}
```

実装例:

```text
SlackConversationReader
 └─ SlackWebApiConversationReader
      └─ conversations.replies
```

### 7.2 使用 API

DM の案件スレッド取得は原則として `conversations.replies` を使用する。

Slack 公式仕様では、DM の thread 取得に Bot token + `im:history` scope を利用できる。

参考:

- https://api.slack.com/methods/conversations.replies
- https://api.slack.com/scopes/im%3Ahistory

### 7.3 レート制御

Slack の `conversations.replies` は利用形態によって厳しい rate limit が適用されるため、案件一覧表示中の自動ポーリングは禁止する。

初期実装は以下とする。

- Matter 詳細を開いた時だけ取得
- 明示的な「Slack履歴を更新」ボタンで再取得
- 同一案件について短時間の連続取得を抑止
- 429 の場合は Slack パネルだけエラー表示
- Matter 本体は正常表示を継続

将来リアルタイム性が必要になった場合は Events API / Webhook 型の同期を別フェーズで検討する。

---

## 8. Slack 送信を「1案件 = 1スレッド」に修正

### 8.1 Delivery request の拡張

`SlackDeliveryRequest` に既存 thread 情報を追加する。

```ts
export interface SlackDeliveryRequest {
  userId: string;
  idempotencyKey: string;
  issueKey: string;
  headline: string;
  body: string;
  nextAction: string;
  actions: SlackAction[];

  channelId?: string | null;
  rootThreadTs?: string | null;
}
```

### 8.2 初回通知

canonical anchor がない場合:

```text
conversations.open
  ↓
chat.postMessage
  channel = DM channel
  thread_ts = なし
  ↓
receipt.channelId / receipt.messageTs を history に保存
```

この `messageTs` が root thread ts になる。

### 8.3 2回目以降

canonical anchor がある場合:

```text
chat.postMessage
  channel   = stored channel_id
  thread_ts = stored root_message_ts
```

これにより、案件の後続通知はすべて同一 Slack thread に集約される。

### 8.4 recipient 変更時

Matter の requester が途中で変更され、既存 DM channel と recipient が一致しない可能性がある場合は fail-closed とする。

自動的に別ユーザーへ既存スレッドを流用しない。

必要な場合は新 recipient に新 root を作成し、旧 thread を legacy として保持する。

---

## 9. Matter Slack API を独立させる

Matter 詳細 API 本体に Slack API 呼出しを混ぜない。

新規 endpoint:

```http
GET /api/v2/matters/:id/slack
```

理由:

- Slack API 障害で Matter 詳細全体を落とさない
- Slack rate limit の影響を隔離できる
- UI 側で skeleton / retry を独立管理できる
- 将来的に Slack 以外の communication channel を追加しやすい

レスポンス例:

```json
{
  "configured": true,
  "linked": true,
  "matterId": 123,
  "thread": {
    "channelId": "D...",
    "rootMessageTs": "178...",
    "legacyRootCount": 2
  },
  "messages": [
    {
      "ts": "178...",
      "authorType": "legalbridge",
      "authorId": null,
      "text": "法務依頼を受け付けました",
      "isRoot": true
    },
    {
      "ts": "178...",
      "authorType": "user",
      "authorId": "U...",
      "text": "確認しました",
      "isRoot": false
    }
  ],
  "fetchedAt": "2026-08-14T00:00:00.000Z"
}
```

### エラー時

Slack 側だけ利用できない場合も HTTP 500 で Matter 全体を壊さず、Slack endpoint が明示的な状態を返す。

例:

```json
{
  "configured": true,
  "linked": true,
  "available": false,
  "reason": "rate_limited",
  "messages": []
}
```

認証・権限エラーは通常の 401 / 403 を維持する。

---

## 10. 認証・権限

初期実装では Slack 生ログは以下に限定する。

```text
admin
legal
```

requester ロールには直接表示しない。

理由:

- DM は requester 固有の通信情報を含む
- Matter と Slack recipient の完全一致確認が未実装
- 誤紐付け時の情報漏えいリスクを避ける

将来 requester に表示する場合は、Matter requester identity と Slack user ID の一致を必須条件とする。

---

## 11. Slack OAuth / 設定

現行送信では主として以下が必要になる。

```text
chat:write
im:write
```

DM thread の読取には追加で以下を使用する。

```text
im:history
```

**注意（2026-08-17 追記）**: 本計画の対象は「依頼者DMのスレッド履歴」であり、
**案件 Slack パネル**（`matter_slack_threads`・法務相談チャンネルへのルート投稿）は別機能。
後者は公開チャンネルを読むため **`channels:history`** が必要で、`im:history` では
`missing_scope` になる。実データは 24 件すべてチャンネル（`channel_id` が `C` 始まり）。

scope 追加後は Slack App の再インストールまたは権限再承認が必要になる場合があるため、本番有効化手順に含める。

config では既存の通知重複防止フラグと会話読取を明確に分離する。

例:

```text
SLACK_NOTIFICATION_HISTORY_ENABLED=true
SLACK_CONVERSATION_READ_MODE=disabled|live
```

意味:

- `SLACK_NOTIFICATION_HISTORY_ENABLED`: DB 上の送信履歴・重複防止
- `SLACK_CONVERSATION_READ_MODE`: Slack Web API からの会話読取

名称を分離し、「history」の意味の混同を防止する。

---

## 12. UI 修正

対象:

`apps/legalbridge/src/client/MatterRegistry.tsx`

Matter 詳細に以下を追加する。

```text
関連課題
次アクション・タスク
関連文書
コミュニケーション
  └ Slack
備考
```

### Slack パネル状態

#### 未接続

```text
Slack
この案件には Slack スレッドがまだありません。
```

#### 読取機能 OFF

```text
Slack
Slack 履歴参照は現在無効です。
```

#### 読込中

Slack section 内だけ skeleton を表示する。

#### 正常

時系列表示:

```text
LegalBridge   8/14 10:15
法務依頼を受け付けました。

依頼者        8/14 10:20
追加資料をアップロードしました。

LegalBridge   8/14 11:02
確認しました。法務部で審査を開始します。
```

#### エラー

```text
Slack履歴を取得できませんでした。
[再試行]
```

Matter 詳細本体はそのまま利用できる状態を維持する。

### legacy 通知

複数 root が存在する場合:

```text
旧方式で送信された通知が 2 件あります。
```

初期リリースでは canonical thread を優先表示し、legacy root の全文統合は必須としない。

---

## 13. メッセージ正規化

Slack API の raw payload をそのまま client に返さない。

Server で以下に正規化する。

```ts
interface MatterSlackMessage {
  ts: string;
  authorType: "legalbridge" | "user" | "unknown";
  authorId: string | null;
  text: string;
  isRoot: boolean;
}
```

初期実装では `users.info` を呼ばず、追加 OAuth scope を増やさない。

表示名が必要になった場合は次フェーズで `users:read` の追加可否を判断する。

staff に保存済みの `slack_user_id` と一致する場合のみ、既存 staff master から表示名を補完する方式は検討可能。

---

## 14. キャッシュ方針

Slack API の rate limit を考慮し、最低限のサーバー側短期キャッシュを推奨する。

初期案:

```text
key: matterId + rootThreadTs
TTL: 30〜60秒
```

ただし Cloud Run のインメモリキャッシュは instance 単位となるため、厳密な共有キャッシュとはしない。

Phase 1 では「連打抑止」が目的であり、Redis 等の新規基盤は導入しない。

---

## 15. テスト計画

### 15.1 Repository

追加:

`slack-history-repository.test.ts`

確認項目:

- intake root が優先される
- intake がない場合は最古の valid delivery を採用する
- channel / ts 欠落レコードを除外する
- legacyRootCount が正しい
- Matter 間で履歴が混ざらない
- 既存 deduplication `list()` の挙動を壊さない

### 15.2 Slack Conversation Reader

新規:

```text
slack-conversation-reader.test.ts
```

確認項目:

- `conversations.replies` の channel / ts が正しい
- Slack API error を型付きエラーへ変換
- `ratelimited` / HTTP 429 を識別
- 不正な channel ID / ts を事前拒否
- raw blocks を client に漏らさず正規化

### 15.3 Delivery Adapter

既存:

`slack-web-api-adapter.test.ts`

追加確認:

- 初回送信は `thread_ts` なし
- 既存 anchor があれば `thread_ts=rootMessageTs`
- 既存 channelId があれば不要な `conversations.open` をしない
- recipient mismatch を fail-closed

### 15.4 Matter Slack Route

新規:

```text
matters/slack-routes.test.ts
```

確認項目:

- admin/legal は閲覧可能
- requester は 403
- Matter not found は 404
- anchor なしは linked=false
- Slack reader disabled は configured=false
- Slack rate limit 時も構造化レスポンス
- Matter API 本体に影響しない

### 15.5 Client

確認項目:

- Matter 選択時のみ Slack fetch
- Matter 切替時に旧案件のレスポンスを表示しない
- loading / empty / disabled / error / success の全状態
- 再試行ボタン
- Slack エラーでも課題・タスク・文書を表示できる

---

## 16. 実装ファイル候補

### 修正

```text
apps/legalbridge/src/server/integrations/slack-history-repository.ts
apps/legalbridge/src/server/integrations/slack-delivery-adapter.ts
apps/legalbridge/src/server/integrations/slack-web-api-adapter.ts
apps/legalbridge/src/server/config.ts
apps/legalbridge/src/server/app.ts
apps/legalbridge/src/client/MatterRegistry.tsx
apps/legalbridge/src/client/styles.css
```

### 新規

```text
apps/legalbridge/src/server/integrations/slack-conversation-reader.ts
apps/legalbridge/src/server/matters/slack-routes.ts
apps/legalbridge/src/server/integrations/slack-conversation-reader.test.ts
apps/legalbridge/src/server/matters/slack-routes.test.ts
```

必要に応じて既存 Slack テストを拡張する。

---

## 17. 実装順序

### Slice 1 — Matter ↔ Slack anchor

- Repository に Matter thread anchor 取得を追加
- DB schema 変更なし
- unit test

**受入条件**

Matter ID から canonical Slack channel / root ts を取得できる。

### Slice 2 — Slack thread read

- `SlackConversationReader`
- `conversations.replies`
- `im:history` 前提
- rate limit / API error handling

**受入条件**

channel + root ts から thread を正規化取得できる。

### Slice 3 — Matter Slack API

- `GET /matters/:id/slack`
- admin/legal only
- Slack 障害の隔離

**受入条件**

Matter detail と独立して Slack thread を取得できる。

### Slice 4 — Matter UI

- Communication / Slack section
- async load
- retry
- legacy notice

**受入条件**

案件画面から Slack の会話を時系列確認できる。

### Slice 5 — 1案件1スレッド送信

- Delivery request に thread anchor
- `chat.postMessage.thread_ts`
- canonical root 再利用
- recipient mismatch guard

**受入条件**

同一案件の2回目以降の通知が新規 root ではなく既存 thread に投稿される。

### Slice 6 — 実地検証・有効化

- Slack App に `im:history` を追加
- App 再承認
- write-test で実案件相当の DM 検証
- rate limit / permissions / token 動作確認
- 本番 feature flag 有効化

---

## 18. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 既存案件に複数 root がある | 履歴が分散 | canonical root + legacy count で互換維持 |
| Slack API rate limit | 履歴取得不可 | 自動 polling 禁止、短期キャッシュ、手動更新 |
| `im:history` 未付与 | 403 / missing_scope | read mode を disabled のまま保持し実地確認後に有効化 |
| requester 変更 | 誤送信 | recipient mismatch は fail-closed |
| Slack 障害 | Matter 表示まで失敗 | Slack API を独立 endpoint 化 |
| DM 情報漏えい | 高 | 初期は admin/legal only |
| token 不備 | Slack read unavailable | runtime diagnostics に read capability を明示 |

---

## 19. 受入基準

以下をすべて満たした時点で完了とする。

1. 案件詳細に「コミュニケーション > Slack」が表示される
2. Matter に紐づく Slack root を既存 DB から取得できる
3. Slack thread の root + replies を時系列表示できる
4. Slack 履歴取得失敗でも Matter 本体は正常表示される
5. 2回目以降の通知は既存 Matter thread に投稿される
6. 既存 deduplication / approval / dispatch gate を壊さない
7. DB schema / document template を変更しない
8. requester mismatch 時に自動送信しない
9. admin/legal 以外は Slack 生ログを閲覧できない
10. typecheck / test / build が green

---

## 20. 今回の結論

今回の問題は表示コンポーネント単体の不具合ではなく、以下の接続が欠けていることが原因である。

```text
Matter
 ↓
Slack delivery receipt
 ↓
Slack canonical thread
 ↓
Slack Web API read
 ↓
Matter Communication UI
```

したがって、単に `slack-history-repository.list()` の値を画面へ出す修正は行わない。

既存の通知履歴テーブルを Matter ↔ Slack thread のアンカーとして再利用し、Slack 会話取得 API を独立させたうえで、送信側も `thread_ts` を使うよう統一する。

これにより、DB 構造を変えずに **「1案件 = 1 Slack スレッド」** を実装し、案件画面を法務対応のコミュニケーションハブとして機能させる。
