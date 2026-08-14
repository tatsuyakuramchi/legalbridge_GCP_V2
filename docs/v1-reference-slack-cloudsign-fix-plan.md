# LegalBridge V2 — V1実働実装を基準とした Slack / CloudSign 修正計画

## 1. 文書の位置付け

本書は、LegalBridge V2 の Slack 案件連携および CloudSign 署名依頼連携について、旧システム `LegalBridge_AI_GCP`（以下「V1」）で実際に稼働している実装を参照し、V2 の修正方針を再定義するものである。

対象リポジトリ:

- V1: `tatsuyakuramchi/LegalBridge_AI_GCP`
- V2: `tatsuyakuramchi/legalbridge_GCP_V2`

本書は、以下の既存計画に対する**優先度の高い補正・更新方針**として扱う。

- `docs/slack-matter-thread-history-fix-plan.md`
- `docs/cloudsign-delivery-troubleshooting-fix-plan.md`

実装時に本書と上記既存文書が矛盾する場合は、**V1 の実働挙動を確認した本書を優先する**。

---

## 2. 結論

今回の調査で、V1 には以下が既に実装され、運用実績があることを確認した。

### Slack

V1 には Matter 単位の Slack スレッド管理が存在する。

```text
Matter
  ↓
法務相談チャンネル
  ↓
matter_slack_threads
  ↓
root message
  ↓
thread_ts
  ↓
スレッド返信
  ↓
conversations.replies
  ↓
Matter画面へ表示
```

したがって V2 で Matter の Slack 履歴を実装する際、`lb_v2_slack_notification_history` を canonical thread として転用する新設計は採用しない。

**V1 の Matter Slack 機能を V2 のアーキテクチャへ移植する。**

一方、V2 が現在持つ requester 向け DM 通知・通知重複防止機能は別用途であるため残す。

### CloudSign

V1 の CloudSign 実装は、現在の V2 実装と HTTP request の組み立て方が複数箇所で異なる。

V1 は実環境で動作しているため、V2 の CloudSign 障害については IP 固定化等のインフラ変更を先行させず、まず **V1 互換の HTTP 通信仕様へ修正する**。

特に以下を V1 と揃える。

- `/token` への `client_id` の渡し方
- `application/x-www-form-urlencoded` の利用
- PDF multipart field 名 `uploadfile`
- participant の form-urlencoded 送信
- token 有効期限管理
- 401 時の token 再取得
- CloudSign のエラー response body を保持する診断処理

---

# Part A — Slack 修正方針

## 3. V1 の実働構造

V1 の主要参照箇所:

- `services/worker/src/routes/matters.ts`
- `services/worker/server.ts`
- `migrations/0145_matter_slack_threads.sql`
- Matter 詳細 UI 関連実装

V1 では `matter_slack_threads` に案件と Slack thread の対応を保存する。

スキーマの要点は以下である。

```sql
CREATE TABLE IF NOT EXISTS matter_slack_threads (
  id          BIGSERIAL PRIMARY KEY,
  matter_id   INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  root_text   TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (matter_id)
);
```

これにより以下の不変条件を実現している。

> 1 Matter = 1 Slack root thread

V1 の Matter API は、概ね以下の処理を行う。

1. Matter に既存 Slack thread があるか確認
2. 無ければ法務相談チャンネルへ root message を投稿
3. `channel_id` と `thread_ts` を `matter_slack_threads` に保存
4. 以後の投稿は `thread_ts` を付けて同一スレッドへ送信
5. Matter 画面の履歴取得時は `conversations.replies` を利用

この構造は、案件単位の法務コミュニケーションとして V2 にも適合する。

---

## 4. V2 の現状との違い

現在の V2 の Slack adapter は主として requester 向け通知用途であり、以下のみを扱う。

```text
conversations.open
chat.postMessage
```

現在の構造:

```text
LegalBridge notification
  ↓
requester Slack user ID
  ↓
conversations.open
  ↓
DM channel
  ↓
chat.postMessage
```

この実装には Matter の canonical thread 概念がない。

また、`lb_v2_slack_notification_history` は以下の目的を担っている。

