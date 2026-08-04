# Phase 1 金銭・ロイヤリティ 現行ロジック棚卸し（V1→V2 移植インベントリ）

V1（`LegalBridge_AI_GCP`）の金銭・ロイヤリティ実装を精査し、V2（`apps/legalbridge`）への移植対象・DBスキーマ・必要GRANTを確定するための棚卸し。決定1（金銭管理の移植可否・範囲）を実装フェーズへ落とすための一次資料。

> 出典：V1の `services/worker/src/lib/{billing,calc,calc_license}.ts`、`services/api/src/{services,views,lib}` の billing/payment/receivable、`src/pages/master/Billing*・ReceivableMapPanel`、`src/components/document/schemas/royaltyStatement.tsx`、`migrations/0001〜0151`。V2 現状は `apps/legalbridge/src/server/{conditions,inspections}` と `infra/gcp/sql/`。

## 0. 総括（3行）

- V1の金銭機能は **①料率計算エンジン ②支払報告書/源泉/為替 ③請求ダッシュボード・債権マップ** の3系統。いずれも **V2には計算・出力・受領記録レイヤが丸ごと欠落**（V2は確定済み `amount_ex_tax` を集計するのみ）。
- 物理的な真実源は **`condition_lines`**（旧 `capability_*` は 0101 で DROP→VIEW化済み）。金銭実績は **`condition_events`/`condition_line_installments`** と **`royalty_*`/`payments`/`invoices`/`condition_receipts`** に分散。
- grant 011 は消化率算出の **読取のみ**。Phase 1 は `condition_events` への **INSERT**、`condition_lines` への **UPDATE**、および計算書・支払・請求・債権台帳の **新規 SELECT/INSERT/UPDATE** が上乗せ分。

---

## 1. 計算エンジン（`billing.ts` / `calc.ts` / `calc_license.ts`）

### 1.1 カスケード `calculateFee`（純関数・Legal確定順序）
```
gross
  → after_acceptance = ceil(gross × acceptance_ratio)     歩留率 clamp 0..1（既定1.0）
  → after_mg         = max(after_acceptance, mg_amount)    ★MG = floor（消化しない）
  → ag_offset        = min(after_mg, max(0, ag_amount − ag_consumed_before))  ★AG = 累積消化
  → actual_ex_tax    = after_mg − ag_offset
  → tax_amount       = ceil(actual_ex_tax × tax_rate/100)
  → total_inc_tax    = actual_ex_tax + tax_amount
```
- **端数は全中間計算・消費税とも `Math.ceil`（切り上げ）で統一**（Legal合意、最大1円ズレ許容）。
- overflow判定EPS：金額0.5円 / 数量0.0005（DECIMAL(10,4)最小単位の半分）。税整合検算は±1円以内OK。

### 1.2 料金モデル別 gross（`calcGross`、4モデル＝worker版が正）
| type | calc_type（V2列との対応） | 数式 |
|---|---|---|
| fixed | `FIXED` | `ceil(unit_price × (quantity − sample_quantity))` |
| performance | `BASE_QTY_RATE` / `SUPPLY_QTY` | `ceil(base_price × billable × rate_pct/100)` |
| revenue（売上報告型・**workerのみ**） | `BASE_RATE` | `ceil(base_amount × rate_pct/100)`（数量概念なし） |
| subscription | `SUBSCRIPTION` | `ceil(period_amount × period_count + initial_fee)` |

`billable = max(0, quantity − sample_quantity)`。calc_typeマッピング：`manufacturing`→performance、`sales`/`sublicense`→revenue。

### 1.3 MG / AG のセマンティクス
- **MG（最低保証）= floor**：毎期独立、消化されない。`after_mg = max(after_acceptance, mg_amount)`。`mg_topup_this_time = max(0, after_mg − after_acceptance)`。
  - **歴史的負債**：Phase 22.21.94 まではMGをAGと同じ消化型で誤実装。旧 `royalty_calculations.mg_consumed_this_time` に残る値は **AGとして再解釈**すべき。
- **AG（前払保証）= 累積消化**：`ag_offset = min(after_mg, max(0, ag_amount − ag_consumed_before))`。`ag_consumed_before` は `getAgConsumedToDate` の SUM（void除外）を呼び出し側が注入。

