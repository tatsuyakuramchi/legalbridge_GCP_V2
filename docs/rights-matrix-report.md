# 許諾地域・許諾言語レポート（rights_matrix_report）

作品の「地域×言語」の表（ライセンスマトリクス）を **A4 横の紙（HTML・PDF）** にする帳票。
画面と同じ集計・同じ絞り込みをそのまま刷る。

- 画面: 作品台帳 → 作品の「地域×言語」タブ → 表の下の「レポート（印刷・PDF）」／
  作品台帳 → 「地域×言語の一覧」→ 表の下の「レポート（印刷・PDF）」
- ひな形: `infra/v3/templates/rights_matrix_report.html`（登録 SQL は `infra/v3/204_rights_matrix_report.sql`。`node infra/v3/tools/make-template-sql.mjs` で作り直す）
- 組み立て: `apps/legalbridge-v3/src/server/works/rights-matrix-report.ts`（画面の表 → ひな形の値、読み込みと描画）。集計そのものは画面と同じ `rights-matrix.ts`・`rights-matrix-overview.ts`
- 既定の本文: `apps/legalbridge-v3/src/server/works/rights-matrix-report-template.ts`（DB に未登録でも描ける。`rights-matrix-report.test.ts` が templates/ との食い違いを止める）
- 画面の部品: `apps/legalbridge-v3/src/client/RightsMatrixReport.tsx`（備考 → プレビュー／PDF）

## API

| 経路 | 内容 |
|---|---|
| `GET /api/v3/works/:id/rights-matrix/report/html` | 作品 1 点のプレビュー |
| `GET /api/v3/works/:id/rights-matrix/report/pdf` | 作品 1 点の PDF |
| `GET /api/v3/works-rights-matrix/report/html` | 作品をまたぐ一覧のプレビュー |
| `GET /api/v3/works-rights-matrix/report/pdf` | 作品をまたぐ一覧の PDF |

引数は画面の表と同じ。

- 作品 1 点: `ended`（`1` で終わった許諾も載せる）、`party`（取引先 id。その取引先の無いマスを薄く出し、許諾の一覧をその取引先だけにする）
- 作品をまたぐ一覧: `region`・`q`・`category`・`party`・`show`・`ended`（`GET /works-rights-matrix` と同じ）
- どちらも `remarks`（備考。表の下に出る。2000 字まで）

## 1 通のひな形で 2 つの形

| 形 | 行 | 列 | 段 |
|---|---|---|---|
| 作品 1 点（`isWork`） | 許諾地域 | 許諾言語 | 概要 → 要確認（ぶつかり・範囲外の一覧） → 地域×言語の表 → 凡例 → 許諾の一覧 → 備考・注記 |
| 作品をまたぐ一覧 | 作品（派生作品は元の作品にまとめる） | 許諾言語 | 概要（絞り込みの表示） → 作品×言語の表 → 凡例 → 備考・注記 |

マス＝そこを覆う OUT の利用許諾の取引先名（3 社まで。それ以上は「ほか n」）。
色が出ない紙でも読めるように、状態は文字の印でも出す。

| 状態 | 印 | 意味 |
|---|---|---|
| conflict | ✕ ぶつかり | 独占の許諾が、期間の重なるほかの取引先の許諾と同じマスにある |
| outside | △ 範囲外 | 作者から取った範囲（作者の条件の地域・言語）の外で許諾している |
| exclusive | ◉ 独占 | 独占で許諾 |
| non_exclusive | ○ 非独占 | 非独占で許諾 |
| open | 空き | 取った範囲の内で、まだ誰にも許諾していない |
| none | — | 取っていない・許諾なし |

作品をまたぐ一覧で地域を選ばないときは、その言語の全地域を畳んでいちばん気にすべき状態で出し、
空きのある地域の数を添える（画面と同じ）。

## 読むだけ

文書の番号は振らず、文書の一覧にも残らない（支払報告書 `docs/payment-report.md` と同じ扱い）。
ひな形は「文書の作成」のひな形一覧には出さない（`documents/repository.ts`）。
DB に登録（204）すると本文の手直しを版で残せる。未登録の環境では既定の本文で描く。
