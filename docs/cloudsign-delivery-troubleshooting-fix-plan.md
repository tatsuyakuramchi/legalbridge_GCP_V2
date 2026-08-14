# LegalBridge V2 — CloudSign 署名依頼送信障害 修正方針

## 1. 目的

LegalBridge V2 から CloudSign へ署名依頼を送信する際に、

- 「許可されていないアドレス」等のエラーで送信できない
- 入力したメールアドレスが LegalBridge 上では妥当に見えるにもかかわらず CloudSign 側で拒否される
- CloudSign 側の具体的なエラー理由が LegalBridge 画面から分からない

という問題を、原因別に切り分けて診断できるようにし、その上で必要な修正を行う。

今回の最優先事項は、**CloudSign が返している具体的なエラー情報を LegalBridge が失わないこと**である。

現時点では、IP アドレス制限、宛先メールアドレス判定、認証・APIパラメータ等の異なる原因が、LegalBridge 側では同じような「CloudSign送信失敗」に見え得る。

---

## 2. 現状コードの確認結果

### 2.1 LegalBridge のメールアドレス検証は簡易形式チェックのみ

対象:

`apps/legalbridge/src/server/integrations/cloudsign-adapter.ts`

現在の検証は以下の正規表現で行われている。

```ts
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

したがって LegalBridge が確認しているのは、概ね以下のみである。

- `@` がある
- `@` の前後が空ではない
- ドメイン部に `.` がある
- 空白が含まれていない

一方、CloudSign 側は LegalBridge より厳しいメールアドレス判定を行う。

CloudSign 公式ヘルプでは、宛先追加時に「メールアドレスが無効です」となる原因として、少なくとも以下が案内されている。

- タイプミス
- ドメインの応答がない、またはメール受信用設定が確認できない
- CloudSign で利用できない形式
- `@` 直前やメールアドレス先頭のピリオド
- ローカル部でピリオドが連続
- CloudSign が受理しない記号を含む形式

したがって、

> LegalBridge の形式チェックを通過した = CloudSign が受理する

ではない。

### 2.2 CloudSign API の具体的なエラー本文を破棄している

対象:

`apps/legalbridge/src/server/integrations/cloudsign-api-adapter.ts`

現在の `authed()` はレスポンス JSON を読み込んでいるが、HTTP がエラーの場合は payload の内容を使用せず、以下のように例外化している。

```ts
if (!response.ok) {
  throw new CloudSignError(
    `CloudSign API HTTP error: ${response.status}`,
    "http_error",
    response.status
  );
}
```

これにより CloudSign API が、例えば

- IP 制限
- 宛先メール不正
- 書類状態不正
- 権限不足
- client_id / token 関連
- パラメータ不正

を区別できる情報を返していたとしても、LegalBridge 側では HTTP ステータスだけに潰れてしまう。

これは今回の原因特定を妨げる主要因である。

### 2.3 route 側で `CloudSignError` を分類していない

対象:

`apps/legalbridge/src/server/documents/cloudsign-routes.ts`

`dispatch` route では、

- Template version mismatch
- Zod validation error

のみ個別処理し、CloudSign API 由来のエラーは共通 error handler へ流している。

したがって UI に返せるエラーが、

- CloudSign の IP 制限
- CloudSign のメールアドレス拒否
- CloudSign 認証エラー
- CloudSign rate limit

などに分類されていない。

### 2.4 CloudSign API 呼出しフロー自体は概ね公式の典型順序と一致

現行 `CloudSignApiAdapter.requestSignature()` は、

```text
1. POST /documents
2. POST /documents/{documentID}/files
3. POST /documents/{documentID}/participants
4. POST /documents/{documentID}
```

の順で実行している。

CloudSign 公式の典型フローも、書類作成 → ファイル追加 → 宛先追加 → 書類送信を基本としているため、**呼出し順そのものが今回の第一原因とは考えにくい**。

ただし、429 / 5xx 等の一時的エラーに対する retry 制御は別途実装する。

---

## 3. 想定原因を2系統に分ける

今回ユーザーが見ている「アドレスが許可されない」というメッセージは、少なくとも以下の2系統を区別する必要がある。

### 系統A — IPアドレス制限

CloudSign のアクセス制限機能で IP アドレス制限が有効になっている場合、Web UI だけでなく Web API / 外部システム連携にも制限が適用される。

したがって CloudSign チーム側で許可 IP が設定されている状態で、LegalBridge を稼働させている Cloud Run の送信元 IP が許可リストに入っていなければ、CloudSign API は拒否され得る。

Cloud Run は通常の構成では外部接続時に静的な単一送信元 IP を保証しない。

この場合の解決策は、

```text
Cloud Run
  ↓ all outbound traffic
