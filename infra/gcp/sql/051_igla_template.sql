\set ON_ERROR_STOP on
\pset pager off

-- 051_igla_template.sql
-- 国際アナログゲーム ライセンス・製品供給契約（IGLA / ARC-TPL-IGLA-001）本体の投入。
--   ベース: INTERNATIONAL ANALOG GAME LICENSE AND PRODUCT SUPPLY AGREEMENT
--           Draft Rev.6 / 16 July 2026（条文の文言は無改変）。
--   構成  : Deal Sheet ／ Master Agreement 第1〜18条（166条項・変数なし）
--           ／ Schedule 1（License-Out）／ Schedule 2（Product-Out）。
--   分岐  : TRANSACTION_MODEL により Schedule 1 / 2 の出力を切り替える。
--   別紙  : Annex 1/2/3 は 052（igla_license_annex_en）で別文書として作成する。
--   採番  : ARC-IGLA-<年>-<連番>。record_type は 'license' を含むキーのため license_condition。
-- 改訂時は document_template_versions に新版を INSERT し current_version_id を差し替えること。

\if :{?confirm_igla}
\else
  \echo 'Run with: -v confirm_igla=SEED_IGLA_TEMPLATE'
  \quit 2
\endif
SELECT :'confirm_igla' = 'SEED_IGLA_TEMPLATE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_templates WHERE template_key = 'igla_license_en') THEN
    RAISE EXCEPTION 'igla_license_en は登録済みです（改訂は versions に新版を追加してください）';
  END IF;
END $$;

