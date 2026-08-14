\set ON_ERROR_STOP on
\pset pager off

-- 052_igla_annex_template.sql
-- IGLA 付属書（ARC-TPL-IGLA-ANNEX-001）の投入。051 の本体契約とセットで使う。
--   構成: Annex 1 ローカライズ変更マトリクス（6部材＋非提供ファイル行）
--         Annex 2 カットオフ価格ティア表＋マイルストーン表
--         Annex 3 出荷指示（宛先2件）＋数量照合記録
--   分岐: ANNEX_1/2/3_INCLUDED が true の別紙だけを出力する。
--         本体 Deal Sheet 第4節の Incorporated 表示と必ずそろえること。
--   採番: ARC-IGLAX-<年>-<連番>。
-- 改訂時は document_template_versions に新版を INSERT し current_version_id を差し替えること。

\if :{?confirm_igla_annex}
\else
  \echo 'Run with: -v confirm_igla_annex=SEED_IGLA_ANNEX_TEMPLATE'
  \quit 2
\endif
SELECT :'confirm_igla_annex' = 'SEED_IGLA_ANNEX_TEMPLATE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_templates WHERE template_key = 'igla_license_annex_en') THEN
    RAISE EXCEPTION 'igla_license_annex_en は登録済みです（改訂は versions に新版を追加してください）';
  END IF;
END $$;

WITH template AS (
  INSERT INTO document_templates (template_key, kind, label, category, document_prefix)
  VALUES ('igla_license_annex_en', 'document', 'IGLA 付属書 1/2/3（英文）', 'License', 'ARC-IGLAX')
  RETURNING id
)
INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
SELECT id, 1, $TPL$<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IGLA Annexes &mdash; Arclight LegalBridge template</title>
<!--
  LegalBridge 契約テンプレート
  テンプレートID : ARC-TPL-IGLA-ANNEX-001
  ベース         : IGLA Draft Rev.6 の ANNEX 1/2/3（表の項目名・固定文言は無改変）
  記法           : Handlebars（二重波括弧の変数）
  構成           : Annex 1 ローカライズ変更マトリクス（6部材＋非提供ファイル行）
                   Annex 2 カットオフ価格ティア表＋マイルストーン表
                   Annex 3 出荷指示（宛先2件）＋数量照合記録
  条件分岐       : ANNEX_1/2/3_INCLUDED が true の別紙だけを出力する。さらに
                   TRANSACTION_MODEL=License-Out のときは Product-Out 専用の
                   Annex 3 全体・Annex 2 のカットオフ価格ティア表・PO系マイルストーン行を出さない。
  対応本体       : igla_license_en（ARC-TPL-IGLA-001）。本体 Deal Sheet 第4節の
                   Incorporated と選択を必ず一致させること。