- 通知重複防止
- fingerprint / idempotency
- requester status
- Slack delivery receipt の記録

したがって、以下の2系統を明確に分離する。

### A. Matter Communication

法務担当者が Matter を中心に会話する機能。

```text
Matter
  └─ matter_slack_threads
       ├─ channel_id
       └─ thread_ts
```

### B. Requester Notification

依頼者への通知機能。

```text
Issue / Matter status
  └─ lb_v2_slack_notification_history
       ├─ fingerprint
       ├─ requester_status
       ├─ slack_channel_id
       └─ slack_message_ts
```

両者は統合しない。

---

## 5. Slack の修正後アーキテクチャ

```text
                         ┌──────────────────────────┐
                         │          Matter          │
                         └────────────┬─────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
       Matter Communication                   Requester Notification
                    │                                   │
                    ▼                                   ▼
       matter_slack_threads              lb_v2_slack_notification_history
                    │                                   │
          ┌─────────┴─────────┐                         │
          ▼                   ▼                         ▼
     channel_id           thread_ts             requester DM / notice
          │                   │
          └─────────┬─────────┘
                    ▼
          conversations.replies
                    │
                    ▼
             Matter Detail UI
```

---

## 6. DB 方針

### 6.1 最初に本番 DB の存在確認を行う

V1 では `migrations/0145_matter_slack_threads.sql` により `matter_slack_threads` が導入されている。

V2 が同一系統の本番 DB を参照している場合、テーブルが既に存在する可能性がある。

実装前に以下を確認する。

```sql
SELECT to_regclass('public.matter_slack_threads');
```

結果が存在する場合:

- 新しい migration は作らない
- V2 から既存テーブルを利用する

結果が存在しない場合:

- V1 の `0145_matter_slack_threads.sql` を基準に additive / idempotent migration を V2 へ移植
- 既存テーブルや既存データの破壊的変更は行わない

### 6.2 `lb_v2_slack_notification_history` は変更しない

通知履歴テーブルは現在の requester notification 用途を維持する。

Matter thread anchor をここへ寄せない。

---

## 7. V2 Slack 実装項目

### 7.1 Slack client を read/write 両対応へ拡張

現在の `SlackWebApiClient` の用途を壊さず、Matter communication 用に以下を利用可能にする。

```text
chat.postMessage
conversations.replies
```

必要に応じて既存 client interface を拡張するか、Matter 専用 reader/writer adapter を分離する。

推奨は、低レベル Slack Web API client を共通化し、用途別 adapter を分離する方式である。

```text
SlackWebApiClient
  ├─ SlackNotificationDeliveryAdapter
  └─ MatterSlackConversationAdapter
```

### 7.2 Matter thread repository を追加

責務:

- `matter_id` から thread anchor を取得
- root thread を登録
- 1 Matter = 1 thread を保証

概念 interface:

```ts
interface MatterSlackThreadRepository {
  findByMatterId(matterId: number): Promise<MatterSlackThread | null>;
  create(input: {
    matterId: number;
    channelId: string;
    threadTs: string;
    rootText?: string;
    createdBy?: string;
  }): Promise<MatterSlackThread>;
}
```

### 7.3 Matter Slack API

V1 の挙動を V2 API 命名へ整理して実装する。

推奨:

```text
POST /api/v2/matters/:id/slack/thread
GET  /api/v2/matters/:id/slack
POST /api/v2/matters/:id/slack/messages
```

#### POST `/slack/thread`

- 既存 thread があればその anchor を返す
- 無ければ root message を投稿
- `matter_slack_threads` に保存
- concurrent request でも UNIQUE matter_id により複数 root を作らないよう処理

#### GET `/slack`

- thread anchor を取得
- `conversations.replies(channel, ts)` を実行
- Slack 障害時も Matter 本体 API は失敗させない

返却例:

```json
{
  "enabled": true,
  "thread": {
    "channelId": "C...",
    "threadTs": "..."
  },
  "messages": [
    {
      "ts": "...",
      "user": "U...",
      "text": "...",
      "bot": false
    }
  ]
}
```

