# 支払報告書（payment_report）

許諾者・受注者 1 件について、一定期間の支払を **支払日と明細つきで 1 通** にまとめる帳票。

- 画面: 支払・お金 → 「支払報告書（文書）」
- ひな形: `infra/v3/templates/payment_report.html`（登録 SQL は `infra/v3/198_payment_report.sql`。`node infra/v3/tools/make-template-sql.mjs` で作り直す）
- 組み立て: `apps/legalbridge-v3/src/server/paydocs/payment-report-doc.ts`（規則）／`payment-report-service.ts`（読み込みと描画）
- API: `GET /api/v3/reports/payment-statement`（JSON）・`/html`（プレビュー）・`/pdf`
  - `partyId`・`from`・`to`（必須）、`basis`（`pay` 既定／`paid`／`issued`）、`exclude`（外す文書 id をカンマ区切り）、`remarks`

## 載るもの

決定済み（`issued`）の検収書・海外版検収書・役務提供完了通知書・利用許諾料計算書（出版を含む）。
相手先は文書の相手先（受取人宛ての計算書は `_payeePartyId` の受取人）。取込文書（inbound）は載せない。

## 段

1. 報告概要（期間・基準・文書件数・支払日の数）
2. 支払日ごとの一覧（文書 1 件 = 1 行。支払日の見出しで区切り、同じ日が複数なら小計）
3. 合計（通貨ごと。源泉があれば源泉の行を出す）
4. 別紙 明細（文書ごと。検収書は紙に刷った明細の行、計算書は計算書の明細。支払の記録も添える）

検収書 v2 の件数が多い版の組み方（概要の表 → 明細の表 → 右寄せの合計、表の見出しはページをまたいで繰り返す）を下敷きにしている。

## 支払日と金額

- 文書の実績に支払（取り消しを除く、この相手先への `out`）が立っていれば、その支払。支払済みは支払日、未払いは期日。分納で複数あれば最も遅い日。1 件の支払が複数の文書にまたがるときは割当の割合で按分する。
- 支払が無ければ文書に刷った支払予定日（`PAYMENT_DATE` ほか）と、文書の明細・合計（状態は「予定（文書記載）」）。

## 期間の基準

| basis | 意味 |
|---|---|
| `pay` | 支払日で切る（未払いは支払予定日）。既定 |
| `paid` | 支払済みの支払日で切る |
| `issued` | 文書の発行日で切る |

読むだけで、番号は振らない（文書の一覧にも残らない）。DB にひな形が未登録でも、既定の本文（`paydocs/payment-report-template.ts`）で描ける。
