# 海外（クロスボーダー）の取引の税と検収書

決定（2026-09-28）：海外の取引には税込・税抜の区別を持ち込まない。消費税・VAT 等があれば金額に含める
（海外発注書の約款 6.5 条）。検収書は海外用（Acceptance Certificate）を別に作り、国内の検収書の計算は変えない。

## 仕組み

| 場所 | 扱い |
|---|---|
| 条件の税区分 | 「税込（海外・内税）」（`included`）を足した（A-056）。税率 0（上乗せしない） |
| 会計の出力 | `included` は報酬として小計に入る。立替金（非課税）には振らない。源泉の対象にもなる。列「税込（海外・内税）」 |
| 支払（検収書・計算書から） | 税区分から税率を出すので、`included` は消費税 0 |
| 利用許諾料計算書 | 税率 0 を 10% に戻していた不具合を直した（`taxRateOrDefault`） |
| 海外発注書 | 「(excl. tax)」を外し、「Inclusive of any VAT, sales or similar taxes」と書く（基本契約の有無にかかわらず） |
| 海外用の検収書 | `intl_inspection_certificate`（Acceptance Certificate）。税率は条件によらず 0、金額は税込の総額 |

## 海外の取引の見分け方

海外かどうかの項目は取引先にも条件にも無いので、書類から決める。

- **海外発注書・海外用の検収書を決定すると**、載っている条件（経費を除く）の税区分を `included` にする
  （監査に `condition.tax_included`）。精算で作る手数料の条件も、元の条件が `included` なら `included`。
- **検収書を作るとき**、委託・許諾の条件（手数料・経費を除く）がどれも `included` か、決定済みの海外発注書に
  載っていれば、自動で海外用の検収書にする（ひな形が登録されていて有効なとき）。
- 条件の画面で税区分を「税込（海外・内税）」に手で変えることもできる。

## 本番への入れ方（順番どおり）

```bash
cd ~/lb_v2_main && git fetch -q origin main && git checkout -q origin/main -- infra/v3
psql -v ON_ERROR_STOP=1 -f infra/v3/004_amend.sql            # A-056（税区分に included）
psql -v ON_ERROR_STOP=1 -v confirm_v3_grants=GRANT_V3_RUNTIME -f infra/v3/003_grants.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/151_intl_po_terms_rev20260928.sql   # 約款と海外発注書の税の表示
psql -v ON_ERROR_STOP=1 -f infra/v3/152_intl_inspection_certificate.sql # 海外用の検収書
```

アプリは main への push で自動デプロイされる（A-056 より先にアプリが動いても、`included` を
保存しようとしたときに CHECK で断られるだけで、既存の動きは変わらない）。

すでにある海外の条件（決定済みの海外発注書に載っている条件）の税区分は、次の検収書を作るとき
（海外用に切り替わり、決定で `included` になる）に揃う。まとめて揃えるなら：

```sql
UPDATE v3.conditions c SET tax_category = 'included', updated_at = now()
 WHERE c.tax_category IN ('taxable', 'reduced') AND c.kind NOT IN ('expense')
   AND EXISTS (SELECT 1 FROM v3.document_conditions dc
                 JOIN v3.documents d ON d.id = dc.document_id AND d.status = 'issued'
                 JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
                 JOIN v3.document_templates t ON t.id = tv.template_id
                WHERE dc.condition_id = c.id AND t.template_key = 'intl_purchase_order')
RETURNING c.id, c.condition_no;
```

## 残り

- 取引先へのメールの文面は、海外用の検収書でも日本語の「検収書の送付」になる（英文の文面は未作成）。
- 非居住者の源泉（租税条約の税率）は計算に無い。源泉の要否は取引先の「源泉徴収」の印で決まる。