### 1.4 加算型(addon) vs 非加算型 の料率集約
- **加算型（Σ）**：1取引形態が複数 `condition_lines` セル（LC別）に分解 → 適用料率 = **Σ(各セル rate_pct)**。MG/AG/通貨は**代表行（最小 line_no/id）のみ**保持（二重計上防止）。→ `getRoyaltyConditionEconomics`。
- **非加算型/旧データ**：1行のみ → 実効料率(fixedRate)そのまま。

### 1.5 重要注記
- **billing.ts が worker版とapi版で二重複製**（worker=4モデル、api=3モデル）。V2移植では **worker版を正**として単一実装へ統合（V1の技術的負債の解消機会）。
- 確定保存時はフロント値を信用せず `previewRoyaltyCalculation` を**再実行してINSERT**する防御パターン。V2書込経路にも踏襲すべき。

---

## 2. 支払報告書・源泉徴収・為替（`paymentExportService` / `excelService` / `royaltyStatement.tsx`）

### 2.1 源泉徴収（唯一の実装は `excelService.buildFromFormData`）
```
taxIncluded = subtotal + consumption_tax
if vendor.withholding_enabled && taxIncluded > 0:
    if taxIncluded <= 1,000,000:  withholding = floor(taxIncluded × 0.1021)
    else:                          withholding = floor(1,000,000 × 0.1021) + floor((taxIncluded − 1,000,000) × 0.2042)
after_tax = taxIncluded − withholding
net_transfer = after_tax + reimbursement(立替金 税込)
```
- レート **10.21%**（所得税+復興特別所得税）、**100万円超過分 20.42%**。**国内居住者一律**（所得税法204条）。
- 判定フィールド：`vendors.withholding_enabled`。個人取引先（`entity_type`="個人"/"individual"）は**強制ON**。`form_data.VENDOR_WITHHOLDING_ENABLED` で明示ONも可。
- **租税条約(treaty)/非居住者/国別レートはV1にも未実装** → 移植不要。ただしV2 `outbound_conditions.withholding_tax_treatment`（自由テキスト）を将来クロスボーダー率へ発展させる余地。
- **源泉税額はどのテーブルにも永続化されない**（Excel出力時の導出値）。※ただし物理列 `payments.withholding_tax` は存在（後述）。

### 2.2 為替
- 外部レートAPI・TTM取得・レートマスタは**無し**。**手入力 `fxRate` のみ**（`royalty_statement_lines.fx_rate` / `payments.fx_rate` に保持）。
- 換算：`base(円) = round(sales_input × fxRate)`（外貨時）/ `round(sales_input)`（JPY時）。支払 = `ceil(base × rate_pct/100)`。円換算は `round`、支払は `ceil`。
- `calculateFee`（単票サーバ計算）にFX概念なし＝単一通貨内で完結。

### 2.3 支払報告書/ステートメントの構造・出力
- **Excel**（SheetJS）：1文書=1行、支払スロット×8＋末尾 `立替金/小計/消費税/源泉税/税引後/差引振込額`＋`インボイス登録(T番号)`。種別×個人/法人ごと1ファイル。
- 検収書PDFはDrive保存済みを取得して同梱。`buildExportBundle` → **ZIP直DL**（Drive保存せず）。PDF取得失敗は `X-Pdf-Failures` で通知。
- 発行フラグ：`documents.excel_issued_at = NOW()`。多明細確定は `royalty_statement_lines` を DELETE→INSERT。

---

## 3. 請求ダッシュボード・請求テーブル・印刷・債権マップ

### 3.1 請求ダッシュボード（`BillingDashboardPanel` / `GET /api/v3/receipts-dashboard`）
- `condition_receipts` を軸に cfc条件/親条件/works/vendors をJOIN。フィルタ：`condition_kind='sublicense_out'`固定＋period＋q(ILIKE)＋unreceived＋undistributed。`ORDER BY period_date DESC LIMIT 1000`。
- **3KPI（クライアント側 reduce）**：受領再許諾料合計 `Σ computed_royalty_ex_tax` / 実受領 `Σ received_amount` / ライセンサー分配 `Σ computed_distribution_ex_tax`。

### 3.2 請求テーブル/印刷（`BillingTablePanel` / `BillingPrintPage`）
- ライブ計算（サーバ `computeRoyalty`/`resolveDistribution` のミラー）：
  - 受領再許諾料 = 数量ベース(`BASE_QTY_RATE`/`SUPPLY_QTY` or `basis='manufacturing'`)なら `数量 × unit_price × rate_pct`、他は `売上 × rate_pct`。
  - 分配（ライセンサー支払）= `基準額 × 個数 × 親ライセンスイン料率(parent_rate_pct)`。基準額既定＝数量ベースなら `unit_price×数量`、権利許諾なら `受領再許諾料×1`（手動上書き可）。**親未リンク時は算定不可**。