#### POST `/slack/messages`

- `matter_slack_threads.thread_ts` を必ず利用
- root 外への独立投稿を行わない

### 7.4 Matter UI

Matter Detail に以下を追加する。

- Slack thread 未作成状態
- 「Slackスレッドを作成」
- thread message 一覧
- message 投稿欄
- 再読み込み
- Slack disabled / permission error / API error の状態表示

ポーリングは初期実装では行わない。

Matter 画面表示時の fetch + 明示的 refresh を基本とする。

---

## 8. Slack legacy データ

修正前の V2 requester DM 通知を Matter thread へ強制的に再構成しない。

既存 DM 通知は `lb_v2_slack_notification_history` に残す。

Matter communication は V1 と同様、`matter_slack_threads` 作成後から canonical thread として管理する。

これにより「過去に送った複数 DM を、あたかも同一 Matter thread だったかのように見せる」誤表示を避ける。

---

# Part B — CloudSign 修正方針

## 9. V1 の実働 CloudSign client

主要参照箇所:

- `services/worker/src/services/cloudSignService.ts`
- `services/worker/server.ts`

V1 の基本フローは以下である。

```text
POST /token
  ↓
POST /documents
  ↓
POST /documents/{id}/files
  ↓
POST /documents/{id}/participants
  ↓
POST /documents/{id}
```

処理順自体は V2 と近い。

問題は各 HTTP request の形式とエラー処理に差があることである。

---

## 10. V1 / V2 CloudSign 差分

| 項目 | V1 実働実装 | 現在の V2 |
|---|---|---|
| token | `POST /token` + form-urlencoded body | `POST /token?client_id=...` |
| client_id | request body | query parameter |
| token cache | `expires_in` を見て期限管理 | 取得後固定 cache |
| 401 | token破棄後1回 retry | retryなし |
| create document | form-urlencoded | JSON |
| add file | multipart field `uploadfile` | multipart field `files` |
| participant | form-urlencoded | JSON |
| participant fields | email/name/organization/order/language_code | email/name/organization |
| API error | status/method/path/response body を保持 | HTTP status 中心で upstream body を破棄 |

この差分を解消することを CloudSign 修正の第一優先とする。

---

## 11. CloudSign 修正原則

### 原則1 — V1 の実働 wire format を baseline とする

V2 の adapter / interface / capability gate は維持するが、CloudSign への実 HTTP request は V1 の実働仕様へ合わせる。

### 原則2 — IP 制限対応を先行しない

現在の障害メッセージに「アドレス」が含まれることだけを理由に、Cloud NAT / static outbound IP を先行導入しない。

先に V1 互換 request へ修正し、CloudSign が返す raw error message を安全に取得する。

その上で CloudSign が明示的に IP restriction を返した場合のみ、ネットワーク構成変更を検討する。

### 原則3 — V2 の安全機構は維持する

以下はそのまま残す。

- Admin 権限制御
- dispatch gate
- validation-only / guarded-write 方針
- document rendering
- request audit / integration history
- status import

V1 を丸ごとコピーするのではなく、**CloudSign の transport 実装を V1 互換へ差し替える**。

---

## 12. CloudSign HTTP client 修正

対象:

`apps/legalbridge/src/server/integrations/cloudsign-api-adapter.ts`

### 12.1 token

V1 と同様に form-urlencoded body を利用する。

```ts
const body = new URLSearchParams({ client_id: this.clientId });

await fetch(`${baseUrl}/token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body
});
```

取得した以下を保持する。

```text
access_token
expires_in
```

期限の少し前に cache を失効させる。

### 12.2 401 retry

認証済 API が 401 を返した場合のみ、以下を1回実施する。

```text
cached token discard
  ↓
/token 再取得
  ↓