WITH template AS (
  INSERT INTO document_templates (template_key, kind, label, category, document_prefix)
  VALUES ('igla_license_en', 'document', 'IGLA 国際アナログゲーム ライセンス・製品供給契約（英文）', 'License', 'ARC-IGLA')
  RETURNING id
)
INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
SELECT id, 1, $TPL$<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>International Analog Game License and Product Supply Agreement &mdash; Arclight LegalBridge template</title>
<!--
  LegalBridge 契約テンプレート
  テンプレートID : ARC-TPL-IGLA-001
  ベース         : INTERNATIONAL ANALOG GAME LICENSE AND PRODUCT SUPPLY AGREEMENT
                   (IGLA Draft Rev.6 / 16 July 2026) ― 条文の文言は無改変
  記法           : Handlebars（二重波括弧の変数）
  構成           : Deal Sheet ／ Master Agreement 第1〜18条 ／ Schedule 1（License-Out）
                   ／ Schedule 2（Product-Out）
  条件分岐       : TRANSACTION_MODEL が
                     License-Out → Schedule 1 のみ出力
                     Product-Out → Schedule 2 のみ出力
                     Both        → 両方出力
                   Annex 1/2/3 は別テンプレート（igla_license_annex_en）で作成し、
                   Deal Sheet 第4節の Incorporated 表示のみ本テンプレートが持つ。
  注意           : Master Agreement 第1〜18条は変数を含まない固定条文。改訂時は
                   document_template_versions に新版を INSERT し current_version_id を差し替える。
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
  <h1 class="doc-title">INTERNATIONAL ANALOG GAME<br>LICENSE AND PRODUCT SUPPLY AGREEMENT</h1>
  <p class="doc-sub">Master Agreement &middot; Deal Sheet &middot; License-Out Terms &middot; Product-Out Terms &middot; Annexes</p>
  <p class="doc-stamp">{{AGREEMENT_STATUS}}</p>

  <p class="lede">This package is designed for the international exploitation of Japanese analog games. The Deal Sheet activates either the License-Out model, under which the Licensee arranges manufacturing, or the Product-Out model, under which the Licensor manufactures and supplies localized products based on materials and specifications provided by the Licensee. Only the selected Supplemental Terms apply.</p>

  <h2 class="part first">DEAL SHEET</h2>
  <p class="note">Complete all applicable fields. A bracketed item is a transaction-specific field. The Deal Sheet, Master Agreement, selected Supplemental Terms and incorporated Annexes constitute the Agreement.</p>

  <h3>1. Parties</h3>
  <table class="sheet">
    <tr><th class="req">Licensor</th><td>{{LICENSOR_NAME}}<br>{{LICENSOR_ADDRESS}}<br>
      Registration number: {{LICENSOR_REG_NO}}<br>Represented by: {{LICENSOR_REP}}</td></tr>
    <tr><th class="req">Licensee</th><td>{{LICENSEE_NAME}}<br>{{LICENSEE_ADDRESS}}<br>
      Registration number: {{LICENSEE_REG_NO}}<br>Represented by: {{LICENSEE_REP}}</td></tr>
  </table>

  <h3>2. Notice and Project Contacts</h3>
  <table class="sheet">
    <tr><th>Licensor Notice Contact</th><td>{{LICENSOR_NOTICE_CONTACT}}</td></tr>
    <tr><th>Licensee Notice Contact</th><td>{{LICENSEE_NOTICE_CONTACT}}</td></tr>
    <tr><th>Licensor Project Manager</th><td>{{LICENSOR_PM}}</td></tr>
    <tr><th>Licensee Project Manager</th><td>{{LICENSEE_PM}}</td></tr>
  </table>

  <h3>3. Core Transaction Terms</h3>
  <table class="sheet">
    <tr><th class="req">Effective Date</th><td>{{EFFECTIVE_DATE}}</td></tr>
    <tr><th class="req">Transaction Model</th><td>
      <span class="opt">{{#if (eq TRANSACTION_MODEL "License-Out")}}&#9745;{{else}}&#9744;{{/if}} License-Out</span>
      <span class="opt">{{#if (eq TRANSACTION_MODEL "Product-Out")}}&#9745;{{else}}&#9744;{{/if}} Product-Out</span>
      <span class="opt">{{#if (eq TRANSACTION_MODEL "Both")}}&#9745;{{else}}&#9744;{{/if}} Both, solely as described here:</span>
      {{#if (eq TRANSACTION_MODEL "Both")}}{{BOTH_MODEL_SCOPE}}{{/if}}</td></tr>
    <tr><th class="req">Game Title</th><td>{{GAME_TITLE}}</td></tr>
    <tr><th>Localized Product / Edition</th><td>{{LOCALIZED_PRODUCT}}</td></tr>
    <tr><th class="req">Territory</th><td>{{TERRITORY}}</td></tr>
    <tr><th class="req">Language</th><td>{{LANGUAGE}}</td></tr>
    <tr><th>Sales Channels</th><td>{{SALES_CHANNELS}}</td></tr>
    <tr><th class="req">Exclusivity</th><td>
      <span class="opt">{{#if (eq EXCLUSIVITY "Exclusive")}}&#9745;{{else}}&#9744;{{/if}} Exclusive</span>
      <span class="opt">{{#if (eq EXCLUSIVITY "Non-Exclusive")}}&#9745;{{else}}&#9744;{{/if}} Non-Exclusive</span></td></tr>
    <tr><th>Reserved Rights / Channels</th><td>{{RESERVED_RIGHTS}}</td></tr>
    <tr><th class="req">Initial Term</th><td>From the Effective Date until {{INITIAL_TERM_END}}</td></tr>
    <tr><th>Renewal</th><td>
      <span class="opt">{{#if (eq RENEWAL_TYPE "None")}}&#9745;{{else}}&#9744;{{/if}} None</span>
      <span class="opt">{{#if (eq RENEWAL_TYPE "Automatic")}}&#9745;{{else}}&#9744;{{/if}} Automatic</span>
      {{#if (eq RENEWAL_TYPE "Automatic")}}for {{RENEWAL_YEARS}} year(s), unless notice is given
      {{RENEWAL_NOTICE_MONTHS}} months before expiry{{/if}}</td></tr>
    <tr><th>Sell-Off Period</th><td>{{SELL_OFF_DAYS}} days, subject to Article 15 and the applicable Supplemental Terms</td></tr>
    <tr><th>Target Release Date</th><td>{{TARGET_RELEASE_DATE}} (commercial target)</td></tr>
    <tr><th>Outside Release Date</th><td>{{OUTSIDE_RELEASE_DATE}} (failure consequences under Article 14 and applicable Supplemental Terms)</td></tr>
    <tr><th>Source Materials Language</th><td>
      <span class="opt">{{#if (eq SOURCE_MATERIALS_LANGUAGE "Japanese")}}&#9745;{{else}}&#9744;{{/if}} Japanese (default)</span>
      <span class="opt">{{#if (eq SOURCE_MATERIALS_LANGUAGE "English")}}&#9745;{{else}}&#9744;{{/if}} English</span>
      <span class="opt">{{#if (eq SOURCE_MATERIALS_LANGUAGE "Other")}}&#9745;{{else}}&#9744;{{/if}} Other:</span>
      {{#if (eq SOURCE_MATERIALS_LANGUAGE "Other")}}{{SOURCE_MATERIALS_LANGUAGE_OTHER}}{{/if}}</td></tr>
    <tr><th>Agreement Currency</th><td>
      <span class="opt">{{#if (eq AGREEMENT_CURRENCY "USD")}}&#9745;{{else}}&#9744;{{/if}} USD</span>
      <span class="opt">{{#if (eq AGREEMENT_CURRENCY "EUR")}}&#9745;{{else}}&#9744;{{/if}} EUR</span>
      <span class="opt">{{#if (eq AGREEMENT_CURRENCY "JPY")}}&#9745;{{else}}&#9744;{{/if}} JPY</span>
      <span class="opt">{{#if (eq AGREEMENT_CURRENCY "Other")}}&#9745;{{else}}&#9744;{{/if}} Other:</span>
      {{#if (eq AGREEMENT_CURRENCY "Other")}}{{AGREEMENT_CURRENCY_OTHER}}{{/if}}</td></tr>
  </table>

  <h3>4. Applicable Supplemental Terms and Annexes</h3>
  <table class="sheet">
    <tr><th class="req">Active Supplemental Terms</th><td>
      <span class="opt">{{#if (ne TRANSACTION_MODEL "Product-Out")}}&#9745;{{else}}&#9744;{{/if}} Schedule 1 &ndash; License-Out</span>
      <span class="opt">{{#if (ne TRANSACTION_MODEL "License-Out")}}&#9745;{{else}}&#9744;{{/if}} Schedule 2 &ndash; Product-Out</span></td></tr>
    <tr><th>Annex 1 &ndash; Localization Change Matrix</th><td>
      {{#if ANNEX_1_INCLUDED}}&#9745; Incorporated{{else}}&#9745; Not applicable{{/if}}</td></tr>
    <tr><th>Annex 2 &ndash; Project and Production Schedule</th><td>
      {{#if ANNEX_2_INCLUDED}}&#9745; Incorporated{{else}}&#9745; Not applicable{{/if}}</td></tr>
    <tr><th>Annex 3 &ndash; Product-Out Delivery Instructions</th><td>
      {{#if ANNEX_3_INCLUDED}}&#9745; Incorporated{{else}}&#9745; Not applicable{{/if}}</td></tr>
    <tr><th>Other Incorporated Documents</th><td>{{OTHER_DOCUMENTS}}</td></tr>
  </table>

  <h3>5. Governing Law and Dispute Resolution</h3>
  <table class="sheet">
    <tr><th>Governing Law</th><td>Laws of Japan, excluding conflict-of-laws rules</td></tr>
    <tr><th class="req">Dispute Resolution</th><td>
      <span class="opt">{{#if (eq DISPUTE_RESOLUTION "Court")}}&#9745;{{else}}&#9744;{{/if}}
        Exclusive jurisdiction of the Tokyo District Court as the court of first instance</span>
      <span class="opt">{{#if (eq DISPUTE_RESOLUTION "Arbitration")}}&#9745;{{else}}&#9744;{{/if}}
        Arbitration under the JCAA Commercial Arbitration Rules; seat Tokyo; language English;
        {{#if (eq DISPUTE_RESOLUTION "Arbitration")}}{{ARBITRATOR_COUNT}}{{else}}[one / three]{{/if}} arbitrator(s)</span></td></tr>
    <tr><th>CISG</th><td>The United Nations Convention on Contracts for the International Sale of Goods does not apply.</td></tr>
  </table>

  <h3>6. Signatures</h3>
  <p>IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date stated above.</p>
  <div class="sig">
    <div><p><strong>LICENSOR</strong></p><p>{{LICENSOR_NAME}}</p>
      <div class="sig-line"></div><p>Name / Title</p>
      <div class="sig-line"></div><p>Signature</p>
      <div class="sig-line"></div><p>Date</p></div>
    <div><p><strong>LICENSEE</strong></p><p>{{LICENSEE_NAME}}</p>
      <div class="sig-line"></div><p>Name / Title</p>
      <div class="sig-line"></div><p>Signature</p>
      <div class="sig-line"></div><p>Date</p></div>
  </div>

  <h2 class="part">MASTER AGREEMENT</h2>
    <section class="art">
      <h3>Article 1  Definitions and Interpretation</h3>
      <p class="cl"><span class="cn">1.1</span>“Affiliate” means an entity that directly or indirectly controls, is controlled by, or is under common control with a Party.</p>
      <p class="cl"><span class="cn">1.2</span>“Applicable Laws” means all laws, regulations, mandatory standards, sanctions, court orders and binding governmental requirements applicable to a Party, the Localized Product or the relevant activities.</p>
      <p class="cl"><span class="cn">1.3</span>“Approved Specifications” means the product, technical, quality, packaging, labeling and other specifications approved in writing by the Parties, including any incorporated Annex and accepted Change Order.</p>
      <p class="cl"><span class="cn">1.4</span>“Business Day” means a day other than a Saturday, Sunday or public holiday in Tokyo, Japan; provided that an action to be performed in another country may also be deferred if the relevant office there is closed by law.</p>
      <p class="cl"><span class="cn">1.5</span>“Change Approval Materials” means translations, layouts, packaging, product specifications, print-ready data, samples, release schedules, marketing claims and other materials submitted for Licensor approval.</p>
      <p class="cl"><span class="cn">1.6</span>“Change Order” means a written document approved by both Parties describing a change to specifications, quantity, price, schedule, materials, samples, delivery or other agreed requirements.</p>
      <p class="cl"><span class="cn">1.7</span>“Game IP” means all Intellectual Property Rights owned or lawfully controlled by Licensor in and to the game identified in the Deal Sheet, including rules text, game systems and mechanics to the extent protectable, artwork, graphic design, characters, packaging, trade dress, trademarks, logos, brand assets and related materials.</p>
      <p class="cl"><span class="cn">1.8</span>“Intellectual Property Rights” means copyrights and neighboring rights, trademark rights, design rights, patents, rights in confidential information, domain names and all analogous rights worldwide, whether registered or unregistered.</p>
      <p class="cl"><span class="cn">1.9</span>“Licensee Materials” means all translations, text, artwork, logos, legal notices, labels, specifications, data and other materials supplied by or on behalf of Licensee, excluding the Game IP and Licensor Materials.</p>
      <p class="cl"><span class="cn">1.10</span>“Licensor Materials” means the Game IP and all files, specifications, templates, source files, brand assets and other materials supplied by or on behalf of Licensor.</p>
      <p class="cl"><span class="cn">1.11</span>“Localization Materials” means translations, editorial adaptations, glossaries, layouts, localized artwork and other derivative or localization materials created by or for Licensee for the Localized Product, excluding Licensee’s documented pre-existing tools and generic know-how.</p>
      <p class="cl"><span class="cn">1.12</span>“Localized Product” means the authorized localized edition of the Game IP for the Territory and Language.</p>
      <p class="cl"><span class="cn">1.13</span>“Product-Out Product” means a Localized Product manufactured or procured by Licensor and supplied to Licensee under Schedule 2.</p>
      <p class="cl"><span class="cn">1.14</span>“Production Campaign” means a coordinated manufacturing run that may combine orders for multiple language editions or partners.</p>
      <p class="cl"><span class="cn">1.15</span>“Purchase Order” or “PO” means a written order submitted by Licensee and expressly accepted by Licensor under Schedule 2.</p>
      <p class="cl"><span class="cn">1.16</span>“Supplemental Terms” means Schedule 1, Schedule 2 or another written supplement expressly incorporated through the Deal Sheet or a signed amendment.</p>
      <p class="cl"><span class="cn">1.17</span>“Territory”, “Language”, “Sales Channels”, “Term” and “Sell-Off Period” have the meanings stated in the Deal Sheet.</p>
      <p class="cl"><span class="cn">1.18</span>Headings are for convenience only. “Including” means “including without limitation.” References to writing include email where this Agreement expressly permits operational approval by email. A requirement of prior written consent is not satisfied by silence unless this Agreement expressly provides for deemed approval.</p>
    </section>
    <section class="art">
      <h3>Article 2  Appointment and Grant of Rights</h3>
      <p class="cl"><span class="cn">2.1</span>Subject to Licensee’s timely payment and continuing compliance with this Agreement, Licensor appoints Licensee for the selected Transaction Model, Territory, Language, Sales Channels and Term.</p>
      <p class="cl"><span class="cn">2.2</span>License-Out model. If Schedule 1 is selected, Licensor grants Licensee a limited, non-transferable license, exclusive only if stated in the Deal Sheet, to: (a) translate and adapt the Game IP into the Language; (b) reproduce and manufacture the approved Localized Product; (c) import, export, market, advertise, distribute, offer for sale and sell authorized copies in the Territory and Sales Channels; and (d) use Licensor’s approved trademarks and brand assets solely for those purposes. The grant includes only those copyright rights reasonably necessary for the approved exploitation, including rights corresponding to translation, adaptation, reproduction, transfer, distribution, display and public transmission where relevant to authorized marketing materials.</p>
      <p class="cl"><span class="cn">2.3</span>Product-Out model. If Schedule 2 is selected, Licensor grants Licensee a limited, non-transferable license, exclusive only if stated in the Deal Sheet, to: (a) prepare and submit Localization Materials for Licensor’s manufacture of the Product-Out Product; and (b) import, market, advertise, distribute, offer for sale and sell genuine Product-Out Products supplied by Licensor. Licensee has no right to manufacture, reproduce, commission manufacturing of, or source substitute copies of the Product-Out Product, except for non-commercial proofs expressly approved by Licensor.</p>
      <p class="cl"><span class="cn">2.4</span>Licensee may appoint distributors and resellers in the ordinary course, but remains fully responsible for them. A sublicense to another publisher, a grant of manufacturing rights, or an appointment of a contract manufacturer requires Licensor’s prior written consent. In the License-Out model, Licensee may use approved printers and production contractors solely as service providers and not as independent licensees.</p>
      <p class="cl"><span class="cn">2.5</span>If exclusivity is selected, it is conditional on Licensee meeting the release, minimum commitment, sales performance, reporting, payment and reprint obligations stated in this Agreement. Licensor retains all rights expressly reserved in the Deal Sheet and all rights not expressly granted.</p>
      <p class="cl"><span class="cn">2.6</span>Licensee shall not challenge Licensor’s ownership or validity of the Game IP, register or attempt to register any confusingly similar mark, domain name, company name, social-media identifier or design, or remove proprietary notices.</p>
      <p class="cl"><span class="cn">2.7</span>Territorial and channel restrictions shall be interpreted and enforced only to the extent permitted by applicable competition law. Licensee shall not actively target customers outside the Territory where such restriction is lawful, but this Agreement does not require an unlawful restriction of passive sales or independent third-party resale.</p>
    </section>
    <section class="art">
      <h3>Article 3  Localization Process and Approvals</h3>
      <p class="cl"><span class="cn">3.1</span>Licensee shall prepare the Localization Materials faithfully, accurately and at commercially reasonable editorial quality appropriate for analog game publishing in the Territory. Licensee is responsible for translation accuracy, cultural adaptation, local proofreading and consistency, unless a specific task is expressly allocated to Licensor in an Annex or Change Order.</p>
      <p class="cl"><span class="cn">3.2</span>Licensor will provide the Licensor Materials identified in Annex 1. Unless otherwise stated, source materials may be supplied in Japanese. Licensor is not required to create an English intermediary version, provide editable native files, disclose manufacturing know-how, or provide materials identified as non-shareable. Any additional conversion, English translation or file preparation requested by Licensee is subject to a Change Order for price and schedule.</p>
      <p class="cl"><span class="cn">3.3</span>Licensee shall use the required file formats, naming conventions, version controls and delivery method notified by Licensor and shall deliver all materials by the deadlines in Annex 2. Licensee shall ensure that submitted files are complete, technically usable, virus-free and internally approved.</p>
      <p class="cl"><span class="cn">3.4</span>No change may be made to gameplay, game balance, core rules, component count, dimensions, artwork, packaging identity, trade dress, brand presentation, legal claims or safety information except within the permitted scope in Annex 1 or with Licensor’s prior written approval.</p>
      <p class="cl"><span class="cn">3.5</span>Licensor shall use commercially reasonable efforts to review complete Change Approval Materials within ten (10) Business Days after receipt. Silence may constitute deemed approval only for routine editorial or administrative matters expressly identified as eligible in Annex 1. Deemed approval never applies to final print-ready files, gameplay or rules changes, artwork changes, product specifications, safety or regulatory labels, trademarks, packaging identity, material marketing claims or any matter that may create legal or reputational risk.</p>
      <p class="cl"><span class="cn">3.6</span>Licensor’s approval confirms only consistency with the Game IP, brand and Approved Specifications. Unless Licensor expressly accepts a specific local-law responsibility in writing, approval does not transfer to Licensor responsibility for translation accuracy, local law, labeling, advertising, consumer notices, product registration, import requirements or market suitability.</p>
      <p class="cl"><span class="cn">3.7</span>A requested change outside the agreed scope, or a change requested after approval, may require repricing, new plates or tooling, new samples, factory charges and schedule extensions. Licensor has no obligation to implement such change until a Change Order is agreed.</p>
    </section>
    <section class="art">
      <h3>Article 4  Ownership of Game IP and Localization Materials</h3>
      <p class="cl"><span class="cn">4.1</span>Licensor retains all right, title and interest in the Game IP, Licensor Materials and all modifications or derivative materials created by or for Licensor. No ownership is transferred to Licensee.</p>
      <p class="cl"><span class="cn">4.2</span>To the fullest extent permitted by Applicable Laws, Licensee hereby assigns to Licensor, upon creation and without further consideration, all right, title and interest in the Localization Materials, including all copyrights and all rights of translation, adaptation and exploitation of derivative works, including rights corresponding to Articles 27 and 28 of the Copyright Act of Japan. Licensee shall execute, and procure execution of, further documents reasonably requested to confirm such ownership.</p>
      <p class="cl"><span class="cn">4.3</span>Where an assignment under Article 4.2 is ineffective or restricted by local law, Licensee grants Licensor an exclusive, worldwide, perpetual, irrevocable, transferable, sublicensable, fully paid-up license to use, reproduce, modify, translate, adapt, publish, distribute, display, communicate, create derivative works from, enforce and otherwise exploit the Localization Materials for any purpose connected with the Game IP.</p>
      <p class="cl"><span class="cn">4.4</span>Licensee shall obtain from all translators, editors, artists and other contributors written assignments, licenses, waivers, consents and non-assertions sufficient to give full effect to this Article. To the maximum extent permitted by law, Licensee shall procure waiver or non-assertion of moral rights against Licensor, its Affiliates, successors, licensees and customers.</p>
      <p class="cl"><span class="cn">4.5</span>Licensee retains ownership of its documented pre-existing trademarks, generic templates, software and know-how. To the extent any such item is embedded in the Localization Materials and cannot reasonably be separated, Licensee grants Licensor the non-exclusive, worldwide, perpetual, transferable, sublicensable, royalty-free license necessary to exploit the Localization Materials and Game IP.</p>
      <p class="cl"><span class="cn">4.6</span>During the Term, Licensor grants Licensee a limited license back to use the approved Localization Materials solely for the authorized Localized Product. That license ends upon expiration or termination, subject only to an authorized Sell-Off Period.</p>
    </section>
    <section class="art">
      <h3>Article 5  Trademarks, Credits and Brand Protection</h3>
      <p class="cl"><span class="cn">5.1</span>Licensee shall use Licensor’s trademarks, logos, copyright notices and credits exactly as approved and shall comply with brand guidelines supplied by Licensor. All goodwill arising from such use accrues solely to Licensor or the relevant owner.</p>
      <p class="cl"><span class="cn">5.2</span>Licensee shall include the credit wording, legal notices, original designer and publisher credits, and other attributions stated in the applicable Supplemental Terms or approval materials.</p>
      <p class="cl"><span class="cn">5.3</span>Licensee shall promptly notify Licensor of suspected infringement, counterfeiting, unauthorized copies, trademark misuse or domain-name abuse. Licensor controls enforcement concerning the Game IP. Licensee shall reasonably cooperate, and costs and recoveries shall be allocated as agreed for the specific action.</p>
      <p class="cl"><span class="cn">5.4</span>Licensor does not warrant that counterfeit or unauthorized products will not appear in the Territory, that enforcement will be commercially feasible, or that market demand will be unaffected by piracy.</p>
    </section>
    <section class="art">
      <h3>Article 6  Project Governance, Schedule and Communications</h3>
      <p class="cl"><span class="cn">6.1</span>Each Party shall appoint the Project Manager identified in the Deal Sheet. Project Managers coordinate operational matters but have no authority to amend legal or commercial terms unless separately authorized in writing.</p>
      <p class="cl"><span class="cn">6.2</span>The Parties shall maintain the milestone, cut-off and dependency plan in Annex 2. Except for Licensee deadlines and any date expressly identified in Annex 2 as a “Binding Long-Stop Date,” dates or windows assigned to Licensor, a factory, shipment or delivery are good-faith estimates only and are not guaranteed. Each Party shall promptly notify the other of an expected material change and identify affected dependencies. A delay caused by one Party extends dependent dates to the extent reasonably affected and may require a Change Order or application of a later price tier under Schedule 2.</p>
      <p class="cl"><span class="cn">6.3</span>If Licensee fails to execute required documents, provide complete and technically usable materials, approve specifications or samples, pay an amount, confirm quantities or otherwise meet a Licensee milestone or cut-off, Licensor may, after reasonable notice: (a) suspend work; (b) remove Licensee from the relevant Production Campaign; (c) move the order to a later production run; (d) apply the next price tier or issue a revised quotation in accordance with Schedule 2 and Annex 2; (e) treat the affected reservation as cancelled subject to agreed cancellation charges; or (f) take another consequence stated in Annex 2 or Schedule 2. A missed cut-off does not preserve the prior production slot, price or estimated shipment window.</p>
      <p class="cl"><span class="cn">6.4</span>Licensor shall use commercially reasonable efforts to provide the Licensor Materials and approvals assigned to it by Annex 2. Delay by Licensor extends dependent Licensee deadlines. Any other remedy for Licensor delay is limited by the applicable Supplemental Terms and Article 13.</p>
      <p class="cl"><span class="cn">6.5</span>Operational reminders are a coordination measure only and do not waive a deadline or transfer responsibility for timely performance. A waiver must be express and applies only to the specific instance.</p>
    </section>
    <section class="art">
      <h3>Article 7  Allocation of Regulatory and Commercial Responsibility</h3>
      <p class="cl"><span class="cn">7.1</span>Licensee is responsible, at its cost, for commercialization in the Territory, including local translation, importation, customs classification, importer-of-record obligations, product registrations, product-safety requirements, age grading, warnings, labels, environmental and packaging rules, consumer notices, advertising claims, promotions, e-commerce and marketplace rules, privacy, taxes on local sales, after-sales service and compliance by distributors and resellers.</p>
      <p class="cl"><span class="cn">7.2</span>Licensee shall identify and notify Licensor in writing, by the deadline in Annex 2, of all mandatory product, label, testing, certification, documentation and packaging requirements applicable in the Territory. Licensor is not liable for a requirement not timely disclosed, except to the extent Licensor had actual knowledge and failed to disclose it.</p>
      <p class="cl"><span class="cn">7.3</span>In the Product-Out model, Licensor is responsible for manufacturing the Product-Out Product in material conformity with the Approved Specifications and for compliance with mandatory laws applicable to its manufacturing and export activities. Licensee remains responsible for the legal sufficiency of Licensee Materials and the requirements of the destination market, subject to non-waivable law.</p>
      <p class="cl"><span class="cn">7.4</span>Each Party shall comply with applicable anti-bribery, sanctions, export-control, anti-money-laundering and competition laws. Neither Party shall require the other to perform an unlawful act.</p>
      <p class="cl"><span class="cn">7.5</span>If local law imposes non-delegable obligations on a manufacturer, importer, authorized representative, distributor or responsible economic operator, each Party shall perform its mandatory obligations notwithstanding the contractual allocation above, and the Parties shall cooperate to avoid duplication and allocate incremental costs according to the underlying cause and agreed scope.</p>
    </section>
    <section class="art">
      <h3>Article 8  Records, Information and Audit</h3>
      <p class="cl"><span class="cn">8.1</span>Licensee shall maintain accurate records sufficient to verify authorized manufacture, purchases, inventory, sales, returns, destruction, royalty calculations and territorial compliance for at least three (3) years after the relevant period, or longer if required by Applicable Laws.</p>
      <p class="cl"><span class="cn">8.2</span>Licensor may request reasonable inventory and channel information where necessary to protect the Game IP, manage exclusivity, plan a reprint, investigate counterfeiting or verify compliance. Royalty audits are governed by Schedule 1.</p>
      <p class="cl"><span class="cn">8.3</span>Each Party shall protect personal data and commercially sensitive information in accordance with Applicable Laws and shall disclose only information reasonably necessary for this Agreement.</p>
    </section>
    <section class="art">
      <h3>Article 9  Representations and Warranties</h3>
      <p class="cl"><span class="cn">9.1</span>Each Party represents that it has full power and authority to enter into and perform this Agreement and that the signatory is duly authorized.</p>
      <p class="cl"><span class="cn">9.2</span>Licensor represents that it owns or lawfully controls the Game IP rights necessary to grant the express rights under this Agreement and, to its knowledge, has not granted conflicting rights in the Territory and Language inconsistent with the selected exclusivity.</p>
      <p class="cl"><span class="cn">9.3</span>Licensee represents that: (a) Licensee Materials and Localization Materials supplied by it are accurate, legally usable and do not infringe third-party rights; (b) it has obtained all contributor rights required by Article 4; (c) it will comply with Applicable Laws in the Territory; and (d) it will not make unauthorized claims or modifications.</p>
      <p class="cl"><span class="cn">9.4</span>For Product-Out Products, Licensor warrants only that, at the time risk passes, the goods materially conform to the Approved Specifications and are free from material manufacturing defects, subject to the inspection and remedy provisions of Schedule 2.</p>
      <p class="cl"><span class="cn">9.5</span>Except as expressly stated, each Party disclaims all other warranties, whether express, implied or statutory, including merchantability, fitness for a particular purpose, market success, sales volume and non-infringement arising from materials or activities controlled by the other Party, to the maximum extent permitted by law.</p>
    </section>
    <section class="art">
      <h3>Article 10  Indemnification</h3>
      <p class="cl"><span class="cn">10.1</span>Licensor shall defend and indemnify Licensee against a third-party claim alleging that Licensee’s authorized use of the unmodified Game IP supplied by Licensor infringes that third party’s Intellectual Property Rights, except to the extent the claim arises from Localization Materials, Licensee Materials, a Licensee modification, combination with other material, use outside scope, local-law content, or continued use after Licensor offers a reasonable replacement or modification.</p>
      <p class="cl"><span class="cn">10.2</span>Licensee shall defend and indemnify Licensor, its Affiliates and their personnel against third-party claims, losses, recalls, penalties and reasonable external costs arising from: (a) Licensee Materials or Localization Materials; (b) translation or local adaptation; (c) local marketing, labeling, importation, sale, consumer handling or regulatory non-compliance; (d) unauthorized manufacture, modification or use; or (e) acts or omissions of Licensee’s contractors, distributors or resellers, except to the extent directly caused by Licensor’s breach.</p>
      <p class="cl"><span class="cn">10.3</span>In the Product-Out model, Licensor shall defend and indemnify Licensee against third-party bodily injury or tangible property-damage claims to the extent directly caused by a confirmed manufacturing defect for which Licensor is responsible, excluding defects in Licensee Materials, Approved Specifications requested by Licensee, local labels, warnings, storage, transport after risk passes, or downstream handling.</p>
      <p class="cl"><span class="cn">10.4</span>The indemnified Party shall promptly notify the indemnifying Party, provide reasonable cooperation and allow control of defense and settlement. No settlement may impose an admission, non-monetary obligation, injunction or restriction on the indemnified Party without its prior written consent, not to be unreasonably withheld.</p>
    </section>
    <section class="art">
      <h3>Article 11  Product Safety, Complaints and Recalls</h3>
      <p class="cl"><span class="cn">11.1</span>Each Party shall promptly notify the other of a safety incident, serious consumer complaint, regulatory inquiry, suspected non-compliance or recall risk concerning the Localized Product. Licensee shall maintain traceability and complaint records appropriate to its role in the Territory.</p>
      <p class="cl"><span class="cn">11.2</span>Except where immediate action is legally required, neither Party shall announce or conduct a recall, safety warning or market withdrawal referring to the other Party or the Game IP without prior consultation. Licensee shall lead execution in the Territory as importer or distributor, and Licensor shall reasonably cooperate.</p>
      <p class="cl"><span class="cn">11.3</span>Recall, corrective-action and replacement costs shall be borne according to root cause: Licensor for confirmed manufacturing defects within its responsibility; Licensee for Localization Materials, labels, local-law requirements, import, storage, distribution, marketing and consumer handling; and proportionately where both contributed. Mandatory liability under Applicable Laws is not excluded.</p>
    </section>
    <section class="art">
      <h3>Article 12  Payments, Taxes and Financial Protections</h3>
      <p class="cl"><span class="cn">12.1</span>Commercial payments are governed by the applicable Supplemental Terms. All amounts are exclusive of VAT, GST, sales tax and similar indirect taxes. Properly chargeable indirect tax shall be paid in addition upon a valid invoice, except where the payer must self-account.</p>
      <p class="cl"><span class="cn">12.2</span>If withholding is required by law, the payer may withhold, provided it promptly supplies official evidence of payment and reasonably assists the recipient to obtain a treaty reduction or credit. The Parties shall cooperate on residency certificates and required forms.</p>
      <p class="cl"><span class="cn">12.3</span>Overdue amounts accrue interest from the due date at one percent (1.0%) per month or the maximum lawful rate, whichever is lower. Licensor may suspend approvals, manufacturing, shipment and further rights while an undisputed amount remains overdue.</p>
      <p class="cl"><span class="cn">12.4</span>No set-off is permitted except for an undisputed amount or an amount finally determined by a competent court or tribunal. The remitter bears outgoing bank charges and the recipient bears receiving-bank charges, unless otherwise stated.</p>
      <p class="cl"><span class="cn">12.5</span>Licensee shall provide reasonable evidence of creditworthiness upon request and, if Licensor reasonably identifies a material credit risk, Licensor may require advance payment, a letter of credit, credit insurance or other reasonable security before further performance.</p>
    </section>
    <section class="art">
      <h3>Article 13  Limitation of Liability</h3>
      <p class="cl"><span class="cn">13.1</span>Neither Party is liable for indirect, incidental, special, exemplary or consequential damages, loss of anticipated profit, loss of opportunity or loss of goodwill, except to the extent payable to a third party under an indemnified claim.</p>
      <p class="cl"><span class="cn">13.2</span>Subject to Article 13.3, each Party’s aggregate liability arising from an affected transaction shall not exceed the total amounts paid or payable to Licensor under that transaction during the twelve (12) months preceding the event giving rise to liability. For a claim relating to a specific Product-Out PO, Licensor’s aggregate liability shall not exceed the price paid or payable for the affected PO.</p>
      <p class="cl"><span class="cn">13.3</span>The exclusions and caps do not apply to: (a) Licensee’s payment obligations; (b) fraud or wilful misconduct; (c) Licensee’s unauthorized manufacture, use or infringement of the Game IP; (d) breach of confidentiality; or (e) death or personal injury to the extent liability cannot lawfully be limited. Indemnity obligations are subject to this Article unless the underlying matter falls within an express carve-out.</p>
    </section>
    <section class="art">
      <h3>Article 14  Term, Exclusivity Adjustment and Termination</h3>
      <p class="cl"><span class="cn">14.1</span>This Agreement begins on the Effective Date and continues for the Term stated in the Deal Sheet. Renewal occurs only as stated there.</p>
      <p class="cl"><span class="cn">14.2</span>Either Party may terminate for a material breach not cured within thirty (30) days after written notice, except that a payment breach must be cured within ten (10) Business Days and an unauthorized manufacturing or serious Game IP misuse breach may be terminated immediately if not reasonably curable.</p>
      <p class="cl"><span class="cn">14.3</span>Either Party may terminate immediately if the other Party becomes insolvent, enters bankruptcy or similar proceedings, ceases material business operations, becomes subject to sanctions making performance unlawful, or engages in fraud, bribery or conduct reasonably likely to cause serious reputational harm connected with the Localized Product.</p>
      <p class="cl"><span class="cn">14.4</span>Licensor may convert an exclusive appointment to non-exclusive, suspend exclusivity, reserve additional channels or terminate the applicable rights if Licensee: (a) fails to launch by the Outside Release Date; (b) fails a minimum print, purchase, sales or reprint obligation; (c) materially underperforms an agreed sales plan; (d) repeatedly misses reporting or material deadlines; or (e) ceases active commercialization, in each case after any cure or consultation process stated in the applicable Supplemental Terms.</p>
      <p class="cl"><span class="cn">14.5</span>Termination of one Supplemental Term does not automatically terminate another unless the notice expressly states so or continued performance is commercially impracticable. Accepted POs and accrued obligations survive as stated in Schedule 2.</p>
    </section>
    <section class="art">
      <h3>Article 15  Effects of Expiration or Termination</h3>
      <p class="cl"><span class="cn">15.1</span>Upon expiration or termination, Licensee shall stop new manufacture and new exploitation of the Game IP, except for a permitted Sell-Off Period. No new print run, PO, crowdfunding campaign or material marketing launch may begin during sell-off.</p>
      <p class="cl"><span class="cn">15.2</span>Sell-off is limited to fully paid, genuine inventory existing on the termination date, remains subject to reporting and payment obligations, and is unavailable following termination for unauthorized manufacture, counterfeiting, serious IP misuse or nonpayment unless Licensor agrees otherwise.</p>
      <p class="cl"><span class="cn">15.3</span>Licensee shall return, delete or destroy Licensor Materials and confidential source files as instructed, except for one archival copy kept solely for legal compliance. Licensee shall certify completion upon request.</p>
      <p class="cl"><span class="cn">15.4</span>Accrued payments, ownership and licenses granted to Licensor, audit rights, confidentiality, indemnities, liability limitations, dispute resolution, recall obligations and provisions intended by nature to survive shall remain effective.</p>
    </section>
    <section class="art">
      <h3>Article 16  Confidentiality and Publicity</h3>
      <p class="cl"><span class="cn">16.1</span>Each Party shall keep the other Party’s non-public technical, commercial and legal information confidential, use it only for this Agreement, and disclose it only to personnel and professional advisers who need to know and are bound by confidentiality. These obligations continue for five (5) years after termination, and indefinitely for trade secrets to the extent permitted by law.</p>
      <p class="cl"><span class="cn">16.2</span>Confidentiality does not apply to information demonstrably public without breach, already lawfully known, independently developed, or lawfully received from a third party. Legally compelled disclosure is permitted after prompt notice where lawful.</p>
      <p class="cl"><span class="cn">16.3</span>Neither Party may issue a press release or use the other Party’s corporate name or logo for publicity beyond approved product marketing without prior written approval. Licensor may identify Licensee as an authorized publishing or distribution partner after launch, unless otherwise stated in the Deal Sheet.</p>
    </section>
    <section class="art">
      <h3>Article 17  Force Majeure and Supply Disruption</h3>
      <p class="cl"><span class="cn">17.1</span>Neither Party is liable for delay or failure caused by events beyond its reasonable control, including natural disaster, war, terrorism, epidemic, government action, sanctions change, labor dispute, transport interruption, utility failure, cyber incident, factory shutdown, raw-material shortage or supply-chain disruption, provided it gives prompt notice and uses commercially reasonable mitigation efforts.</p>
      <p class="cl"><span class="cn">17.2</span>Affected dates are extended for the reasonable period of impact. If the event materially prevents performance for more than ninety (90) days, either Party may terminate the affected portion by written notice. Amounts due for completed work, committed materials, non-cancellable costs and delivered goods remain payable, except to the extent recoverable from suppliers and not otherwise incurred.</p>
    </section>
    <section class="art">
      <h3>Article 18  General Provisions</h3>
      <p class="cl"><span class="cn">18.1</span>Assignment. Licensee may not assign, transfer or change control of the licensed business without Licensor’s prior written consent. Licensor may assign this Agreement to an Affiliate or a successor to the Game IP or relevant business upon written notice. Any permitted assignee must assume the assigning Party’s obligations.</p>
      <p class="cl"><span class="cn">18.2</span>Subcontracting. Licensor may use Affiliates, manufacturers, freight forwarders and other contractors to perform manufacturing and logistics, remaining responsible for its contractual obligations. Licensee shall not directly instruct Licensor’s factory or contractor unless Licensor authorizes it in writing.</p>
      <p class="cl"><span class="cn">18.3</span>Independent Contractors. The Parties are independent contractors. Nothing creates a partnership, joint venture, franchise, fiduciary relationship, agency, employment or profit-sharing arrangement. Licensee has no authority to bind Licensor.</p>
      <p class="cl"><span class="cn">18.4</span>Notices. Formal notices must be sent to the Notice Contacts in the Deal Sheet by email and, for termination or material breach notices, also by internationally recognized courier unless receipt is acknowledged by reply email. Operational approvals may be exchanged through Project Managers.</p>
      <p class="cl"><span class="cn">18.5</span>Entire Agreement; Amendments. This Agreement constitutes the entire agreement on its subject and supersedes prior discussions. An amendment must be signed by authorized representatives, except that operational approvals and accepted Change Orders may be made by authorized email where this Agreement permits.</p>
      <p class="cl"><span class="cn">18.6</span>Order of Precedence. The order is: (a) signed amendment; (b) Deal Sheet; (c) applicable Supplemental Terms; (d) incorporated Annexes and accepted Change Orders; (e) Master Agreement; and (f) accepted PO. A PO prevails only for product, quantity, price, delivery date and destination expressly accepted by Licensor and does not override legal terms unless it specifically identifies the clause being amended and is signed by authorized representatives.</p>
      <p class="cl"><span class="cn">18.7</span>Severability; Waiver. Invalid provisions shall be adjusted to the minimum extent necessary, and the remainder remains effective. Failure to enforce is not a waiver. Rights and remedies are cumulative unless expressly exclusive.</p>
      <p class="cl"><span class="cn">18.8</span>Counterparts; Electronic Signature. This Agreement may be signed in counterparts and electronically, each of which is an original and together one instrument.</p>
      <p class="cl"><span class="cn">18.9</span>Language. The English version governs. A translation is for convenience only unless the Parties expressly agree otherwise in writing.</p>
      <p class="cl"><span class="cn">18.10</span>Governing Law; Disputes; CISG. The governing law and dispute mechanism selected in the Deal Sheet apply. The United Nations Convention on Contracts for the International Sale of Goods is excluded.</p>
    </section>

{{#if (ne TRANSACTION_MODEL "Product-Out")}}
  <h2 class="part">SCHEDULE 1 &ndash; SUPPLEMENTAL TERMS: LICENSE-OUT</h2>
  <p class="note">This Schedule applies only if selected in the Deal Sheet. Under this model, Licensee is authorized to arrange localization, manufacturing and sale of the approved Localized Product.</p>

  <h3>A. Commercial Terms</h3>
  <table class="sheet">
    <tr><th>Royalty Rate</th><td>{{ROYALTY_RATE}}%</td></tr>
    <tr><th>Royalty Base</th><td>
      <span class="opt">{{#if (eq ROYALTY_BASE "Net Sales")}}&#9745;{{else}}&#9744;{{/if}} Net Sales</span>
      <span class="opt">{{#if (eq ROYALTY_BASE "MSRP")}}&#9745;{{else}}&#9744;{{/if}} MSRP &times; units manufactured</span>
      <span class="opt">{{#if (eq ROYALTY_BASE "Wholesale Price")}}&#9745;{{else}}&#9744;{{/if}} Wholesale Price</span>
      <span class="opt">{{#if (eq ROYALTY_BASE "Other")}}&#9745;{{else}}&#9744;{{/if}} Other:</span>
      {{#if (eq ROYALTY_BASE "Other")}}{{ROYALTY_BASE_OTHER}}{{/if}}</td></tr>
    <tr><th>Minimum Guarantee (MG)</th><td>{{MINIMUM_GUARANTEE}}</td></tr>
    <tr><th>Advance Royalty</th><td>{{ADVANCE_ROYALTY}}</td></tr>
    <tr><th>Accounting Period</th><td>
      <span class="opt">{{#if (eq ACCOUNTING_PERIOD "Quarterly")}}&#9745;{{else}}&#9744;{{/if}} Quarterly</span>
      <span class="opt">{{#if (eq ACCOUNTING_PERIOD "Semi-annually")}}&#9745;{{else}}&#9744;{{/if}} Semi-annually</span>
      ending {{ACCOUNTING_PERIOD_END}}</td></tr>
    <tr><th>Sales Report Due</th><td>Within {{SALES_REPORT_DAYS}} days after each Accounting Period</td></tr>
    <tr><th>Invoice / Payment Due</th><td>Invoice after report; payment within {{PAYMENT_DAYS}} days after valid invoice</td></tr>
    <tr><th>First Print Run / Minimum</th><td>{{FIRST_PRINT_RUN_MIN}} units</td></tr>
    <tr><th>Release Deadline</th><td>Target {{TARGET_RELEASE_DATE}} / Outside Date {{OUTSIDE_RELEASE_DATE}}</td></tr>
    <tr><th>Approved Manufacturers</th><td>{{APPROVED_MANUFACTURERS}}</td></tr>
    <tr><th>Complimentary Copies</th><td>{{COMPLIMENTARY_COPIES}} copies, shipping paid by Licensee</td></tr>
    <tr><th>Credit Wording</th><td>{{CREDIT_WORDING}}</td></tr>
    <tr><th>Sample / Approval Plan</th><td>{{SAMPLE_APPROVAL_PLAN}}</td></tr>
    <tr><th>Marketing Commitment</th><td>{{MARKETING_COMMITMENT}}</td></tr>
    <tr><th>Exclusivity Performance</th><td>{{EXCLUSIVITY_PERFORMANCE}}</td></tr>
  </table>

    <section class="sub">
      <h4>1. Royalty Base and Calculation</h4>
      <p class="cl"><span class="cn">1.1</span>If the Royalty Base is Net Sales, “Net Sales” means gross amounts invoiced and actually received by Licensee and its Affiliates from bona fide third-party sales, less only documented returns, customary trade discounts, chargebacks, rebates, sales taxes, VAT/GST, customs duties and outbound freight separately charged to customers. No manufacturing cost, overhead, commission, marketing cost, bad debt or other deduction is allowed unless expressly stated above.</p>
      <p class="cl"><span class="cn">1.2</span>If the Royalty Base uses MSRP, wholesale price, units manufactured or another measure, royalties shall be calculated exactly as stated in the Commercial Terms. Promotional, bundled, discounted, crowdfunding and related-party transactions shall be reported with a reasonable allocation method approved by Licensor.</p>
      <p class="cl"><span class="cn">1.3</span>MG and Advance Royalty are non-refundable except to the extent expressly stated and are recoupable only against the royalty stream identified above. No cross-collateralization applies across games, languages or territories unless expressly agreed.</p>
    </section>
    <section class="sub">
      <h4>2. Reporting, Invoicing and Payment</h4>
      <p class="cl"><span class="cn">2.1</span>Licensee shall submit a complete sales report for each Accounting Period, including units manufactured, units received, units sold by channel and country, gross sales, permitted deductions, Net Sales, royalty calculation, inventory, returns, complimentary copies, destroyed units, sublicense or distributor sales and reprint quantities.</p>
      <p class="cl"><span class="cn">2.2</span>Licensor may issue an invoice after receiving the report. Licensee shall pay within the stated period. A report is due even if no sales occurred. Currency conversion shall use {{FX_RATE_SOURCE}} rate on {{FX_RATE_DATE}}, as specified in the Commercial Terms or otherwise reasonably selected by Licensor.</p>
    </section>
    <section class="sub">
      <h4>3. Manufacturing, Quality and Samples</h4>
      <p class="cl"><span class="cn">3.1</span>Licensee may manufacture only through Approved Manufacturers and in accordance with the Approved Specifications. Licensor may reasonably require factory identity, compliance information and confidentiality undertakings. Licensee is responsible for its manufacturers and all production quality, safety and local compliance.</p>
      <p class="cl"><span class="cn">3.2</span>Before mass production, Licensee shall submit the proof or sample stages specified above. Approval does not waive Licensee’s manufacturing, translation or local-law responsibilities. If the sample plan identifies a PPC as “correction-capable,” Licensee shall not commence mass production until approval or written waiver. An MPC is ordinarily for verification and not a condition to shipment unless expressly stated.</p>
      <p class="cl"><span class="cn">3.3</span>All sample production, freight, customs and correction costs are borne by Licensee unless otherwise stated. Promotional mockups or prototypes are provided only if separately agreed and may remain Licensor’s property or be subject to use restrictions.</p>
    </section>
    <section class="sub">
      <h4>4. Distribution, Sublicensing and Territorial Control</h4>
      <p class="cl"><span class="cn">4.1</span>Licensee may sell through distributors and resellers but may not sublicense publishing or manufacturing rights without Licensor’s prior written consent. Any approved sublicense must be in writing, no broader than this Agreement and terminable upon termination of Licensee’s rights.</p>
      <p class="cl"><span class="cn">4.2</span>Licensee shall use commercially reasonable measures to avoid active sales outside the Territory to the extent lawful, maintain channel records and notify Licensor of material diversion. No obligation requires unlawful resale-price maintenance or passive-sales restriction.</p>
    </section>
    <section class="sub">
      <h4>5. Reprints, Changes and Release Performance</h4>
      <p class="cl"><span class="cn">5.1</span>Licensee shall notify Licensor before each reprint, stating quantity, manufacturer, schedule, inventory and proposed changes. No material change or new edition may proceed without approval under Article 3.</p>
      <p class="cl"><span class="cn">5.2</span>If Licensee fails to release by the Outside Release Date, meet the minimum first print, maintain active sales or satisfy the exclusivity performance requirement, Licensor may set a reasonable cure plan and thereafter convert exclusivity to non-exclusive or terminate Schedule 1.</p>
    </section>
    <section class="sub">
      <h4>6. Records and Audit</h4>
      <p class="cl"><span class="cn">6.1</span>Licensee shall retain supporting records for at least three (3) years after each Accounting Period. Licensor may, on ten (10) Business Days’ notice and no more than once per calendar year absent a material discrepancy, have an independent auditor bound by confidentiality review relevant records during normal business hours.</p>
      <p class="cl"><span class="cn">6.2</span>If an audit identifies underreporting exceeding five percent (5%) for the reviewed period, Licensee shall promptly pay the shortfall, interest and reasonable documented third-party audit costs. Otherwise, Licensor bears its audit costs.</p>
    </section>
    <section class="sub">
      <h4>7. Sell-Off and Survival</h4>
      <p class="cl"><span class="cn">7.1</span>During an authorized Sell-Off Period, Licensee may sell only existing authorized inventory, continue reporting and royalty payment, and comply with brand and channel restrictions. Unsold inventory shall thereafter be destroyed, de-branded or otherwise handled as Licensor directs at Licensee’s cost.</p>
      <p class="cl"><span class="cn">7.2</span>This Schedule survives as necessary for accrued royalties, audit, inventory reporting, MG and Advance reconciliation, approved sell-off and claims arising before termination.</p>
    </section>
{{/if}}

{{#if (ne TRANSACTION_MODEL "License-Out")}}
  <h2 class="part">SCHEDULE 2 &ndash; SUPPLEMENTAL TERMS: PRODUCT-OUT</h2>
  <p class="note">This Schedule applies only if selected in the Deal Sheet. Under this model, Licensee supplies localization materials and market requirements; Licensor arranges manufacture and supplies the Product-Out Product. Licensee receives only the rights necessary to market and sell genuine products supplied by Licensor.</p>

  <h3>A. Commercial and Order Terms</h3>
  <table class="sheet">
    <tr><th>Product / SKU</th><td>{{PRODUCT_SKU}}</td></tr>
    <tr><th>Production Campaign ID</th><td>{{CAMPAIGN_ID}}</td></tr>
    <tr><th>Approved Specifications</th><td>{{APPROVED_SPECIFICATIONS}}</td></tr>
    <tr><th class="req">Pricing Method</th><td>
      <span class="opt">{{#if (eq PRICING_METHOD "Firm")}}&#9745;{{else}}&#9744;{{/if}} Firm Minimum-Commitment Price</span>
      <span class="opt">{{#if (eq PRICING_METHOD "Variable")}}&#9745;{{else}}&#9744;{{/if}} Variable Aggregate-Run Price</span></td></tr>
    <tr><th>Minimum Committed Quantity (MCQ)</th><td>{{MCQ}} units</td></tr>
    <tr><th>Aggregate Production Assumption</th><td>{{AGGREGATE_PRODUCTION_ASSUMPTION}} units; non-binding unless expressly stated</td></tr>
    <tr><th>Provisional Unit Price</th><td>{{PROVISIONAL_UNIT_PRICE}} per unit at assumed quantity {{PROVISIONAL_ASSUMED_QTY}}</td></tr>
    <tr><th>Final Price Confirmation</th><td>By the applicable Annex 2 cut-off tier, final aggregate quantity and factory quotation</td></tr>
    <tr><th>Downward True-Up</th><td>
      <span class="opt">{{#if (eq DOWNWARD_TRUE_UP "Yes")}}&#9745;{{else}}&#9744;{{/if}} Yes, per formula</span>
      {{#if (eq DOWNWARD_TRUE_UP "Yes")}}{{TRUE_UP_FORMULA}}{{/if}}
      <span class="opt">{{#if (eq DOWNWARD_TRUE_UP "No")}}&#9745;{{else}}&#9744;{{/if}} No</span></td></tr>
    <tr><th>Quantity Tolerance</th><td>{{QUANTITY_TOLERANCE_PCT}}% over/under; treatment of excess/shortfall {{TOLERANCE_TREATMENT}}</td></tr>
    <tr><th>Included Localization / Plate Changes</th><td>{{INCLUDED_LOCALIZATION_CHANGES}}</td></tr>
    <tr><th>Additional Change Charges</th><td>{{ADDITIONAL_CHANGE_CHARGES}}</td></tr>
    <tr><th>Deposit / Reservation Payment</th><td>{{DEPOSIT_PCT}}% due {{DEPOSIT_TIMING}}</td></tr>
    <tr><th>Balance</th><td>{{BALANCE_PCT}}% due {{BALANCE_TIMING}}</td></tr>
    <tr><th>Price and Production Cut-Offs</th><td>See Annex 2. Each price tier and production slot lapses unless all Price-Locking Conditions are completed by the stated cut-off.</td></tr>
    <tr><th>Incoterms 2020 Rule and Named Place</th><td>{{INCOTERMS_RULE}} {{NAMED_PLACE}}</td></tr>
    <tr><th>Destination(s) and Quantities</th><td>{{DESTINATIONS_QUANTITIES}}</td></tr>
    <tr><th>Shipping Documents</th><td>{{SHIPPING_DOCUMENTS}}</td></tr>
    <tr><th>Licensee Materials Due</th><td>See Annex 2. Completion means complete, technically usable and approved materials, accepted PO and cleared payment.</td></tr>
    <tr><th>PPC / MPC / Verification Method</th><td>{{SAMPLE_VERIFICATION_METHOD}}</td></tr>
    <tr><th>Target Shipment Window</th><td>{{TARGET_SHIPMENT_WINDOW}} &mdash; estimate only; no guaranteed shipment, arrival or release date</td></tr>
    <tr><th>Currency</th><td>{{PO_CURRENCY}}</td></tr>
    <tr><th>Dedicated Tooling</th><td>{{DEDICATED_TOOLING}}</td></tr>
  </table>

    <section class="sub">
      <h4>1. Pricing Basis and Production Campaign</h4>
      <p class="cl"><span class="cn">1.1</span>Firm Minimum-Commitment Price. If selected, the unit price is based on Licensee purchasing at least the MCQ. A reduction in anticipated orders from other partners does not increase Licensee’s unit price so long as Licensee purchases the MCQ and does not change specifications, schedule or delivery requirements. Additional quantity is subject to capacity and may be priced separately.</p>
      <p class="cl"><span class="cn">1.2</span>Variable Aggregate-Run Price. If selected, the provisional unit price is based on the Aggregate Production Assumption. Licensor shall confirm the final unit price when accepted partner quantities and the applicable factory quotation are fixed. Licensee may accept the final price and issue or confirm the PO, or withdraw before the commitment deadline subject only to stated reservation costs.</p>
      <p class="cl"><span class="cn">1.3</span>A downward price adjustment applies only if the Downward True-Up is selected and shall be calculated under the stated formula after the final aggregate quantity or factory cost is known. Licensor is not required to disclose other partners’ identities, confidential prices or individual order quantities, but shall provide a reasonable summary sufficient to verify the adjustment basis.</p>
      <p class="cl"><span class="cn">1.4</span>Unless otherwise stated, prices exclude taxes, customs, destination compliance, local testing, freight after the agreed delivery point, storage, demurrage, special packaging, additional samples, change charges and costs caused by Licensee delay or incomplete materials.</p>
      <p class="cl"><span class="cn">1.5</span>Price and Production Cut-Offs. Each production campaign and price tier stated in Annex 2 is available only if, by the applicable cut-off date and time, Licensor has received all of the following in complete, internally approved and technically usable form (the “Price-Locking Conditions”): (a) final Localization Materials and print-ready data; (b) all mandatory local labels, warnings, importer information and compliance requirements; (c) all required specification and sample approvals; (d) the final quantity confirmation and an accepted PO; and (e) the required deposit or other payment in cleared funds. Partial, provisional, defective or subsequently revised submissions do not satisfy or preserve a cut-off unless Licensor expressly agrees in writing.</p>
      <p class="cl"><span class="cn">1.6</span>If the Price-Locking Conditions are not satisfied by a cut-off: (a) the corresponding production slot, price tier and target shipment window automatically lapse without constituting a breach by Licensor; (b) the order may be moved to the next available Production Campaign; and (c) the next price tier stated in Annex 2 shall apply automatically or, if Annex 2 states “Re-quote,” Licensor may revise the unit price, MOQ, tooling or plate charges, sample charges, storage, expedited handling and other affected terms based on the then-current factory quotation, aggregate production quantity, foreign-exchange conditions, raw-material costs and production capacity. Licensor shall provide the applicable revised terms or a reasonable pricing summary. Licensee shall accept the revised terms within {{REVISED_TERMS_ACCEPT_DAYS}} Business Days or the affected order or reservation may be treated as withdrawn or cancelled, subject to non-recoverable committed costs.</p>
    </section>
    <section class="sub">
      <h4>2. Purchase Orders, Commitment and Payment</h4>
      <p class="cl"><span class="cn">2.1</span>Licensee shall submit a PO specifying product, quantity, requested shipment window, destination, consignee, Incoterms rule and named place, shipping documents and any agreed special requirements. Licensor may accept, reject or propose changes within ten (10) Business Days. Only an expressly accepted PO is binding. Acceptance of a requested shipment window confirms the commercial order but does not convert that window into a guaranteed shipment, arrival or release date.</p>
      <p class="cl"><span class="cn">2.2</span>Licensor has no obligation to reserve capacity, procure materials, commence manufacture or allocate inventory until it has accepted the PO and received the required deposit in cleared funds. A forecast, email estimate, meeting note or unsigned spreadsheet is non-binding unless expressly incorporated.</p>
      <p class="cl"><span class="cn">2.3</span>The deposit is non-refundable after Licensor or its factory commits capacity or non-cancellable cost, except to the extent the affected cost is avoided or recovered. The balance is due as stated above. Licensor has no obligation to continue manufacture or release shipment while an amount is overdue.</p>
      <p class="cl"><span class="cn">2.4</span>This is a wholesale purchase and supply arrangement. Licensee bears its resale risk and retains its resale margin. No profit-sharing, agency, consignment or fiduciary accounting applies unless a separate written term expressly states otherwise.</p>
    </section>
    <section class="sub">
      <h4>3. Quantity Changes, Cancellation and Repricing</h4>
      <p class="cl"><span class="cn">3.1</span>After PO acceptance, Licensee may not reduce, cancel, postpone or redirect quantity without Licensor’s written consent. Any approved change is subject to revised unit pricing, lost volume economies, material and factory cancellation charges, storage, handling, additional freight and schedule impact.</p>
      <p class="cl"><span class="cn">3.2</span>An increase is subject to production capacity, material availability and a revised price or schedule. Licensor may accept a partial increase without accepting the remainder.</p>
      <p class="cl"><span class="cn">3.3</span>If actual output varies within the agreed Quantity Tolerance, Licensee shall accept and pay for conforming units within that tolerance as stated in the Commercial Terms. Output outside tolerance requires consultation and an equitable adjustment.</p>
    </section>
    <section class="sub">
      <h4>4. Licensee Materials, Specifications and Change Control</h4>
      <p class="cl"><span class="cn">4.1</span>Licensee shall provide complete translations, localized layouts or content, mandatory labels, warnings, importer details, product requirements and approvals by the deadlines in Annex 2. Licensee bears responsibility for accuracy and legal sufficiency of those materials.</p>
      <p class="cl"><span class="cn">4.2</span>Licensor shall manufacture according to the Approved Specifications. Any ambiguity, inconsistency or omission shall be promptly referred to the Project Managers. Licensor may suspend affected work until written clarification is received.</p>
      <p class="cl"><span class="cn">4.3</span>Only changes identified as permitted in Annex 1 are included in the quoted price. A language-dependent plate or print change may be included only for the components and number of revisions expressly stated. Structural, component, material, dimension, artwork, insert, packaging or late-stage changes require a Change Order.</p>
      <p class="cl"><span class="cn">4.4</span>Licensee has no right to direct Licensor’s factory, contact it for changes, or rely on a factory statement as modifying this Agreement. All instructions must pass through Licensor unless Licensor authorizes direct technical communication in writing.</p>
    </section>
    <section class="sub">
      <h4>5. Deadlines and Participation in the Production Campaign</h4>
      <p class="cl"><span class="cn">5.1</span>Time is of the essence for Licensee’s campaign commitment, delivery of complete Localization Materials and local compliance information, specification approval, sample approval, PO confirmation and payment deadlines. These deadlines are production and price cut-offs required to qualify for a particular Production Campaign and price tier; they are not reciprocal guarantees by Licensor of a shipment, arrival or market-release date.</p>
      <p class="cl"><span class="cn">5.2</span>If Licensee misses a deadline or the Price-Locking Conditions are not fully satisfied by the applicable cut-off, the current production slot and price tier shall lapse automatically. Licensor may: (a) proceed using the last approved materials where reasonably safe; (b) exclude Licensee from the current run; (c) hold or cancel the order; (d) move it to the next available run; (e) require expedited or additional factory cost; or (f) apply the next price tier or re-quote under Article 1.6. Any estimated shipment window shall be revised accordingly, and the resulting postponement shall not constitute delay or non-performance by Licensor.</p>
      <p class="cl"><span class="cn">5.3</span>For cut-off purposes, materials are deemed received only when Licensor reasonably confirms that they are complete, technically usable, internally consistent and accompanied by all required approvals and instructions. A submission requiring correction, clarification, reformatting, missing data or further approval is not complete. If Licensee materials require translation from Japanese or additional review, the schedule shall include the agreed review buffer. A default buffer of two (2) weeks is included only if stated in Annex 2; otherwise no automatic buffer applies.</p>
      <p class="cl"><span class="cn">5.4</span>Example of operation. If Annex 2 states that completion by July 16 qualifies for the first Production Campaign and Tier 1 price, completion on July 16 qualifies, but completion on July 17 does not. The order will then move to the next available Production Campaign and the Tier 2 price or re-quotation stated in Annex 2 will apply, together with a later estimated shipment window.</p>
    </section>
    <section class="sub">
      <h4>6. Samples, PPC, MPC and Approvals</h4>
      <p class="cl"><span class="cn">6.1</span>The sample plan must identify: (a) verification method; (b) whether the sample is digital, video, mockup, PPC or MPC; (c) quantity; (d) recipient; (e) production and freight cost; (f) review period; and (g) whether correction remains possible after review.</p>
      <p class="cl"><span class="cn">6.2</span>A “PPC” is a pre-production copy or equivalent proof produced before mass production. If designated correction-capable, mass production shall not begin until approval or waiver. A “MPC” is a mass-production copy drawn from the production run and normally verifies output only; corrections may require rework, replacement production or a commercial resolution.</p>
      <p class="cl"><span class="cn">6.3</span>Licensee shall review a complete sample within {{SAMPLE_REVIEW_DAYS}} Business Days or the period stated above. Failure to respond may be treated as approval only if the sample plan expressly states deemed approval. No deemed approval applies to a known safety issue or material deviation identified before shipment.</p>
      <p class="cl"><span class="cn">6.4</span>Mockups or promotional prototypes are not included unless separately agreed. Licensor may restrict their use, prohibit distribution, require return, or retain ownership. A mockup is not a warranty of final materials, color, finish or mass-production tolerances unless expressly stated.</p>
    </section>
    <section class="sub">
      <h4>7. Manufacture, Quality and Subcontractors</h4>
      <p class="cl"><span class="cn">7.1</span>Licensor may manufacture through Affiliates and third-party factories. Licensor remains responsible for material conformity to the Approved Specifications, subject to normal industry tolerances and the exclusions in this Schedule.</p>
      <p class="cl"><span class="cn">7.2</span>General factory tooling, processes, templates and manufacturing know-how remain owned by Licensor or the factory. Dedicated Tooling is governed by the Commercial Terms. Even if owned by Licensee, it may remain at the factory and may not be removed without payment of all amounts and reasonable transfer, certification and logistics costs.</p>
      <p class="cl"><span class="cn">7.3</span>Licensor may make non-material manufacturing changes that do not adversely affect gameplay, safety, required functionality, approved appearance or legal compliance, and shall notify Licensee where commercially reasonable.</p>
    </section>
    <section class="sub">
      <h4>8. Delivery Instructions, Shipping Documents and Quantity Reconciliation</h4>
      <p class="cl"><span class="cn">8.1</span>Delivery shall be made under the selected Incoterms 2020 rule at the precise named place. Licensee shall provide final destination, consignee, contact, import and routing instructions by the deadline in Annex 2. A change after booking is subject to carrier, storage, handling and administrative costs.</p>
      <p class="cl"><span class="cn">8.2</span>Licensor shall provide the agreed Shipping Documents. The packing list and factory shipment report shall identify Product, SKU, carton count and shipped unit quantity by destination. Licensee shall compare carrier, customs and receipt records and notify any documentary or quantity discrepancy within five (5) Business Days after receipt of the relevant records or goods, whichever permits verification.</p>
      <p class="cl"><span class="cn">8.3</span>The Parties shall cooperate to reconcile a discrepancy using factory records, packing lists, carrier records, customs data and receiving counts. No Party shall unreasonably withhold relevant records. A confirmed shortage outside the agreed tolerance shall be resolved by replacement, credit or refund at Licensor’s election; a confirmed excess accepted by Licensee shall be invoiced at the contract rate.</p>
      <p class="cl"><span class="cn">8.4</span>Licensee bears consequences of incorrect or late destination or consignee information, including rerouting, storage, demurrage, return freight, customs penalties and delay, except to the extent caused by Licensor’s failure to follow timely and clear instructions.</p>
    </section>
    <section class="sub">
      <h4>9. Risk, Title and Insurance</h4>
      <p class="cl"><span class="cn">9.1</span>Risk of loss or damage passes in accordance with the selected Incoterms 2020 rule at the named place. Incoterms allocation of risk does not determine title.</p>
      <p class="cl"><span class="cn">9.2</span>Title to the goods passes only upon the later of: (a) Licensor’s receipt of full payment for the relevant PO; and (b) delivery under the selected Incoterms rule, to the extent retention of title is permitted by applicable law. Until title passes, Licensee shall identify the goods as Licensor property, keep them free of liens and not resell them except in the ordinary course if Licensor has authorized release.</p>
      <p class="cl"><span class="cn">9.3</span>Each Party shall maintain insurance customary for its responsibilities. Licensee shall insure goods from the point risk passes and maintain product-liability and recall coverage reasonably appropriate to the Territory and Sales Channels.</p>
    </section>
    <section class="sub">
      <h4>10. Inspection, Defect Notice and Acceptance</h4>
      <p class="cl"><span class="cn">10.1</span>“Arrival Date” means the date the goods are delivered to and made available for inspection at the destination or warehouse identified in the accepted PO, regardless of the earlier Incoterms risk-transfer point.</p>
      <p class="cl"><span class="cn">10.2</span>Licensee shall inspect promptly. Apparent defects, wrong product, visible damage or quantity discrepancies must be notified with reasonable evidence by the earlier of: (a) fifteen (15) Business Days after Arrival Date; or (b) one hundred twenty (120) calendar days after shipment. Latent manufacturing defects must be notified within six (6) months after Arrival Date and within thirty (30) days after discovery.</p>
      <p class="cl"><span class="cn">10.3</span>Failure to give timely notice constitutes acceptance for the relevant defect, except where waiver is prohibited by mandatory law or Licensor fraudulently concealed the defect. Acceptance does not waive a timely latent-defect claim.</p>
      <p class="cl"><span class="cn">10.4</span>A defect does not include: approved content or specification; translation, local label or Licensee Material issue; normal color or material tolerance; damage after risk passes; improper storage or transport; ordinary wear; or product modified or repacked without Licensor approval.</p>
    </section>
    <section class="sub">
      <h4>11. Remedies for Confirmed Defects</h4>
      <p class="cl"><span class="cn">11.1</span>For a timely notified confirmed manufacturing defect, Licensor may, at its election, repair, replace, provide missing parts, issue a credit note, refund the affected unit price or authorize disposal. These are Licensee’s exclusive contractual remedies for product non-conformity, subject to Article 11 of the Master Agreement and non-waivable law.</p>
      <p class="cl"><span class="cn">11.2</span>Licensee shall preserve representative samples and evidence and shall not destroy, rework or return goods without Licensor’s instructions, except where immediate action is legally required. Licensor may require inspection by the factory or an independent expert.</p>
      <p class="cl"><span class="cn">11.3</span>Replacement or credit does not include lost profit, retailer penalties, marketing loss or downstream chargebacks unless Licensor expressly accepted that liability in writing before the relevant PO.</p>
    </section>
    <section class="sub">
      <h4>12. Delay, Supply Failure and Allocation</h4>
      <p class="cl"><span class="cn">12.1</span>Any target shipment date, target shipment window, estimated completion date, factory-ready date, sailing date, arrival date or release date stated in a PO, Annex, quotation, email or project plan is a good-faith estimate only and is not guaranteed, unless the relevant date is expressly identified in Annex 2 as a “Binding Long-Stop Date.” Estimates are based on the timely satisfaction of all Price-Locking Conditions and assumptions regarding factory capacity, consolidated production volume, raw materials, subcontractors, quality review, logistics and governmental procedures.</p>
      <p class="cl"><span class="cn">12.2</span>Licensor shall use commercially reasonable efforts to progress manufacture and provide reasonable status updates. Failure to meet an estimate due to factory scheduling, capacity allocation, consolidated production timing, raw-material availability, quality correction, subcontractor performance, logistics, port, customs or other commercially reasonable manufacturing or supply-chain factors does not by itself constitute breach, default or a compensable delay. A Licensee-caused delay or missed cut-off automatically extends all dependent estimates and may trigger a later price tier or re-quotation under Articles 1 and 5.</p>
      <p class="cl"><span class="cn">12.3</span>No contractual right to cancel, claim damages or obtain a refund arises solely because an estimated date or window is missed. A binding long-stop remedy applies only where Annex 2 expressly states a Binding Long-Stop Date and the corresponding remedy. If no Binding Long-Stop Date is stated, the Parties shall consult in good faith if the expected schedule changes materially; any cancellation remains subject to Licensor’s written agreement and payment of committed, non-cancellable and non-recoverable factory, material, tooling, storage and administrative costs, except in the case of Licensor’s fraud or wilful misconduct.</p>
      <p class="cl"><span class="cn">12.4</span>If available production or materials are insufficient due to supply disruption, Licensor may allocate production among customers on a commercially reasonable basis, taking account of committed quantities, completed payments, cut-off compliance, timing and operational feasibility.</p>
    </section>
    <section class="sub">
      <h4>13. Sales Performance, Reprints and Exclusivity</h4>
      <p class="cl"><span class="cn">13.1</span>Licensee shall use commercially reasonable efforts to sell the Product-Out Product. If exclusivity applies, Licensee shall sell at least {{MIN_SALES_PCT}}% of units purchased within {{MIN_SALES_MONTHS}} months after delivery, or the alternative performance metric stated in the Deal Sheet.</p>
      <p class="cl"><span class="cn">13.2</span>During the {{REPRINT_CONSULT_YEARS}} years after each purchase, if Licensee’s remaining inventory is {{REPRINT_INVENTORY_PCT}}% or less of units purchased when a new Production Campaign or reprint is planned, the Parties shall discuss Licensee’s participation in good faith. Licensee shall provide reasonable commercial justification if it declines.</p>
      <p class="cl"><span class="cn">13.3</span>If Licensee fails the sales requirement or Licensor reasonably determines after consultation that refusal to participate in a commercially reasonable reprint is unjustified, Licensor may convert exclusivity to non-exclusive, appoint additional partners or sell directly in the Territory, while other terms remain effective.</p>
    </section>
    <section class="sub">
      <h4>14. Priority and Survival</h4>
      <p class="cl"><span class="cn">14.1</span>For pricing, quantity, PO acceptance, manufacturing, samples, delivery, risk, title, inspection, defects and supply remedies, this Schedule prevails over inconsistent Master Agreement provisions.</p>
      <p class="cl"><span class="cn">14.2</span>This Schedule survives as necessary for accepted POs, committed costs, payments, title, inspection, defect and recall claims, delivery reconciliation, tooling, sell-off and disputes arising before termination.</p>
    </section>
{{/if}}
  <p class="foot">IGLA &middot; {{AGREEMENT_REVISION}} &middot; Confidential<br>Arclight LegalBridge &middot; ARC-TPL-IGLA-001</p>
</div>
</div>
</body>
</html>
$TPL$,
       $json$[
  {
    "name": "AGREEMENT_STATUS",
    "label": "文書ステータス",
    "group": "I. 文書情報・当事者",
    "type": "select",
    "required": true,
    "options": [
      "DRAFT FOR DISCUSSION",
      "EXECUTION VERSION",
      "CONFIDENTIAL"
    ],
    "helpText": "表紙の版表示。締結版は EXECUTION VERSION"
  },
  {
    "name": "AGREEMENT_REVISION",
    "label": "版表記（フッタ）",
    "group": "I. 文書情報・当事者",
    "placeholder": "例: Rev. 1 | 2026-09-01"
  },
  {
    "name": "EFFECTIVE_DATE",
    "label": "発効日（Effective Date・英語表記）",
    "group": "I. 文書情報・当事者",
    "required": true,
    "placeholder": "例: September 1st, 2026"
  },
  {
    "name": "LICENSOR_NAME",
    "label": "許諾者 名称（Licensor・自社）",
    "group": "I. 文書情報・当事者",
    "required": true,
    "dbField": "company.name",
    "placeholder": "例: Arclight Inc."
  },
  {
    "name": "LICENSOR_ADDRESS",
    "label": "許諾者 所在地",
    "group": "I. 文書情報・当事者",
    "dbField": "company.address"
  },
  {
    "name": "LICENSOR_REG_NO",
    "label": "許諾者 法人番号",
    "group": "I. 文書情報・当事者"
  },
  {
    "name": "LICENSOR_REP",
    "label": "許諾者 代表者",
    "group": "I. 文書情報・当事者",
    "dbField": "company.rep"
  },
  {
    "name": "LICENSEE_NAME",
    "label": "取引先（Licensee）名称",
    "group": "I. 文書情報・当事者",
    "required": true,
    "dbField": "vendor.vendor_name",
    "helpText": "「DBから引用」で取引先マスタから入力できます"
  },
  {
    "name": "LICENSEE_ADDRESS",
    "label": "取引先 所在地",
    "group": "I. 文書情報・当事者",
    "dbField": "vendor.address"
  },
  {
    "name": "LICENSEE_REG_NO",
    "label": "取引先 登録番号／法人番号",
    "group": "I. 文書情報・当事者",
    "dbField": "vendor.corporate_number"
  },
  {
    "name": "LICENSEE_REP",
    "label": "取引先 代表者",
    "group": "I. 文書情報・当事者",
    "dbField": "vendor.vendor_rep"
  },
  {
    "name": "LICENSOR_NOTICE_CONTACT",
    "label": "許諾者 通知先",
    "group": "II. 連絡先",
    "type": "textarea",
    "placeholder": "氏名 / 役職 / 通知用メールアドレス"
  },
  {
    "name": "LICENSEE_NOTICE_CONTACT",
    "label": "取引先 通知先",
    "group": "II. 連絡先",
    "type": "textarea",
    "placeholder": "氏名 / 役職 / 通知用メールアドレス"
  },
  {
    "name": "LICENSOR_PM",
    "label": "許諾者 プロジェクト担当",
    "group": "II. 連絡先",
    "type": "textarea",
    "placeholder": "氏名 / 役職 / 実務用メールアドレス"
  },
  {
    "name": "LICENSEE_PM",
    "label": "取引先 プロジェクト担当",
    "group": "II. 連絡先",
    "type": "textarea",
    "placeholder": "氏名 / 役職 / 実務用メールアドレス"
  },
  {
    "name": "TRANSACTION_MODEL",
    "label": "取引モデル",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "select",
    "required": true,
    "options": [
      "License-Out",
      "Product-Out",
      "Both"
    ],
    "helpText": "License-Out＝先方が製造（Schedule 1 のみ出力）／Product-Out＝自社が製造・供給（Schedule 2 のみ出力）／Both＝両方出力"
  },
  {
    "name": "BOTH_MODEL_SCOPE",
    "label": "Both を選んだ場合の適用範囲",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "textarea",
    "helpText": "取引モデルが Both のときだけ出力されます"
  },
  {
    "name": "GAME_TITLE",
    "label": "作品名（Game Title）",
    "group": "III. 取引条件（Deal Sheet）",
    "required": true,
    "dbField": "work.title",
    "helpText": "「DBから引用」で作品台帳から入力できます"
  },
  {
    "name": "LOCALIZED_PRODUCT",
    "label": "現地版製品／エディション",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "textarea",
    "placeholder": "製品名・版・形態・同梱コンポーネント"
  },
  {
    "name": "TERRITORY",
    "label": "テリトリー",
    "group": "III. 取引条件（Deal Sheet）",
    "required": true,
    "placeholder": "例: Republic of Korea"
  },
  {
    "name": "LANGUAGE",
    "label": "言語",
    "group": "III. 取引条件（Deal Sheet）",
    "required": true,
    "placeholder": "例: Korean"
  },
  {
    "name": "SALES_CHANNELS",
    "label": "販売チャネル",
    "group": "III. 取引条件（Deal Sheet）",
    "placeholder": "Retail / wholesale / e-commerce / crowdfunding / other"
  },
  {
    "name": "EXCLUSIVITY",
    "label": "独占／非独占",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "select",
    "required": true,
    "options": [
      "Exclusive",
      "Non-Exclusive"
    ]
  },
  {
    "name": "RESERVED_RIGHTS",
    "label": "留保権利・留保チャネル",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "textarea",
    "placeholder": "自社直販・指定取引先・デジタル版・クラウドファンディング等"
  },
  {
    "name": "INITIAL_TERM_END",
    "label": "初期契約期間の満了日（英語表記）",
    "group": "III. 取引条件（Deal Sheet）",
    "required": true,
    "placeholder": "例: August 31st, 2029"
  },
  {
    "name": "RENEWAL_TYPE",
    "label": "更新",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "select",
    "options": [
      "None",
      "Automatic"
    ]
  },
  {
    "name": "RENEWAL_YEARS",
    "label": "自動更新期間（年）",
    "group": "III. 取引条件（Deal Sheet）",
    "placeholder": "例: 2 (two)"
  },
  {
    "name": "RENEWAL_NOTICE_MONTHS",
    "label": "不更新通知の期限（満了何か月前）",
    "group": "III. 取引条件（Deal Sheet）",
    "placeholder": "例: 3"
  },
  {
    "name": "SELL_OFF_DAYS",
    "label": "売り切り期間（日）",
    "group": "III. 取引条件（Deal Sheet）",
    "placeholder": "例: 90"
  },
  {
    "name": "TARGET_RELEASE_DATE",
    "label": "目標発売日（英語表記）",
    "group": "III. 取引条件（Deal Sheet）",
    "placeholder": "例: August 31st, 2027"
  },
  {
    "name": "OUTSIDE_RELEASE_DATE",
    "label": "最終発売期限（英語表記）",
    "group": "III. 取引条件（Deal Sheet）",
    "helpText": "第14条・各 Schedule の失権事由の起点",
    "placeholder": "例: December 31st, 2027"
  },
  {
    "name": "SOURCE_MATERIALS_LANGUAGE",
    "label": "提供素材の言語",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "select",
    "options": [
      "Japanese",
      "English",
      "Other"
    ],
    "helpText": "Japanese が既定。英語版の作成義務は負わない建て付け（Master 第3.2条）"
  },
  {
    "name": "SOURCE_MATERIALS_LANGUAGE_OTHER",
    "label": "提供素材の言語（その他）",
    "group": "III. 取引条件（Deal Sheet）"
  },
  {
    "name": "AGREEMENT_CURRENCY",
    "label": "契約通貨",
    "group": "III. 取引条件（Deal Sheet）",
    "type": "select",
    "options": [
      "USD",
      "EUR",
      "JPY",
      "Other"
    ]
  },
  {
    "name": "AGREEMENT_CURRENCY_OTHER",
    "label": "契約通貨（その他）",
    "group": "III. 取引条件（Deal Sheet）"
  },
  {
    "name": "ANNEX_1_INCLUDED",
    "label": "付属書1（ローカライズ変更マトリクス）を組み込む",
    "group": "IV. 付属文書・準拠法",
    "type": "boolean",
    "helpText": "別紙本体は「IGLA 付属書」テンプレートで作成し、同じ選択にそろえてください"
  },
  {
    "name": "ANNEX_2_INCLUDED",
    "label": "付属書2（進行・生産スケジュール）を組み込む",
    "group": "IV. 付属文書・準拠法",
    "type": "boolean",
    "helpText": "カットオフ価格ティア表。Product-Out では実質必須"
  },
  {
    "name": "ANNEX_3_INCLUDED",
    "label": "付属書3（出荷指示）を組み込む",
    "group": "IV. 付属文書・準拠法",
    "type": "boolean"
  },
  {
    "name": "OTHER_DOCUMENTS",
    "label": "その他の組込文書",
    "group": "IV. 付属文書・準拠法",
    "type": "textarea",
    "helpText": "名称・版・日付。ここに明記しない文書は組み込まれません"
  },
  {
    "name": "DISPUTE_RESOLUTION",
    "label": "紛争解決",
    "group": "IV. 付属文書・準拠法",
    "type": "select",
    "required": true,
    "options": [
      "Court",
      "Arbitration"
    ],
    "helpText": "Court＝東京地裁専属合意／Arbitration＝JCAA仲裁（東京・英語）"
  },
  {
    "name": "ARBITRATOR_COUNT",
    "label": "仲裁人の数",
    "group": "IV. 付属文書・準拠法",
    "type": "select",
    "options": [
      "one",
      "three"
    ],
    "helpText": "紛争解決で Arbitration を選んだ場合のみ出力"
  },
  {
    "name": "ROYALTY_RATE",
    "label": "ロイヤリティ料率（%）",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: 8"
  },
  {
    "name": "ROYALTY_BASE",
    "label": "ロイヤリティ算定基礎",
    "group": "V. Schedule 1（License-Out）",
    "type": "select",
    "options": [
      "Net Sales",
      "MSRP",
      "Wholesale Price",
      "Other"
    ],
    "helpText": "MSRP＝MSRP×製造部数。Net Sales の控除項目は Schedule 1 第1.1条で限定列挙"
  },
  {
    "name": "ROYALTY_BASE_OTHER",
    "label": "ロイヤリティ算定基礎（その他）",
    "group": "V. Schedule 1（License-Out）"
  },
  {
    "name": "MINIMUM_GUARANTEE",
    "label": "ミニマムギャランティ（MG）",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea",
    "placeholder": "金額 / 支払期日 / 充当方法"
  },
  {
    "name": "ADVANCE_ROYALTY",
    "label": "前払ロイヤリティ",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea",
    "placeholder": "金額 / 支払期日 / 回収方法"
  },
  {
    "name": "ACCOUNTING_PERIOD",
    "label": "計算期間",
    "group": "V. Schedule 1（License-Out）",
    "type": "select",
    "options": [
      "Quarterly",
      "Semi-annually"
    ]
  },
  {
    "name": "ACCOUNTING_PERIOD_END",
    "label": "計算期間の締め",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: June and December"
  },
  {
    "name": "SALES_REPORT_DAYS",
    "label": "売上報告の提出期限（日）",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: 30"
  },
  {
    "name": "PAYMENT_DAYS",
    "label": "支払期限（請求書受領後・日）",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: 30"
  },
  {
    "name": "FIRST_PRINT_RUN_MIN",
    "label": "初版最低製造部数",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: 3,000"
  },
  {
    "name": "APPROVED_MANUFACTURERS",
    "label": "承認製造者",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea",
    "placeholder": "工場名または承認手続"
  },
  {
    "name": "COMPLIMENTARY_COPIES",
    "label": "献本部数",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: 12"
  },
  {
    "name": "CREDIT_WORDING",
    "label": "クレジット表記",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea"
  },
  {
    "name": "SAMPLE_APPROVAL_PLAN",
    "label": "サンプル・承認計画",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea",
    "placeholder": "デジタル校正 / PPC / MPC / 時期 / 修正権 / 費用"
  },
  {
    "name": "MARKETING_COMMITMENT",
    "label": "マーケティング義務",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea"
  },
  {
    "name": "EXCLUSIVITY_PERFORMANCE",
    "label": "独占維持条件",
    "group": "V. Schedule 1（License-Out）",
    "type": "textarea",
    "placeholder": "最低販売数 / 増刷 / 継続販売の要件"
  },
  {
    "name": "FX_RATE_SOURCE",
    "label": "為替レートの出典（第2.2条）",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: the Bank of Japan published rate"
  },
  {
    "name": "FX_RATE_DATE",
    "label": "為替レートの基準日（第2.2条）",
    "group": "V. Schedule 1（License-Out）",
    "placeholder": "例: the last Business Day of the period"
  },
  {
    "name": "PRODUCT_SKU",
    "label": "製品／SKU",
    "group": "VI. Schedule 2（Product-Out）"
  },
  {
    "name": "CAMPAIGN_ID",
    "label": "生産キャンペーンID",
    "group": "VI. Schedule 2（Product-Out）"
  },
  {
    "name": "APPROVED_SPECIFICATIONS",
    "label": "承認仕様",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "版 / 日付 / 付属書参照"
  },
  {
    "name": "PRICING_METHOD",
    "label": "価格方式",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "select",
    "options": [
      "Firm",
      "Variable"
    ],
    "helpText": "Firm＝最低確約数量による確定単価／Variable＝合計生産数連動の暫定単価"
  },
  {
    "name": "MCQ",
    "label": "最低確約数量（MCQ・units）",
    "group": "VI. Schedule 2（Product-Out）"
  },
  {
    "name": "AGGREGATE_PRODUCTION_ASSUMPTION",
    "label": "合計生産想定数（units）",
    "group": "VI. Schedule 2（Product-Out）",
    "helpText": "明記しない限り拘束力なし"
  },
  {
    "name": "PROVISIONAL_UNIT_PRICE",
    "label": "暫定単価",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: USD 6.20"
  },
  {
    "name": "PROVISIONAL_ASSUMED_QTY",
    "label": "暫定単価の前提数量",
    "group": "VI. Schedule 2（Product-Out）"
  },
  {
    "name": "DOWNWARD_TRUE_UP",
    "label": "下方精算（True-Up）",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "select",
    "options": [
      "Yes",
      "No"
    ]
  },
  {
    "name": "TRUE_UP_FORMULA",
    "label": "下方精算の算式",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea"
  },
  {
    "name": "QUANTITY_TOLERANCE_PCT",
    "label": "数量過不足許容（%）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 3"
  },
  {
    "name": "TOLERANCE_TREATMENT",
    "label": "許容超過・不足の取扱い",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea"
  },
  {
    "name": "INCLUDED_LOCALIZATION_CHANGES",
    "label": "価格に含まれる版変更",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "placeholder": "対象コンポーネントと含まれる改訂回数"
  },
  {
    "name": "ADDITIONAL_CHANGE_CHARGES",
    "label": "追加変更費用",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "placeholder": "料率 / 実費 / 手数料"
  },
  {
    "name": "DEPOSIT_PCT",
    "label": "着手金（%）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 30"
  },
  {
    "name": "DEPOSIT_TIMING",
    "label": "着手金の支払時期",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: upon PO acceptance"
  },
  {
    "name": "BALANCE_PCT",
    "label": "残金（%）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 70"
  },
  {
    "name": "BALANCE_TIMING",
    "label": "残金の支払時期",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: before shipment"
  },
  {
    "name": "INCOTERMS_RULE",
    "label": "インコタームズ規則（2020）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: FOB"
  },
  {
    "name": "NAMED_PLACE",
    "label": "指定地",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: Port of Yokohama, Japan"
  },
  {
    "name": "DESTINATIONS_QUANTITIES",
    "label": "仕向地と数量",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "helpText": "詳細は付属書3。ここには概要を記載"
  },
  {
    "name": "SHIPPING_DOCUMENTS",
    "label": "出荷書類",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "placeholder": "パッキングリスト / インボイス / 工場数量報告 / B-L・AWB 等"
  },
  {
    "name": "SAMPLE_VERIFICATION_METHOD",
    "label": "PPC／MPC・検証方法",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "placeholder": "デジタルデータ / 動画 / PPC / MPC・数量・承認の効果・修正可否・費用"
  },
  {
    "name": "TARGET_SHIPMENT_WINDOW",
    "label": "目標出荷時期",
    "group": "VI. Schedule 2（Product-Out）",
    "helpText": "見込みであり保証ではない旨が条文に明記されています"
  },
  {
    "name": "PO_CURRENCY",
    "label": "発注通貨",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: USD"
  },
  {
    "name": "DEDICATED_TOOLING",
    "label": "専用治工具",
    "group": "VI. Schedule 2（Product-Out）",
    "type": "textarea",
    "placeholder": "所有 / 保管 / 保守 / 廃棄 / 移管費用"
  },
  {
    "name": "REVISED_TERMS_ACCEPT_DAYS",
    "label": "改定条件の受諾期限（営業日・第1.6条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: five (5)"
  },
  {
    "name": "SAMPLE_REVIEW_DAYS",
    "label": "サンプル確認期限（営業日・第6.3条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: five (5)"
  },
  {
    "name": "MIN_SALES_PCT",
    "label": "最低販売比率（%・第13.1条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 70"
  },
  {
    "name": "MIN_SALES_MONTHS",
    "label": "最低販売の達成期間（月・第13.1条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 24"
  },
  {
    "name": "REPRINT_CONSULT_YEARS",
    "label": "増刷協議の対象期間（年・第13.2条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: two (2)"
  },
  {
    "name": "REPRINT_INVENTORY_PCT",
    "label": "増刷協議の在庫閾値（%・第13.2条）",
    "group": "VI. Schedule 2（Product-Out）",
    "placeholder": "例: 10"
  }
]$json$::jsonb,
       'ARC-TPL-IGLA-001 初版（IGLA Draft Rev.6 ベース・条文無改変）', 'legalbridge-v2'
  FROM template;

-- 注意: CTE 内の INSERT 行は同一文の外側 UPDATE から見えない（Postgres の仕様）。
-- current_version_id の差し替えは必ず別文で行う。
UPDATE document_templates t SET current_version_id = v.id
  FROM document_template_versions v
 WHERE t.template_key = 'igla_license_en' AND v.template_id = t.id AND v.version_no = 1;

SELECT t.template_key, t.document_prefix, t.current_version_id, v.version_no,
       jsonb_array_length(v.field_schema::jsonb) AS fields
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'igla_license_en';

COMMIT;