- **台帳同期**：受領→入金(`payments` inbound/`sublicense_income`)、分配→出金(`payments` outbound/`royalty`) を upsert。削除時は紐づく payments も掃除。
- 印刷：「再許諾料 受領・分配 計算書」を `window.print()` でPDF化（社内管理用、正式請求書ではない旨明記）。

### 3.3 債権マップ（`ReceivableMapPanel` / `receivableMapService`）
- **作品(work)中心の3層フロー**（上流=当社が分配 ← 当社 ← 下流=当社が受領）を、派生系譜（`parent_work_id` チェーン）を段(tier)として縦積み。
- 下流：`condition_lines(cfc, sublicense_out)` × `condition_receipts` を `SUM(COALESCE(received_amount, computed_royalty_ex_tax))`。
- 上流：`condition_lines(cli, is_inbound=FALSE)` → `documents(license%/publication)` → LATERAL で親料率抽出。`distribute = round(sublicense_received × rate_pct/100)`。
- **cascade伝播**：tier i の分配基礎 = `Σ(i段〜最下段のreceived)`。同一 `capability_id` は `seenCap` で二重計上防止（`inherited=true`→0計上）。
- 名寄せ：`work_title_aliases` ＋ `works.alternative_titles`(配列) 横断の `resolveWorksByTitle`。

---

## 4. 金銭系DBスキーマ（本番 `legalbridge`・現行）

> **前提（0101_simplify_condition_core）**：旧 `contract_capabilities`/`capability_financial_conditions`/`capability_line_items`/`capability_expenses`/`capability_other_fees` は**物理DROP→VIEW化**（INSTEAD OFトリガ）。条件・料率・MG/AGの真実源は **`condition_lines`**。
> **既に存在しない（GRANT不可）**：`contract_financial_terms`・`contract_line_items`(0130)、`ledgers`(0143)、`sublicense_deals`・`sublicense_sales_reports`・`receivable_statuses`(0043)、`license_contracts`・`license_financial_conditions`(0030)、`capability_*`(VIEW)。

### 4.1 条件・料率・実績（真実源系）
| テーブル | 役割 | 金銭関連の要列 |
|---|---|---|
| `condition_lines` | 条件・料率・MG/AGの真実源 | `direction`(payable/receivable), `payment_scheme`, `currency`, `quantity`/`unit_price`/`amount_ex_tax`, `rate_pct`, `mg_amount`/`ag_amount`, `royalty_base`, `calc_period_kind`/`_close_month`, `counterparty_vendor_id`, `source_work_id`/`_material_id`, `parent_license_condition_id`, `legacy_role`(cfc/cli/…), `closed_at`/`cancelled_at` |
| `condition_events` | 消化・実績イベント（残高中核・追記型） | `condition_line_id`, `event_type`(inspection/royalty_calc/payment), `installment_id`, `period`, `amount_ex_tax`, `voided_at`, `mg_consumed_this_time`/`ag_consumed_this_time`, `manufacturing_event_id`, `source_royalty_calculation_id` |
| `condition_line_installments` | 予定回（分割スケジュール） | `installment_no`, `trigger_kind`, `planned_amount_ex_tax`, `due_date` |
| `condition_receipts` | 債権（受領予定/実受領・分配） | `condition_line_id`, `period`/`period_date`, `reported_sales`/`reported_quantity`, `computed_royalty_ex_tax`, `received_amount`/`received_date`, `payment_id`, `distribution_*`(base/qty/rate_pct/parent_condition_id), `computed_distribution_ex_tax`, `distribution_payment_id`, `status` |