同一API call を1回だけ retry
```

無制限 retry は行わない。

### 12.3 document create

V1 と同じ form-urlencoded を baseline とする。

```text
Content-Type: application/x-www-form-urlencoded
```

### 12.4 file upload

multipart field 名を V1 と同じ `uploadfile` へ修正する。

```ts
form.append("uploadfile", pdfBlob, filename);
```

現在 V2 の `files` field は V1 の実働実装と一致していないため、優先修正対象とする。

### 12.5 participant

V1 と同様に form-urlencoded で追加する。

対応項目:

```text
email
name
organization
order
language_code
```

V2 の domain model に `order` / `languageCode` がまだ不要であれば optional とし、既存の単一 participant 利用を壊さない。

---

## 13. CloudSign error handling

V1 では Axios error から以下を取得して診断可能な Error へ変換している。

- HTTP status
- HTTP method
- endpoint path
- CloudSign response body

V2 でも同等以上の observability を持たせる。

### 13.1 upstream response を捨てない

現状のような以下のみの error 化は廃止する。

```text
CloudSign API HTTP error: 400
```

代わりに server-side では以下を保持する。

```ts
{
  status,
  method,
  path,
  upstreamCode,
  upstreamMessage,
  retryable
}
```

access token / client_id / Authorization header は絶対にログへ含めない。

### 13.2 UI 向けには安全に正規化する

UI へ raw response 全文を返さない。

分類例:

```text
CLOUDSIGN_AUTHENTICATION_FAILED
CLOUDSIGN_PARTICIPANT_REJECTED
CLOUDSIGN_IP_RESTRICTED
CLOUDSIGN_INVALID_REQUEST
CLOUDSIGN_RATE_LIMITED
CLOUDSIGN_UPSTREAM_ERROR
```

UI はユーザーが対応可能なメッセージを表示する。

---

## 14. 「許可されていないアドレス」障害の診断順序

修正後は以下の順序で診断する。

```text
1. V1互換 HTTP request へ修正
   ↓
2. upstream error body を保持
   ↓
3. write-test 環境で実送信
   ↓
4. CloudSign の実エラーを分類
   ↓
5a. participant/email error → 入力・宛先条件を修正
5b. auth error              → client_id / token を修正
5c. IP restriction          → static outbound IP を検討
5d. request parameter       → request mapping を修正
```

### IP restriction が確認された場合のみ

その場合は別途以下を実施する。

```text
Cloud Run
  ↓
Direct VPC egress
  ↓
Cloud NAT
  ↓
Reserved static external IP
  ↓