Direct VPC egress
  ↓
VPC
  ↓
Cloud NAT
  ↓
Reserved static external IP
  ↓
CloudSign API
```

とし、Cloud NAT に割り当てた静的外部 IP を CloudSign 側の許可 IP に登録することである。

ただし、**エラー本文を確認せずに先にネットワーク構成を変更しない**。

最初に CloudSign API が本当に IP 制限エラーを返しているかを確認する。

### 系統B — メールアドレス拒否

CloudSign の宛先追加 API がメールアドレスを拒否している場合は、Cloud Run の送信元 IP とは無関係である。

この場合は、以下を確認する。

```text
LegalBridge 形式検証
      ↓ pass
CloudSign participants API
      ↓
CloudSign 独自判定
      ↓ reject
```

CloudSign の判定理由を LegalBridge が受け取り、UI でユーザーへ返す。

LegalBridge 側で CloudSign の全検証ルールを複製しない。

CloudSign 固有ルールは今後変更される可能性があるため、LegalBridge は

- 明らかな入力ミスを事前検知
- CloudSign の最終判定を尊重
- CloudSign の拒否理由を分かりやすく表示

という責務分担にする。

---

## 4. 修正方針

### 4.1 `CloudSignError` を構造化する

現状:

```ts
export class CloudSignError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null
  ) {}
}
```

修正案:

```ts
export type CloudSignErrorKind =
  | "authentication"
  | "ip_restricted"
  | "participant_invalid"
  | "rate_limited"
  | "request_invalid"
  | "upstream_unavailable"
  | "invalid_response"
  | "unknown";

export class CloudSignError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
    readonly kind: CloudSignErrorKind = "unknown",
    readonly upstreamMessage: string | null = null,
    readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "CloudSignError";
  }
}
```

CloudSign の raw response 全体をクライアントへ返さず、Server 側で必要情報だけを正規化する。

### 4.2 CloudSign API のエラー payload を解析する

対象:

`cloudsign-api-adapter.ts`

現在の `authed()` を変更し、エラー時にも JSON / text body を取得して解析する。

概念:

```ts
const payload = await readCloudSignResponse(response);

if (!response.ok) {
  throw normalizeCloudSignError(response.status, payload);
}
```

`normalizeCloudSignError()` は、

- HTTP status
- CloudSign の error code
- `message`
- その他安全に利用可能なエラー識別子

を基に `CloudSignErrorKind` へ分類する。

### 4.3 API response を安全なエラー形式に統一する

CloudSign dispatch route で `CloudSignError` を捕捉し、LegalBridge UI 用の構造に変換する。

例:

```json
{
  "error": "CloudSignが署名者メールアドレスを受理しませんでした。",
  "code": "CLOUDSIGN_PARTICIPANT_REJECTED",
  "kind": "participant_invalid",
  "retryable": false,
  "detail": "CloudSignの宛先設定をご確認ください。"
}
```

IP 制限の場合:

```json
{
  "error": "CloudSignのIPアドレス制限により接続が拒否されました。",
  "code": "CLOUDSIGN_IP_RESTRICTED",
  "kind": "ip_restricted",
  "retryable": false,
  "detail": "LegalBridgeの送信元IPがCloudSignの許可リストに登録されているか確認してください。"
}
```

429 の場合:

```json
{
  "error": "CloudSign APIの利用上限に達しました。",
  "code": "CLOUDSIGN_RATE_LIMITED",
  "kind": "rate_limited",
  "retryable": true
}
```

### 4.4 UI は原因別メッセージを表示する

対象:

`apps/legalbridge/src/client/DocumentIntegrations.tsx`

現状は API から `error` が返ればそのまま表示するだけである。

修正後は `kind` / `code` を利用して、以下を区別する。

#### 宛先メール拒否

```text
CloudSignが署名者メールアドレスを受理しませんでした。
メールアドレスの入力、受信可能なドメインかどうかをご確認ください。
```

#### IP制限

```text
CloudSignのIPアドレス制限によりLegalBridgeからの接続が拒否されました。
管理者による接続設定が必要です。
```

#### 認証

```text
CloudSignの認証に失敗しました。
CloudSign連携設定を管理者が確認してください。
```

#### rate limit / 一時障害

```text
CloudSignが一時的に利用できません。
しばらくしてから再実行してください。
```

ユーザーに `client_id`、access token、raw stack trace 等は表示しない。

---

## 5. メールアドレスの事前検証

### 5.1 LegalBridge 側の検証を少し強化する

現在の単純 regex に加え、CloudSign 公式ヘルプで明示されている明らかな不正パターンは事前に弾いてよい。

例:

- 先頭 `.`
- `@` 直前の `.`
- ローカル部の連続 `..`
- 全角 `＠`
- 制御文字 / 改行

ただし、DNS / MX の live lookup は LegalBridge の送信前検証として必須化しない。

理由:

- 一時的な DNS 問題を恒久的不正と誤判定し得る
- CloudSign 自身が最終判定を行う
- LegalBridge 側が CloudSign の判定ロジックを複製すると仕様差異が生まれる

### 5.2 UI で入力値を正規化する

送信前に最低限以下を行う。

```text
trim
全角空白除去
前後空白除去
```

メールアドレス自体の大文字小文字は原則として入力値を保持しつつ、冪等キー等の比較では lowercase を利用してよい。

---

## 6. Retry 方針

retry はエラー種別を限定する。

### retry しない

- 400系の participant invalid
- IP restriction
- 認証 / 権限不足
- 書類状態不正
- request parameter invalid

これらは同じ request を繰り返しても改善しない可能性が高い。

### retry 候補

- 429
- 502
- 503
- 504
- network timeout / connection reset

最大回数を限定し、指数バックオフを使用する。

例:

```text
attempt 1
  ↓ failure