### 4.2 計算書・支払・請求台帳
| テーブル | 役割 | 要列 |
|---|---|---|
| `royalty_calculations` | 製造/売上ベース計算明細 | `unit_price`/`quantity`/`sample_quantity`/`billable_quantity`, `rate_pct`, `gross_royalty_ex_tax`, `mg_*`, `actual_royalty_ex_tax`, `tax_*`, `total_payment_inc_tax`, `period`, `condition_line_id`/`condition_event_id` |
| `royalty_payments` | ロイヤリティ支払（製造イベント単位） | `manufacturing_event_id`(UNIQUE), `payment_due_date`, `total_amount`, `status` |
| `royalty_statements` | 計算書（契約単位MG/AGプール） | `contract_id`, `calc_type`, `gross_royalty_ex_tax`, `mg_*`/`ag_*`, `actual_royalty_ex_tax`, `tax_*`, `period` |
| `royalty_statement_lines` | 計算書の多明細正規化（発行時確定値） | `document_id`/`document_number`, `group_no`, `calc_method`, `intake_currency`, **`fx_rate`NUMERIC(18,6)**, `sales_input`, `sales_jpy`, `rate_pct`, `payment_jpy`（発行毎 DELETE→INSERT） |
| `payments` | 支払・入金 統一台帳（FX・源泉ハブ） | `direction`(outbound/inbound), `payment_kind`(royalty/sublicense_income/…), `work_id`/`contract_id`/`invoice_id`, `counterparty_vendor_id`, `paid_from_bank_account_id`, `amount_ex_tax`, `tax_*`, **`withholding_tax`(15,2)**, `total_amount`, `currency`, **`fx_rate`/`amount_jpy`/`fx_rate_date`**, `status`(planned/approved/paid/received) |
| `invoices` | 請求書（受領/発行） | `direction`, `amount_ex_tax`/`tax_amount`/`total_amount`, `qualified_invoice`, `invoice_registration_number`, `status` |

### 4.3 実績イベント・マスタ
| テーブル | 役割 | 要列 |
|---|---|---|
| `manufacturing_events` | 製造実績（製造ベース源） | `product_id`, `quantity`, `msrp`, `total_payment` |
| `sales_events` | 販売/売上報告（売上ベース源） | `product_id`, `period`, `sold_quantity`, `sales_amount` |
| `delivery_events` / `delivery_line_items` | 検収イベント | `inspected_quantity`, `acceptance_ratio`, `inspected_amount_ex_tax`, `condition_event_id`/`condition_line_id` |
| `vendor_bank_accounts` | 振込先（国内/海外） | 国内 `bank_name`/`account_number`/`account_holder_kana`、海外 `swift_bic`/`iban`/`bank_country`/`currency` |
| `expense_categories` | 費目マスタ（payments FK先） | `expense_code`(PK), `label`, `account_category` |

### 4.4 為替・税の保持方式
- **専用の為替レート表・源泉税率マスタは無い**。値はトランザクション行にインライン：FX＝`payments.fx_rate`/`royalty_statement_lines.fx_rate`、消費税＝各台帳の `tax_rate`/`tax_amount`、源泉＝`payments.withholding_tax`＋`vendors.withholding_enabled`。→ **追加マスタ不要**。

---

## 5. GRANT設計（grant 011 + Phase 1 追加分）

ロール：金銭系は既存パターン通り **`legalbridge_v2_runtime`** に付与（004の `outbound_writer` は別系統）。現状の基準：
- **006 基盤**：`condition_lines`/`documents` に **SELECT, INSERT**（+ シーケンス USAGE,SELECT）。
- **011**：`condition_line_installments` / `condition_events` に **SELECT のみ**。

### 5.1 Phase 1 で必要な権限（新規grantファイル雛形、確認トークン例 `GRANT_PRODUCTION_ROYALTY_BILLING`）
| 対象テーブル | 現状 | Phase 1 必要 | 追加分 |
|---|---|---|---|
| `condition_events` | SELECT(011) | SELECT, **INSERT**（+void運用ならUPDATE） | ★INSERT |
| `condition_lines` | SELECT,INSERT(006) | +**UPDATE**（closed_at/cancelled_at/MG・AG編集） | ★UPDATE |
| `condition_receipts` | なし | SELECT, INSERT, UPDATE | ★新規 |
| `payments` | なし | SELECT, INSERT, UPDATE | ★新規 |
| `invoices` | なし | SELECT, INSERT, UPDATE | ★新規 |
| `royalty_statements` | なし | SELECT, INSERT | ★新規 |
| `royalty_statement_lines` | なし | SELECT, INSERT, **DELETE**（発行毎再構築） | ★新規 |
| `royalty_calculations` / `royalty_payments` | なし | SELECT（照合参照） | ★新規 |
| `manufacturing_events` / `sales_events` | なし | SELECT | ★新規 |
| `delivery_events` / `delivery_line_items` | なし | SELECT | ★新規 |
| `vendor_bank_accounts` / `expense_categories` | なし | SELECT | ★新規 |