CloudSign allowlist
```

ただし `all-traffic` routing を利用すると CloudSign 以外の外部連携にも影響するため、Slack / Google APIs / その他 integrations の smoke test を必須とする。

---

# Part C — 実装順序

## 15. Slice 1 — CloudSign transport を V1 互換化

対象:

- `cloudsign-api-adapter.ts`
- CloudSign client tests

実施:

1. token を form-urlencoded 化
2. expires_in cache
3. 401 one-time retry
4. create document を form-urlencoded 化
5. upload field を `uploadfile` 化
6. participant を form-urlencoded 化
7. upstream error body の保持

この Slice が CloudSign 障害修正の最優先である。

---

## 16. Slice 2 — CloudSign route / UI error 表示

対象:

- `cloudsign-adapter.ts`
- `cloudsign-routes.ts`
- `DocumentIntegrations.tsx`

実施:

- structured CloudSign error
- route での safe mapping
- UI 原因別表示
- retryable / non-retryable の区別

---

## 17. Slice 3 — Matter Slack backend を V1 から移植

実施:

1. `matter_slack_threads` 存在確認
2. 必要時のみ V1 migration 移植
3. Matter thread repository
4. Matter Slack conversation adapter
5. root thread create
6. `thread_ts` reply
7. `conversations.replies`
8. permission / error isolation

既存 requester DM adapter は変更最小限に留める。

---

## 18. Slice 4 — Matter UI Slack panel

実施:

- thread 未作成表示
- root thread 作成
- messages load
- reply 投稿
- manual refresh
- disabled / error state

Matter 本体表示と Slack API failure を分離する。

---

## 19. Slice 5 — 統合試験

### CloudSign

最低限以下を確認する。

- token 取得成功
- PDF attachment 成功
- participant 追加成功
- 署名依頼送信成功
- status 取得成功
- 401 再取得
- invalid participant の診断可能性
- upstream 400 の response message 保持
- token/client_id が log/UI に漏れない

### Slack

最低限以下を確認する。

- Matter ごとに root thread が1つだけ作成される
- 2回目以降の投稿が同じ `thread_ts` に入る
- `conversations.replies` で全返信を取得できる
- Matter UI に表示される
- requester DM notification が従来どおり送信できる
- Matter thread と requester DM history が混同されない
- Slack 障害でも Matter 詳細自体は表示できる

---

# Part D — 受入基準

## 20. Slack acceptance criteria

以下をすべて満たした場合に完了とする。

- [ ] Matter から法務相談 Slack thread を作成できる
- [ ] 1 Matter = 1 thread が保証される
- [ ] LegalBridge から thread へ返信できる
- [ ] Slack 側からの返信を Matter 画面で取得できる
- [ ] `conversations.replies` を利用している
- [ ] requester DM 通知機能が維持されている
- [ ] `lb_v2_slack_notification_history` を Matter thread anchor として流用していない
- [ ] Slack API failure が Matter 本体 API を巻き込まない

---

## 21. CloudSign acceptance criteria

- [ ] V1 と同等の token request 形式になっている
- [ ] `expires_in` に基づく token cache がある
- [ ] 401 のみ one-time token refresh/retry を行う
- [ ] document create が V1 互換 request になっている
- [ ] file upload field が `uploadfile` になっている
- [ ] participant request が V1 互換になっている
- [ ] CloudSign upstream error body を server-side で診断できる
- [ ] raw secret を UI / log に出さない
- [ ] V2 の admin / dispatch gate を維持する
- [ ] write-test から実際に署名依頼を送信できる
- [ ] 送信後の status import が継続動作する

---

# Part E — ロールバック

## 22. CloudSign

V2 adapter の transport 差し替えは feature/config gate 内で行う。

問題が出た場合:

- CloudSign live dispatch を disabled へ戻す
- DB の送信履歴は削除しない
- V1 互換 client commit を revert 可能にする

CloudSign 上で既に作成された draft / sent document を自動削除しない。

---

## 23. Slack

Matter Slack 機能は requester notification と分離するため、Matter Slack だけを無効化できる設計とする。

問題が出た場合:

- Matter Slack UI を非表示
- Matter Slack endpoint を disabled
- requester DM notification は維持
- `matter_slack_threads` の既存 anchor は削除しない

---

# Part F — 実装時の禁止事項

## 24. やらないこと

以下は本修正では行わない。

1. `lb_v2_slack_notification_history` を Matter conversation table に変質させる
2. 過去の requester DM を Matter canonical thread とみなす
3. CloudSign の原因確認前に Cloud NAT を導入する
4. CloudSign の raw error response 全文を UI に返す
5. access token / client_id / Authorization header をログに出す
6. final send を無条件に自動 retry する
7. Slack Matter 機能の障害で Matter 本体を利用不能にする
8. V1 のコードを構造ごと無条件コピーして V2 の capability gate を破壊する

---

## 25. 最終方針

今回の修正は「V2 に不足機能を新規設計する」のではなく、以下の考え方で進める。

> **外部連携の wire-level behavior と Matter Slack の業務ロジックは、実働実績のある V1 を reference implementation とする。**

> **V2 の価値である統合 UI、権限制御、capability gate、guarded write、監査性は維持する。**

整理すると以下となる。

```text
V1から継承するもの
  ├─ CloudSign 実HTTP通信仕様
  ├─ CloudSign token / 401 handling
  ├─ CloudSign diagnostic error handling の考え方
  ├─ Matter = Slack thread の構造
  ├─ matter_slack_threads
  └─ conversations.replies

V2で維持するもの
  ├─ unified Matter UI
  ├─ admin / legal 権限制御
  ├─ guarded write / dispatch gate
  ├─ requester notification history
  ├─ integration audit
  └─ status import / document workflow
```

この方針であれば、V1で既に動作確認された外部連携を再利用しつつ、V2のアーキテクチャを維持したまま修正できる。