500ms
attempt 2
  ↓ failure
1500ms
attempt 3
  ↓ failure
stop
```

CloudSign の書類作成等は副作用を伴うため、無条件に POST を再送しない。

retry 対象は、

- token 取得
- GET status
- 冪等性または安全性を確認できる操作

を優先し、書類作成・宛先追加・送信の retry は各 API の副作用を確認した上で限定的に実施する。

既存 `idempotencyKey` は現在 CloudSign API へ送信されていないため、これだけで外部 API の重複作成防止が保証されているとは扱わない。

---

## 7. IP制限だった場合のインフラ修正

CloudSign の raw error から `ip_restricted` と確認できた場合のみ実施する。

### 7.1 目標構成

```text
legalbridge-v2-write-test
        │
        │ Direct VPC egress / all-traffic
        ▼
      VPC subnet
        │
        ▼
     Cloud NAT
        │
        ▼
Reserved static external IPv4
        │
        ▼
   api.cloudsign.jp
```

### 7.2 必要作業

1. LegalBridge 用 outbound subnet を確認 / 作成
2. 静的 external IP を reserve
3. Cloud Router を確認 / 作成
4. Cloud NAT を manual IP allocation で構成
5. `legalbridge-v2-write-test` を Direct VPC egress に接続
6. `--vpc-egress=all-traffic` 相当を設定
7. 外向き IP を確認
8. CloudSign 管理画面で当該静的 IP を許可
9. write-test で署名依頼を再検証
10. 問題なければ本番 service へ同方式を展開

### 7.3 注意

固定 IP 化は CloudSign だけでなく Cloud Run の全 outbound traffic に影響し得るため、

- Gmail API
- Slack API
- Backlog API
- Google APIs
- その他外部連携

の疎通も回帰確認する。

---

## 8. ログ・監査

CloudSign 障害を再現可能にするため、Server log に以下を残す。

### 記録する

- document id
- document number
- issue key
- CloudSign operation
  - token
  - create_document
  - add_file
  - add_participant
  - send_document
  - get_document
- HTTP status
- normalized error kind
- CloudSign error code（取得できる場合）
- retryable
- request correlation id
- 発生時刻

### 記録しない / マスクする

- access token
- client_id 全文
- PDF 本文
- CloudSign raw payload 全体
- participant の不要な個人情報

メールアドレスをログに記録する場合は、既存の個人情報ログポリシーに従いマスクを検討する。

---

## 9. 診断 endpoint / runtime 表示

実運用では「設定はONだが実際にCloudSignへ到達できない」状態を判別できるようにする。

`/api/v2/runtime` または管理診断画面に、少なくとも以下を表示できるようにする。

```json
{
  "cloudsign": {
    "configured": true,
    "mode": "live",
    "capability": true,
    "lastErrorKind": "ip_restricted"
  }
}
```

ただし、通常ユーザー向け runtime response へ機微情報を出さない。

`lastErrorKind` 等は admin / legal 専用診断 API へ分離してもよい。

---

## 10. テスト計画

### 10.1 `cloudsign-adapter.test.ts`

追加:

- 明らかな不正メール形式を拒否
- 正常な一般メール形式を許可
- CloudSign 独自判定が必要な形式は API 側判定に委ねる

### 10.2 `cloudsign-api-adapter.test.ts`

追加:

- 400 + participant message → `participant_invalid`
- 403 + IP restriction message → `ip_restricted`
- 401 / 403 auth → `authentication`
- 429 → `rate_limited`, retryable=true
- 5xx → `upstream_unavailable`
- 非 JSON error body を安全に処理
- token / confidential payload を error message に含めない

### 10.3 `cloudsign-routes.test.ts`

追加:

- participant rejection を 4xx + structured error で返す
- IP restriction を明示的 code で返す
- authentication error を一般ユーザー向けに秘匿化
- CloudSign raw payload を response に漏らさない
- Template mismatch / Zod 既存挙動を壊さない

### 10.4 Client

追加確認:

- participant invalid 表示
- IP restriction 表示
- auth error 表示
- rate limit 表示
- retry button の条件分岐
- submit 中の二重送信抑止

---

## 11. 実装スライス

### Slice 1 — エラー可視化【最優先】

対象:

```text
cloudsign-adapter.ts
cloudsign-api-adapter.ts
cloudsign-routes.ts
DocumentIntegrations.tsx
tests
```

実装:

- upstream error payload を取得
- `CloudSignErrorKind` 正規化
- safe API response
- UI 原因別表示

**受入条件**

CloudSign 側で送信が拒否された場合、少なくとも以下を区別できる。

```text
IP制限
メールアドレス拒否
認証
rate limit
その他400系
5xx
```

### Slice 2 — メール事前検証

- 明らかな不正パターンだけ事前拒否
- UI 正規化
- CloudSign 最終判定との責務を分離

**受入条件**

明白なタイプミスは CloudSign API 呼出し前にユーザーへ表示される。

### Slice 3 — transient error handling

- 429 / 5xx / network failure の分類
- GET / token 等、安全な範囲から retry
- POST の無条件 retry は禁止

**受入条件**

一時障害と恒久的入力エラーを混同しない。

### Slice 4 — 固定 outbound IP【必要な場合のみ】

前提:

CloudSign エラーが `ip_restricted` と確認されたこと。

実装:

- Direct VPC egress
- Cloud NAT
- reserved static external IP
- CloudSign allowlist

**受入条件**

Cloud Run から確認される外向き IP が固定され、CloudSign 側の許可 IP と一致する。

---

## 12. 今回変更しないもの

本修正計画の初期段階では以下を変更しない。

- DB テーブル構造
- document template
- CloudSign の既存 capability gate
- admin 限定の実送信制御
- PDF レンダリングパイプライン
- CloudSign status 取得 API の基本設計

---

## 13. 受入基準

以下を満たしたら CloudSign 送信障害修正を完了とする。

1. CloudSign API の error payload を HTTP status だけに潰さない
2. LegalBridge 内部で CloudSign error を正規化できる
3. UI で IP 制限と宛先メール拒否を区別できる
4. access token / client_id / raw payload を UI に漏らさない
5. CloudSign の明らかなメール形式不正を送信前に検知できる
6. retryable / non-retryable を区別できる
7. 同じ署名依頼を無制御に再送しない
8. IP 制限が原因の場合のみ固定 outbound IP を導入する
9. 固定 IP 導入時は Gmail / Slack / Backlog 等の外部連携も回帰確認する
10. typecheck / test / build が green

---

## 14. 参照資料

CloudSign 公式:

- Web API 利用ガイド  
  https://help.cloudsign.jp/ja/articles/2681259
- アクセス制限機能（IPアドレス制限機能）  
  https://help.cloudsign.jp/ja/articles/803542
- 「メールアドレスが無効です。」とエラーが表示される  
  https://help.cloudsign.jp/ja/articles/1355367

Google Cloud 公式:

- Cloud Run: Static outbound IP address  
  https://docs.cloud.google.com/run/docs/configuring/static-outbound-ip
- Cloud Run: Direct VPC egress  
  https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc

---

## 15. 結論

今回の障害は、現時点では「CloudSign が何を理由に拒否したかを LegalBridge が保持していない」ため、IP制限と宛先メールアドレス拒否を画面上で区別できないことが最大の問題である。

したがって、最初から Cloud Run のネットワーク構成を変更するのではなく、以下の順で進める。

```text
CloudSign raw error を取得
        ↓
安全に正規化
        ↓
原因を分類
   ┌────┴────┐
   ↓         ↓
IP制限      メール拒否等
   ↓         ↓
固定IP化     入力修正・理由表示
   └────┬────┘
        ↓
  再送・実地検証
```

この順序にすることで、不要なインフラ変更を避けつつ、CloudSign 側の実際の拒否理由に応じた修正を行える。