-->
<style>
:root{
  --ink:#191c22; --ink-soft:#4a5058; --paper:#ffffff;
  --rule:#c9c4ba; --rule-soft:#e3dfd6; --head:#f7f5f0;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Noto Serif JP",serif;
}
body{margin:0; background:#e8e6e0;}
.page{width:210mm; min-height:297mm; margin:24px auto; padding:20mm 18mm; background:#fff;
      box-shadow:0 1px 3px rgba(0,0,0,.10), 0 12px 32px rgba(0,0,0,.09);}
.doc{color:var(--ink); font-family:var(--serif); font-size:10pt; line-height:1.5;
     text-align:justify; hyphens:auto;}
.doc p{margin:0 0 .7em;}
.doc-title{font-size:13pt; font-weight:700; letter-spacing:.04em; text-align:center; margin:0 0 .3em;}
.doc-sub{text-align:center; font-size:9pt; color:var(--ink-soft); margin:0 0 .2em;}
.doc-stamp{text-align:center; font-size:8.5pt; letter-spacing:.14em; color:var(--ink-soft);
           margin:.6em 0 1.6em; text-transform:uppercase;}
.lede{font-size:9.5pt; color:var(--ink-soft); border-left:2px solid var(--rule); padding-left:.9em;
      margin:0 0 1.8em;}
h2.part{font-size:11.5pt; font-weight:700; letter-spacing:.08em; text-align:center;
        border-top:1px solid var(--rule); border-bottom:1px solid var(--rule);
        padding:.5em 0; margin:2.4em 0 1.2em; break-before:page; page-break-before:always;}
h2.part.first{break-before:auto; page-break-before:auto; margin-top:0;}
h3{font-size:10.5pt; font-weight:700; margin:1.4em 0 .5em; text-align:left;}
h4{font-size:10pt; font-weight:700; margin:1.2em 0 .45em; text-align:left;}
.note{font-size:9pt; color:var(--ink-soft); margin:0 0 1em;}
.cl{padding-left:3.2em; position:relative; text-indent:0;}
.cn{position:absolute; left:0; width:2.8em; color:var(--ink-soft);
    font-variant-numeric:tabular-nums;}
table.sheet{width:100%; border-collapse:collapse; font-size:9pt; margin:0 0 1.2em;}
table.sheet th, table.sheet td{border:1px solid var(--rule); padding:.42em .6em;
  vertical-align:top; text-align:left; font-weight:400;}
table.sheet th{width:34%; background:var(--head); font-weight:600;}
table.sheet.grid th{width:auto; text-align:center;}
table.sheet .req::after{content:" *"; color:#a4442f; font-weight:700;}
.opt{white-space:nowrap; margin-right:1.2em; display:inline-block;}
.fill{border-bottom:1px dotted var(--rule); min-width:6em; display:inline-block;}
.sig{display:flex; gap:2.5em; margin-top:1.4em;}
.sig > div{flex:1 1 0;}
.sig-line{border-bottom:1px solid var(--ink); margin:1.6em 0 .3em;}
.foot{margin-top:2.4em; font-size:8.5pt; color:var(--ink-soft); text-align:center;
      border-top:1px solid var(--rule-soft); padding-top:.6em;}
@media print{
  body{background:#fff;}
  .page{width:auto; min-height:0; margin:0; padding:0; box-shadow:none;}
  @page{size:A4; margin:18mm;}
}
</style>
</head>
<body>
<div class="page">
<div class="doc">
  <h1 class="doc-title">ANNEXES</h1>
  <p class="doc-sub">to the International Analog Game License and Product Supply Agreement</p>
  <p class="doc-stamp">{{AGREEMENT_STATUS}}</p>

  <table class="sheet">
    <tr><th>Agreement</th><td>{{AGREEMENT_REFERENCE}}</td></tr>
    <tr><th>Licensor</th><td>{{LICENSOR_NAME}}</td></tr>
    <tr><th>Licensee</th><td>{{LICENSEE_NAME}}</td></tr>
    <tr><th>Game Title</th><td>{{GAME_TITLE}}</td></tr>
    <tr><th>Transaction Model</th><td>{{TRANSACTION_MODEL}}</td></tr>
  </table>
  <p class="note">These Annexes are incorporated into the Agreement only to the extent stated in
    Deal Sheet Section 4. Each Annex below is included only if selected.</p>

{{#if ANNEX_1_INCLUDED}}
  <h2 class="part first">ANNEX 1 &ndash; LOCALIZATION CHANGE MATRIX</h2>
  <p class="note">Complete for each component or file. A blank field means no approval or cost assumption has been agreed.</p>
  <table class="sheet grid">
    <tr><th>Component / File</th><th>Provided By / Source Language</th>
      <th>Permitted Localization or Change</th><th>Approval / Deemed Approval</th>
      <th>Included Cost / Extra Charge</th></tr>
    <tr><th>Rulebook</th><td>{{A1_RULEBOOK_SOURCE}}</td><td>{{A1_RULEBOOK_CHANGE}}</td><td>{{A1_RULEBOOK_APPROVAL}}</td><td>{{A1_RULEBOOK_COST}}</td></tr>
    <tr><th>Cards / Tiles</th><td>{{A1_CARDS_SOURCE}}</td><td>{{A1_CARDS_CHANGE}}</td><td>{{A1_CARDS_APPROVAL}}</td><td>{{A1_CARDS_COST}}</td></tr>
    <tr><th>Boards / Punchboards</th><td>{{A1_BOARDS_SOURCE}}</td><td>{{A1_BOARDS_CHANGE}}</td><td>{{A1_BOARDS_APPROVAL}}</td><td>{{A1_BOARDS_COST}}</td></tr>
    <tr><th>Box / Packaging</th><td>{{A1_BOX_SOURCE}}</td><td>{{A1_BOX_CHANGE}}</td><td>{{A1_BOX_APPROVAL}}</td><td>{{A1_BOX_COST}}</td></tr>
    <tr><th>Artwork / Illustrations</th><td>{{A1_ARTWORK_SOURCE}}</td><td>{{A1_ARTWORK_CHANGE}}</td><td>{{A1_ARTWORK_APPROVAL}}</td><td>{{A1_ARTWORK_COST}}</td></tr>
    <tr><th>Marketing Assets</th><td>{{A1_MARKETING_SOURCE}}</td><td>{{A1_MARKETING_CHANGE}}</td><td>{{A1_MARKETING_APPROVAL}}</td><td>{{A1_MARKETING_COST}}</td></tr>
    <tr><th>Non-editable / Withheld Files</th><td>{{A1_WITHHELD_FILES}}</td>
      <td>No right to demand or modify</td><td>Not applicable</td><td>Not included</td></tr>
  </table>
{{/if}}

{{#if ANNEX_2_INCLUDED}}
  <h2 class="part">ANNEX 2 &ndash; PROJECT AND PRODUCTION SCHEDULE</h2>
  <p class="note">The consequence column should be completed for all critical Licensee deadlines, particularly campaign commitment, data submission, approvals and payment.</p>

{{#if (ne TRANSACTION_MODEL "License-Out")}}
  <h3>Product-Out Cut-Off, Price Tier and Estimated Shipment Schedule</h3>
  <table class="sheet grid">
    <tr><th>Cut-Off Tier</th><th>All Price-Locking Conditions Complete By</th>
      <th>Eligible Production Campaign</th><th>Applicable Unit Price / Pricing Basis</th>
      <th>Target Shipment Window (Estimate Only)</th><th>Effect if Cut-Off Missed</th></tr>
    <tr><th>Tier 1</th><td>{{A2_T1_DEADLINE}}</td><td>{{A2_T1_CAMPAIGN}}</td>
      <td>{{A2_T1_PRICE}}</td><td>{{A2_T1_WINDOW}}</td>
      <td>Tier 1 and first campaign lapse automatically; move to Tier 2 or re-quote.</td></tr>
    <tr><th>Tier 2</th><td>{{A2_T2_DEADLINE}}</td><td>{{A2_T2_CAMPAIGN}}</td>
      <td>{{A2_T2_PRICE}}</td><td>{{A2_T2_WINDOW}}</td>
      <td>Tier 2 lapses; move to later campaign and next tier or re-quote.</td></tr>
    <tr><th>After Final Cut-Off</th><td>{{A2_FINAL_DEADLINE}}</td><td>{{A2_FINAL_CAMPAIGN}}</td>
      <td>Re-quote based on then-current factory and aggregate-run conditions</td>
      <td>To be re-estimated</td>
      <td>No production slot or price is reserved unless Licensor confirms new terms in writing.</td></tr>
  </table>
  <p>Cut-off rule: The applicable tier is determined by the date and time on which all Price-Locking Conditions are actually complete. Partial, provisional, defective or later-revised submissions do not preserve a production slot or price. The next tier applies automatically where a fixed price is stated; “Re-quote” means the price will be recalculated under Schedule 2, Article 1.6.</p>
  <p>Illustration: If the Tier 1 cut-off is July 16, a complete submission received by the stated time on July 16 qualifies for the first Production Campaign. A complete submission received on July 17 does not qualify, even if only one day late; it moves to the next available campaign and the next price tier or re-quotation, and the shipment window is re-estimated.</p>
{{/if}}

  <h3>Milestones and Consequences</h3>
  <table class="sheet grid">
    <tr><th>Milestone</th><th>Responsible Party</th><th>Due Date</th>
      <th>Dependency / Deliverable</th><th>Consequence if Missed</th></tr>
    <tr><th>Agreement execution</th><td>Both</td><td>{{A2_M_EXECUTION_DUE}}</td><td>Signed Deal Sheet and schedules</td><td>No project commencement</td></tr>
    <tr><th>Licensor source materials</th><td>Licensor</td><td>{{A2_M_SOURCE_DUE}}</td><td>Files listed in Annex 1</td><td>Dependent dates extend</td></tr>
{{#if (ne TRANSACTION_MODEL "License-Out")}}
    <tr><th>Campaign commitment / MCQ</th><td>Licensee</td><td>{{A2_M_COMMITMENT_DUE}}</td><td>Written commitment and deposit</td><td>Current campaign and price tier lapse; next tier / re-quote</td></tr>
{{/if}}
    <tr><th>Localization files</th><td>Licensee</td><td>{{A2_M_FILES_DUE}}</td><td>Complete files in required format</td><td>Current campaign and price tier lapse; later run / next tier / re-quote</td></tr>
    <tr><th>Local compliance requirements</th><td>Licensee</td><td>{{A2_M_COMPLIANCE_DUE}}</td><td>Labels, warnings, testing and importer data</td><td>Incomplete for cut-off purposes; later run, reprice and Licensee bears late-change cost</td></tr>
    <tr><th>Licensor review</th><td>Licensor</td><td>{{A2_M_REVIEW_DUE}}</td><td>Complete submission received</td><td>Dependent dates extend</td></tr>
    <tr><th>PPC review</th><td>Licensee</td><td>{{A2_M_PPC_DUE}}</td><td>Approval or consolidated comments</td><td>Current production slot may lapse; next campaign / reprice</td></tr>
{{#if (ne TRANSACTION_MODEL "License-Out")}}
    <tr><th>Final PO / balance</th><td>Licensee</td><td>{{A2_M_PO_DUE}}</td><td>Accepted PO and cleared funds</td><td>Price-Locking Conditions not met; no slot or price reserved</td></tr>
{{/if}}
{{#if (ne TRANSACTION_MODEL "License-Out")}}
    <tr><th>Target shipment window</th><td>Licensor</td><td>{{A2_M_SHIPMENT_DUE}}</td><td>All dependencies met</td><td>Not a guaranteed deadline; re-estimate based on production status and dependencies</td></tr>
{{/if}}
    <tr><th>Release / launch</th><td>Licensee</td><td>{{A2_M_LAUNCH_DUE}}</td><td>Commercial launch</td><td>Exclusivity review</td></tr>
  </table>
  <table class="sheet">
    <tr><th>Binding Long-Stop Date</th><td>{{A2_BINDING_LONG_STOP}}</td></tr>
    <tr><th>Review Buffer (Schedule 2, Article 5.3)</th><td>{{A2_REVIEW_BUFFER}}</td></tr>
  </table>
{{/if}}

{{#if (ne TRANSACTION_MODEL "License-Out")}}
{{#if ANNEX_3_INCLUDED}}
  <h2 class="part">ANNEX 3 &ndash; PRODUCT-OUT DELIVERY INSTRUCTIONS</h2>
  <p class="note">Complete before carrier booking. Use one row per destination and SKU. Quantities in this Annex must reconcile with the accepted PO.</p>
  <table class="sheet grid">
    <tr><th>SKU / Product</th><th>Destination / Consignee</th><th>Quantity</th>
      <th>Incoterms Rule / Named Place</th><th>Required Documents / Special Instructions</th></tr>
    <tr><td>{{A3_D1_SKU}}</td><td>{{A3_D1_CONSIGNEE}}</td><td>{{A3_D1_QTY}}</td><td>{{A3_D1_INCOTERMS}}</td><td>{{A3_D1_DOCS}}</td></tr>
    <tr><td>{{A3_D2_SKU}}</td><td>{{A3_D2_CONSIGNEE}}</td><td>{{A3_D2_QTY}}</td><td>{{A3_D2_INCOTERMS}}</td><td>{{A3_D2_DOCS}}</td></tr>
  </table>

  <h3>Reconciliation Record</h3>
  <table class="sheet">
    <tr><th>Factory Reported Quantity</th><td>{{A3_FACTORY_QTY}}</td></tr>
    <tr><th>Carrier / Export Quantity</th><td>{{A3_CARRIER_QTY}}</td></tr>
    <tr><th>Destination Received Quantity</th><td>{{A3_RECEIVED_QTY}}</td></tr>
    <tr><th>Discrepancy and Evidence</th><td>{{A3_DISCREPANCY}}</td></tr>
    <tr><th>Agreed Resolution</th><td>{{A3_RESOLUTION}}</td></tr>
  </table>
{{/if}}
{{/if}}

  <p class="foot">IGLA Annexes &middot; {{AGREEMENT_REVISION}} &middot; Confidential<br>
    Arclight LegalBridge &middot; ARC-TPL-IGLA-ANNEX-001</p>

</div>
</div>
</body>
</html>
$TPL$,
       $json$[
  {
    "name": "AGREEMENT_STATUS",
    "label": "文書ステータス",
    "group": "I. 対象契約",
    "type": "select",
    "required": true,
    "options": [
      "DRAFT FOR DISCUSSION",
      "EXECUTION VERSION",
      "CONFIDENTIAL"
    ]
  },
  {
    "name": "AGREEMENT_REVISION",
    "label": "版表記（フッタ）",
    "group": "I. 対象契約",
    "placeholder": "例: Rev. 1 | 2026-09-01"
  },
  {
    "name": "AGREEMENT_REFERENCE",
    "label": "対象契約の特定",
    "group": "I. 対象契約",
    "required": true,
    "placeholder": "例: IGLA dated September 1st, 2026 (ARC-IGLA-2026-0001)",
    "helpText": "本体契約の文書番号・締結日を記載します"
  },
  {
    "name": "LICENSOR_NAME",
    "label": "許諾者 名称（Licensor・自社）",
    "group": "I. 対象契約",
    "required": true,
    "dbField": "company.name"
  },
  {
    "name": "LICENSEE_NAME",
    "label": "取引先（Licensee）名称",
    "group": "I. 対象契約",
    "required": true,
    "dbField": "vendor.vendor_name"
  },
  {
    "name": "GAME_TITLE",
    "label": "作品名（Game Title）",
    "group": "I. 対象契約",
    "required": true,
    "dbField": "work.title"
  },
  {
    "name": "TRANSACTION_MODEL",
    "label": "取引モデル（本体契約と同じ選択）",
    "group": "I. 対象契約",
    "type": "select",
    "required": true,
    "options": [
      "License-Out",
      "Product-Out",
      "Both"
    ],
    "helpText": "License-Out では Product-Out 専用の付属書3・付属書2のカットオフ価格ティア表は出力されません"
  },
  {
    "name": "ANNEX_1_INCLUDED",
    "label": "付属書1を出力する",
    "group": "I. 対象契約",
    "type": "boolean"
  },
  {
    "name": "ANNEX_2_INCLUDED",
    "label": "付属書2を出力する",
    "group": "I. 対象契約",
    "type": "boolean"
  },
  {
    "name": "ANNEX_3_INCLUDED",
    "label": "付属書3を出力する",
    "group": "I. 対象契約",
    "type": "boolean",
    "showWhen": {
      "field": "TRANSACTION_MODEL",
      "anyOf": [
        "Product-Out",
        "Both"
      ]
    }
  },
  {
    "name": "A1_RULEBOOK_SOURCE",
    "label": "ルールブック：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_RULEBOOK_CHANGE",
    "label": "ルールブック：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_RULEBOOK_APPROVAL",
    "label": "ルールブック：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_RULEBOOK_COST",
    "label": "ルールブック：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_CARDS_SOURCE",
    "label": "カード／タイル：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_CARDS_CHANGE",
    "label": "カード／タイル：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_CARDS_APPROVAL",
    "label": "カード／タイル：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_CARDS_COST",
    "label": "カード／タイル：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOARDS_SOURCE",
    "label": "ボード／パンチボード：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOARDS_CHANGE",
    "label": "ボード／パンチボード：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOARDS_APPROVAL",
    "label": "ボード／パンチボード：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOARDS_COST",
    "label": "ボード／パンチボード：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOX_SOURCE",
    "label": "箱／パッケージ：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOX_CHANGE",
    "label": "箱／パッケージ：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOX_APPROVAL",
    "label": "箱／パッケージ：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_BOX_COST",
    "label": "箱／パッケージ：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_ARTWORK_SOURCE",
    "label": "アートワーク／イラスト：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_ARTWORK_CHANGE",
    "label": "アートワーク／イラスト：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_ARTWORK_APPROVAL",
    "label": "アートワーク／イラスト：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_ARTWORK_COST",
    "label": "アートワーク／イラスト：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_MARKETING_SOURCE",
    "label": "マーケティング素材：提供元／原語",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Licensor / Japanese",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_MARKETING_CHANGE",
    "label": "マーケティング素材：許容される変更",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Translation only",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_MARKETING_APPROVAL",
    "label": "マーケティング素材：承認／みなし承認",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Final approval required; no deemed approval",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_MARKETING_COST",
    "label": "マーケティング素材：費用",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "placeholder": "例: Included / fee",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A1_WITHHELD_FILES",
    "label": "非提供・改変不可ファイルの一覧",
    "group": "II. 付属書1（ローカライズ変更マトリクス）",
    "type": "textarea",
    "helpText": "この行の他の列は「要求・改変の権利なし／対象外／費用に含まない」で固定です",
    "showWhen": {
      "field": "ANNEX_1_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_T1_DEADLINE",
    "label": "Tier 1 カットオフ日時",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: 2026/12/15, 17:00 Japan time",
    "helpText": "この時刻までに価格ロック条件5点がすべて揃わないとTier 1は自動失効します",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T1_CAMPAIGN",
    "label": "Tier 1 の対象生産キャンペーン",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: First Production Campaign",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T1_PRICE",
    "label": "Tier 1 の単価／価格基準",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: USD 6.20 per unit",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T1_WINDOW",
    "label": "Tier 1 の目標出荷時期（見込み）",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: March 2027",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T2_DEADLINE",
    "label": "Tier 2 カットオフ期間",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: 2026/12/16 - 2027/01/31",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T2_CAMPAIGN",
    "label": "Tier 2 の対象生産キャンペーン",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: Next Available Production Campaign",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T2_PRICE",
    "label": "Tier 2 の単価／価格基準",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: USD 6.80 per unit ／ Re-quote",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_T2_WINDOW",
    "label": "Tier 2 の目標出荷時期（見込み）",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: June 2027",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_FINAL_DEADLINE",
    "label": "最終カットオフ以降の起算日",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: After 2027/01/31",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_FINAL_CAMPAIGN",
    "label": "最終カットオフ以降の生産枠",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: Future campaign subject to capacity",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_BINDING_LONG_STOP",
    "label": "拘束力ある最終期日（Binding Long-Stop Date）",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "type": "textarea",
    "helpText": "ここに明記した日付だけが保証期日になります。空欄なら出荷日は全て見込み扱いです",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_REVIEW_BUFFER",
    "label": "レビュー・バッファ（第5.3条）",
    "group": "III. 付属書2（カットオフ・価格ティア）",
    "placeholder": "例: Two (2) weeks included",
    "helpText": "明記しない限り自動的なバッファは付きません",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_EXECUTION_DUE",
    "label": "契約締結 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_SOURCE_DUE",
    "label": "許諾者による素材提供 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_COMMITMENT_DUE",
    "label": "キャンペーン参加確約／MCQ 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_M_FILES_DUE",
    "label": "ローカライズデータ提出 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_COMPLIANCE_DUE",
    "label": "現地法規要件の提出 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_REVIEW_DUE",
    "label": "許諾者レビュー 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_PPC_DUE",
    "label": "PPC確認 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A2_M_PO_DUE",
    "label": "最終PO／残金 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_M_SHIPMENT_DUE",
    "label": "目標出荷時期 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": [
      {
        "field": "ANNEX_2_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A2_M_LAUNCH_DUE",
    "label": "発売 期日",
    "group": "IV. 付属書2（マイルストーン）",
    "placeholder": "例: 2026/11/30",
    "showWhen": {
      "field": "ANNEX_2_INCLUDED",
      "truthy": true
    }
  },
  {
    "name": "A3_D1_SKU",
    "label": "宛先1：SKU／製品",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D1_CONSIGNEE",
    "label": "宛先1：仕向地／荷受人",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "placeholder": "社名 / 住所 / 担当 / 税番号",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D1_QTY",
    "label": "宛先1：数量",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D1_INCOTERMS",
    "label": "宛先1：インコタームズ／指定地",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D1_DOCS",
    "label": "宛先1：必要書類・特記",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D2_SKU",
    "label": "宛先2：SKU／製品",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D2_CONSIGNEE",
    "label": "宛先2：仕向地／荷受人",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "placeholder": "社名 / 住所 / 担当 / 税番号",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D2_QTY",
    "label": "宛先2：数量",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D2_INCOTERMS",
    "label": "宛先2：インコタームズ／指定地",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_D2_DOCS",
    "label": "宛先2：必要書類・特記",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_FACTORY_QTY",
    "label": "工場報告数量",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_CARRIER_QTY",
    "label": "運送人／輸出数量",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_RECEIVED_QTY",
    "label": "仕向地受領数量",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_DISCREPANCY",
    "label": "差異と証跡",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  },
  {
    "name": "A3_RESOLUTION",
    "label": "合意した解決",
    "group": "V. 付属書3（出荷指示・数量照合）",
    "type": "textarea",
    "placeholder": "Replacement / credit / accepted excess / other",
    "showWhen": [
      {
        "field": "ANNEX_3_INCLUDED",
        "truthy": true
      },
      {
        "field": "TRANSACTION_MODEL",
        "anyOf": [
          "Product-Out",
          "Both"
        ]
      }
    ]
  }
]$json$::jsonb,
       'ARC-TPL-IGLA-ANNEX-001 初版（IGLA Draft Rev.6 の Annex 1/2/3）', 'legalbridge-v2'
  FROM template;

-- 注意: CTE 内の INSERT 行は同一文の外側 UPDATE から見えない（Postgres の仕様）。
-- current_version_id の差し替えは必ず別文で行う。
UPDATE document_templates t SET current_version_id = v.id
  FROM document_template_versions v
 WHERE t.template_key = 'igla_license_annex_en' AND v.template_id = t.id AND v.version_no = 1;

SELECT t.template_key, t.document_prefix, t.current_version_id, v.version_no,
       jsonb_array_length(v.field_schema::jsonb) AS fields
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'igla_license_annex_en';

COMMIT;