- SERIAL列は id シーケンスへ `USAGE, SELECT`（UPDATE運用列があれば +UPDATE）を併せて付与（既存パターン）。
- **guard強化**：各対象を `to_regclass` 存在確認に加え **`relkind='r'`（VIEWでないこと）を検証**（capability_* 等のVIEWへ誤GRANTを防ぐ）。
- **GRANTしてはいけない**：`capability_*`(VIEW)、`contract_financial_terms`、`sublicense_deals`、`sublicense_sales_reports`、`receivable_statuses`、`ledgers`（消滅/VIEW）。

### 5.2 grant 011 の適用（決定：本番投入OK）
011 自体は非破壊・SELECTのみ・確認トークン付き。適用で 0-C の決算バンドが点火。適用手順（既存 `verify-write-test.sh`/psql パターン）：
```
psql "$LEGALBRIDGE_DSN" \
  -v confirm_condition_settlement_grants=GRANT_PRODUCTION_CONDITION_SETTLEMENT \
  -f infra/gcp/sql/011_production_condition_settlement_grants.sql
```
（`011_..._preflight.sql` で事前確認 → 本番反映。DSNは本番 `legalbridge`、ロール `legalbridge_v2_runtime` 存在が前提。）

---

## 6. V2移植ギャップ（優先度順・実装ロードマップ素案）

Phase 1 を依存順に分割（各スライス＝1PR、既定OFF・capability-gated・型/テスト/build グリーン）。

1. **計算エンジン（純関数）** — `billing.calculateFee` + `calcGross`(4モデル) + MG floor/AG offset/ceil丸めを V2 に単一実装で移植。純関数なので最優先・テスト容易。**GRANT不要**（計算のみ）。
2. **消化イベント書込（condition_events INSERT）** — 計算結果を実績イベントへ追記。preview再計算パターン踏襲。→ **grant: condition_events INSERT**。
3. **源泉・消費税** — `withholding`(10.21%/20.42%・個人強制ON)＋`ceil(税抜×率)`。`vendors.withholding_enabled` 参照。
4. **支払報告書/Excel・ZIP** — `royalty_statements`/`_lines` 発行、payment-export、8スロットExcel＋源泉列、Drive PDF同梱ZIP。→ **grant: royalty_statements/_lines, payments, vendor_bank_accounts, manufacturing/sales/delivery_events**。
5. **請求ダッシュボード** — `receipts-dashboard` 相当＋3KPI＋4フィルタ＋台帳バッジ。→ **grant: condition_receipts, payments SELECT**。
6. **請求テーブル・受領CRUD** — `condition_receipts` 記録＋`computeRoyalty`/`resolveDistribution`＋`payments`台帳同期。親ライセンスイン連結(`parent_license_condition_id`)。→ **grant: condition_receipts/payments/invoices SELECT/INSERT/UPDATE**。
7. **債権マップ** — 作品中心3層＋系譜cascade＋`work_title_aliases`名寄せ。読取中心。
8. **請求印刷** — 計算書レンダリング＋`window.print()`。
9. **為替** — 手入力 `fx_rate` 換算（`round(外貨×rate)`）。外部レートAPIはV1にも無く同等で可。

---

## 7. 未決・要判断（実装着手前）

- **料率カスケードの単一実装 vs 二重実装**：V1の worker/api 二重複製を V2 で1本化（worker版=4モデルを正）。→ 推奨：単一化。
- **legacy_role 射影のマッピング**：V1の `condition_lines.legacy_role`(cfc/cli) + `condition_kind='sublicense_out'` を、V2の `direction`(payable/receivable)/`flow_direction` へどう対応させるか（V1 `sublicense_out` ≒ receivable-out）。→ Phase 1着手時に設計。
- **MG旧データの再解釈**：`royalty_calculations.mg_consumed_this_time`(旧誤実装分)を移行時にAGとして扱うか、参照専用に留めるか。
- **部分cutoverの線引き**：計算エンジン〜支払報告（1〜4）をV2化しつつ、債権マップ/請求（5〜8）はV1並行を許容するか。決定1「棚卸し」を踏まえ、次段でスコープ確定。

---

*本棚卸しはV1実装（`billing/calc/calc_license`・`paymentExportService`・`receivableMapService`・`Billing*Panel`・`royaltyStatement`・migrations 0001-0151）とV2現状（`conditions/inspections` repository・`infra/gcp/sql`）を突合して作成。Phase 1 各スライスは着手時に個別設計する。*
