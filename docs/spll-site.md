# SPLL 公開サイト（クリエーター向け）

LegalBridge V2 のAPIサービス上に、SPLL（TRPG二次創作ライセンス）の**公開サイトのベース**を相乗りさせている。
SPLL本体はGoogle Apps Script上で動いているが、一般公開部分のアクセス集中耐性をGASから切り離す方針のため、
まず移植可能な形でこちらに置き、デモとして見せられる状態にした。

## 用語

| 呼称 | 指すもの |
|---|---|
| **クリエーター** | SPLLへ利用許諾を申請し、二次創作物を制作・頒布する側 |
| **ユーザー** | 社内で実際に業務を担当する側（LegalBridgeのログインユーザー） |

このサイトは**クリエーター向け**。LegalBridgeの管理UIとは独立したページとして配信する。

## 置き場所

```
apps/legalbridge/src/server/spll/
  routes.ts        ルーター（createSpllSiteRouter）
  views.ts         HTML描画（CSS込み・外部CDNへ依存しない）
  sample-data.ts   デモ用の原作・料金表・認証データ
  routes.test.ts   テスト
```

`createApp()` が `SPLL_SITE_BASE_PATH`（既定 `/spll`）へマウントする。

## URL

SPLL側の公開URL設計に合わせてある。

| パス | 内容 |
|---|---|
| `GET /spll/` | トップ（制度の説明・手続きの流れ・受付中の原作） |
| `GET /spll/works?q=` | 原作をさがす（作品名・権利者・利用できる要素で部分一致） |
| `GET /spll/works/:workId` | 原作詳細（利用できる要素／できないこと／クレジット表記／料金表） |
| `GET /spll/apply?work=` | 申込の流れ（デモでは契約作成へ進まない） |
| `GET /spll/verify` | 認証の確認（デモ用の認証一覧） |
| `GET /spll/v/:certificateId` | QR検証ページ。**認証バッジのQRが指す先** |
| `GET /spll/api/works?q=` | 公開データのJSON（読み取り専用） |
| `GET /spll/api/fees` | 料金表のJSON（読み取り専用） |

管理画面（LegalBridge）のサイドバー最下部に「SPLL 公開サイト ↗」のリンクを置いている。
`/api/v2/runtime` の `spllSite` を見て表示するので、サイトを無効にすればリンクも消える。

## 設定

| 環境変数 | 既定 | 内容 |
|---|---|---|
| `SPLL_SITE_ENABLED` | `true` | `false` でサイトごと無効（サイドバーのリンクも消える） |
| `SPLL_SITE_BASE_PATH` | `/spll` | マウント先。**ルート直下（`/`）には置かない**（SPAと業務APIまでこのルーターの404が拾うため、空指定時は `/spll` へ戻す） |
| `SPLL_SITE_PUBLIC` | `false` | `true` にすると、このパス配下だけIAPを通さず誰でも閲覧できる |

`SPLL_SITE_PUBLIC=true` は**SPLLサイトのパス配下だけ**を認証免除にする。
`/api/v2/**` をはじめ他のパスは従来どおり認証必須で、`/spll-admin` のような紛らわしい前方一致も対象外
（`/spll` 完全一致と `/spll/` 配下のみ）。テストで固定している。

## デモ段階の制約

- **データはサンプル**。DB・Sheets・外部サービスへ一切アクセスしない。原作3件・料金6区分・認証2件を
  `sample-data.ts` に持っている（値はSPLL側の初期シードと同じ）。
- **申込はできない**。契約の作成とクラウドサインへの引き渡しは行わない。全ページに注意書きを出している。
- `<meta name="robots" content="noindex">` を入れてある。

## 本番へ向けて

- 原作・料金は Sheets（`Works_Master` / `Fee_Schedule`）から public projection へ定期同期し、
  `sample-data.ts` の代わりに読む。一般アクセスのたびにSpreadsheetを読まない。
- 認証状態は SPLL 側の変更を即時反映する必要がある（QR検証の結果が変わるため）。
- **QRのドメイン**：認証バッジのQRは頒布物に印刷されて永続するので、`*.run.app` のような
  実行基盤のURLを埋め込まない。自社管理の独自ドメインを前段に置き、SPLL側の `PUBLIC_BASE_URL` に
  そのドメインを設定する（SPLL側は `https://（ドメイン）/v/{cert_id}?c={code}` を発行する）。
  **検証ページがそのドメインで開けるようになってから**設定すること。
