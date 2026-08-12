\set ON_ERROR_STOP on
\pset pager off

-- 050_license_out_template.sql
-- ライセンスアウト英文契約（LICENSE AGREEMENT / ARC-TPL-LICENSE-OUT-001）のテンプレート投入。
--   ベース: Night Parade / Korea Boardgames 韓国語版ライセンス契約（条文の文言は無改変）。
--   Handlebars 変数 23 個・Schedule No.1（A.1〜A.13）方式。
--   フォームは 締結・当事者／作品・権利表示／対価／期間・数量・報告 の4グループ。
--   ライセンシー3欄は取引先マスタ、原題は作品台帳から「DBから引用」可能（dbField）。
--   採番: ARC-LOUT-<年>-<連番>。record_type は 'license' を含むキーのため license_condition。
-- 改訂時は document_template_versions に新版を INSERT し current_version_id を差し替えること。

\if :{?confirm_license_out}
\else
  \echo 'Run with: -v confirm_license_out=SEED_LICENSE_OUT_TEMPLATE'
  \quit 2
\endif
SELECT :'confirm_license_out' = 'SEED_LICENSE_OUT_TEMPLATE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_templates WHERE template_key = 'license_out_en') THEN
    RAISE EXCEPTION 'license_out_en は登録済みです（改訂は versions に新版を追加してください）';
  END IF;
END $$;

WITH template AS (
  INSERT INTO document_templates (template_key, kind, label, category, document_prefix)
  VALUES ('license_out_en', 'document', 'LICENSE AGREEMENT（ライセンスアウト・英文）', 'License', 'ARC-LOUT')
  RETURNING id
)
INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
SELECT id, 1, $TPL$<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LICENSE AGREEMENT &mdash; Arclight LegalBridge template</title>
<!--
  LegalBridge 契約テンプレート
  テンプレートID : ARC-TPL-LICENSE-OUT-001
  ベース         : Night Parade / Korea Boardgames 韓国語版ライセンス契約（本文の文言は無改変）
  記法           : Handlebars（{{VARIABLE}}）
  変数           : 23 個
  COMMENCEMENT_DATE          締結日
  LICENSEE_NAME              ライセンシー名称
  LICENSEE_ADDRESS           ライセンシー所在地
  LICENSEE_TAX_ID            納税者番号
  LICENSEE_REPRESENTATIVE    代表者氏名
  LICENSEE_REP_TITLE         代表者役職
  GAME_TITLE                 原題（A.1／Clause 1.1）
  TERRITORIES                テリトリー（A.2）
  LANGUAGE_VERSIONS          言語版（A.3）
  FIRST_PUBLICATION_YEAR     初出年（A.4）
  RELEASE_YEAR               発売年（A.4）
  GAME_DESIGNER              ゲームデザイナー（A.4／A.5）
  ILLUSTRATOR                イラストレーター（A.5）
  LICENSE_FEE                ライセンス料（A.6）
  ESTIMATED_MSRP             想定MSRP（A.6）
  ADVANCE_PAYMENT            前払金（A.7）
  COMP_COPIES_FIRST          献本 初版（A.8）
  COMP_COPIES_REPRINT        献本 増刷（A.8）
  AGREEMENT_END_DATE         契約満了日（A.10）
  RENEWAL_PERIOD             自動更新期間（A.10）
  TARGET_RELEASE_DATE        目標発売日（A.11）
  MIN_FIRST_EDITION_VOLUME   初版最低部数（A.12）
  SALES_REPORT_TIMING        売上報告時期（A.13）

  条項ルール
  R1  条（Clause）は 1〜18。すべて表題を持つ。
  R2  項＝N.M。すべての条に必ず1項以上を置く（1項しかない条も N.1）。
  R3  1項＝1段落。算式・列挙は当該項内の従属要素として置く。
  R4  すべての項に走り込み見出し（太字）を付す。
  R5  号＝(a)(b)(c)。列挙にのみ用いる。
  R6  相互参照は Clause N ／ Clause N.M ／ Schedule No. 1, Section A.x に統一。
-->
<style>

:root{
  --ink:#191c22; --ink-soft:#4a5058; --paper:#ffffff;
  --rule:#c9c4ba; --rule-soft:#e3dfd6;
  --xref:#2f6ca8;
  --slot-bg:#fbeecb; --slot-ink:#86601a; --slot-edge:#e5c983;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Noto Serif JP",serif;
}
.doc{
  background:var(--paper); color:var(--ink);
  font-family:var(--serif); font-size:10.5pt; line-height:1.55;
  text-align:justify; hyphens:auto;
}
.doc-title{
  font-size:11pt; font-weight:700; letter-spacing:.06em;
  text-align:center; margin:0 0 1.6em;
}
.doc p{margin:0 0 .85em;}
.doc .commenced{margin-left:2.6em;}
.doc .lead{margin-left:2.6em;}
.doc .conj{margin-left:2.8em;}
.doc .party{margin-left:2.6em; text-align:left;}
.doc .party--fill{padding:.15em 0;}
.doc em{font-style:italic;}
.xref{color:var(--xref); font-weight:700; white-space:normal;}
.doc .sub-head{margin-bottom:.35em;}
.doc .formula{margin:.9em 0 .9em 1em; text-align:left;}

ol.arts{counter-reset:art; list-style:none; margin:1.4em 0 0; padding:0;}
ol.arts > li.art{counter-increment:art; margin:0 0 1.5em; padding-left:3.2em; position:relative;}
ol.arts > li.art > h2{
  font-family:var(--serif); font-size:10.5pt; font-weight:700;
  margin:0 0 .55em; text-align:left;
}
ol.arts > li.art > h2::before{
  content:counter(art) "."; position:absolute; left:0; width:2.4em;
  font-weight:700; text-align:left;
}
ol.items{counter-reset:item; list-style:none; margin:.35em 0 .2em; padding:0;}
ol.items > li{counter-increment:item; position:relative; padding-left:2.2em; margin-bottom:.35em;}
ol.items > li::before{content:"(" counter(item, lower-alpha) ")"; position:absolute; left:.55em;}

ol.subs{counter-reset:sub; list-style:none; margin:.4em 0 0; padding:0;}
ol.subs > li{counter-increment:sub; position:relative; padding-left:3em; margin-bottom:.8em;}
ol.subs > li::before{
  content:counter(art) "." counter(sub); position:absolute; left:0;
  font-variant-numeric:tabular-nums; color:var(--ink-soft);
}
.rubric{font-weight:700;}
.rubric::after{content:"\00a0\00a0";}

.signatures{margin:3.2em 0 0; display:flex; gap:3em; flex-wrap:wrap;}
.sig{flex:1 1 240px;}
.sig-label{margin-bottom:1.4em !important;}
.sig-line{border-bottom:1px solid var(--ink); max-width:14em; margin-bottom:1.6em !important; padding-bottom:.1em;}
.sig-line--wide{max-width:22em;}

.schedule{margin-top:3.5em; break-before:page; page-break-before:always;}
.schedule-title{font-weight:700; margin-bottom:.9em !important;}
table.sched{width:100%; border-collapse:collapse; font-size:9.5pt; text-align:left;}
table.sched th, table.sched td{
  border:1px solid var(--rule); padding:.5em .7em; vertical-align:top; text-align:left;
  font-weight:400;
}
table.sched th{width:42%; background:#f7f5f0;}
table.sched .note{display:block; margin-top:.35em; color:var(--ink-soft); font-size:8.8pt;}
ul.cell-list{margin:0 0 .3em; padding-left:1.2em;}

.slot{
  background:var(--slot-bg); color:var(--slot-ink);
  box-shadow:inset 0 -1px 0 var(--slot-edge);
  padding:0 .28em; border-radius:2px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.86em; letter-spacing:-.01em; white-space:nowrap;
}
.slot.is-hit{animation:slotpulse 1.1s ease-out;}
@keyframes slotpulse{
  0%{background:#f6d98a;} 100%{background:var(--slot-bg);}
}
@media (prefers-reduced-motion:reduce){ .slot.is-hit{animation:none; background:#f6d98a;} }

body{margin:0; background:#e8e6e0;}
.page{width:210mm; min-height:297mm; margin:24px auto; padding:22mm 20mm; background:#fff;
      box-shadow:0 1px 3px rgba(0,0,0,.10), 0 12px 32px rgba(0,0,0,.09);}
@media print{
  body{background:#fff;}
  .page{width:auto; min-height:0; margin:0; padding:0; box-shadow:none;}
  @page{size:A4; margin:20mm;}
}
</style>
</head>
<body>
<div class="page">
<div class="doc" id="doc">

  <h1 class="doc-title">LICENSE AGREEMENT</h1>

  <p class="commenced">Commenced on {{COMMENCEMENT_DATE}}</p>

  <p class="lead">the Parties to which are:</p>

  <p class="party party--fill">{{LICENSEE_NAME}}, address: {{LICENSEE_ADDRESS}}, Tax registration
    number: {{LICENSEE_TAX_ID}}, Represented by {{LICENSEE_REPRESENTATIVE}},
    {{LICENSEE_REP_TITLE}} of the company (hereinafter referred to as the &ldquo;Licensee&rdquo;)</p>

  <p class="conj">And</p>

  <p class="party">Arclight Inc., address: Fuundo Bldg. 2F, 1-2 Kanda Ogawamachi, Chiyoda-ku,
    Tokyo-to 101-0052, Japan, Represented by Masayuki Aoyagi, CEO of the company (hereinafter
    referred to as the &ldquo;Licensor&rdquo;).</p>

  <ol class="arts">

    <li class="art">
      <h2>Subject of the Agreement</h2>
      <ol class="subs">
        <li><p><strong class="rubric">The Game</strong> This Agreement pertains to the game entitled
          <em>{{GAME_TITLE}}</em> (hereinafter referred to as the &ldquo;Game&rdquo;). The Licensor
          represents and warrants, to the best of their knowledge, that they are the sole owner of
          all rights to the Game. Based on this assurance, the Licensor and the Licensee agree to
          the terms set forth in this Agreement.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Grant of License</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Grant of Exclusive License</strong> The Licensor hereby grants
          to the Licensee an exclusive license to produce, market, distribute, and sell the board
          game version of the Game, as well as to promote and advertise the Game, within the
          language versions and territories specified in
          <span class="xref">Schedule No.&nbsp;1, Sections A.2 and A.3</span>. This license includes
          all sales channels, including but not limited to online sales.</p></li>
        <li><p><strong class="rubric">Promotional Materials and Items</strong> The Licensee may
          create and distribute promotional materials and items related to the Game for the purposes
          of marketing and promotion. However, prior to the production of such items, the Licensee
          must obtain the Licensor&rsquo;s written approval regarding their production, design, and
          marketing.</p></li>
        <li><p><strong class="rubric">Compliance and Territorial Exclusivity</strong> The Licensee
          shall comply with all applicable laws and regulations within the licensed territories. The
          Licensor agrees not to grant any third party the right to produce, market, distribute,
          sell, advertise, or promote the Game within the specified territories during the term of
          this Agreement.</p></li>
        <li>
          <p><strong class="rubric">Scope of License</strong> This license applies solely to the
            board game version of the Game. For the avoidance of doubt, the license does not include
            rights to:</p>
          <ol class="items">
            <li>Any digital or electronic versions, including but not limited to computer software,
              PC games, console games, online games, video games, and DVD games;</li>
            <li>Any entertainment or informational products or services, including but not limited
              to TV programs, films, music, video and audio recordings, and streaming content;</li>
            <li>Any merchandise or other physical products, including but not limited to apparel,
              accessories, plush items, stationery, books, newspapers, and magazines.</li>
          </ol>
        </li>
      </ol>
    </li>

    <li class="art">
      <h2>Creative Control and Approval</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Responsibility for Production and Sale</strong> The Licensee
          shall have full responsibility for overseeing the production and sale of the Game.
          However, any modifications to the Game&rsquo;s mechanics or rules must receive the prior
          written consent of the Licensor before production begins.</p></li>
        <li><p><strong class="rubric">Language Version and Approval of Changes</strong> The Licensor
          acknowledges that the language version specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.3</span> shall be developed by the
          Licensee under its own supervision. However, the Licensee agrees that any changes to the
          title under which the Game is marketed, as well as any modifications to the theme, game
          system, artwork, or rules, must be submitted to and approved by the Licensor in
          advance.</p></li>
        <li><p><strong class="rubric">Approval of Localized Game Data</strong> In addition, the
          Licensee must submit the finalized localized game data&mdash;including all text, graphic
          elements, and components&mdash;for Licensor approval prior to commencing production of the
          first print run, even if no changes have been made to the game mechanics or artwork. The
          Licensee shall also inform the Licensor in writing if the final number of copies in the
          first print run differs from the minimum quantity specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.12</span>.</p></li>
        <li><p><strong class="rubric">Manufacturing and Production</strong> The Licensee shall be
          responsible for the manufacturing and production of the Game, including but not limited to
          contract negotiations, ordering, inspection, and all other related matters with the
          manufacturers. The Licensee shall enter into appropriate agreements with the manufacturers
          regarding the quality, safety, and non-infringement of intellectual property rights of the
          manufactured products, and shall take necessary measures to ensure compliance. In the
          event of any disputes, including but not limited to non-conformity of the products,
          arising from the contract with the manufacturers, the Licensor shall bear no
          responsibility, and the Licensee shall not cause any detriment or damage to the
          Licensor.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Credits and Copyright Notice</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Credits</strong> All copies of the Game shall include
          appropriate credit to the Licensor and the Game&rsquo;s author(s), as specified in
          <span class="xref">Schedule No.&nbsp;1, Sections A.4 and A.5</span>.</p></li>
        <li><p><strong class="rubric">Licensee&rsquo;s Copyright Notice</strong> The Licensor agrees
          that the Licensee&rsquo;s edition of the Game&mdash;specifically the game box and
          rulebook&mdash;shall bear the Licensee&rsquo;s copyright notice as detailed in
          <span class="xref">Schedule No.&nbsp;1, Section A.4</span>.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Licensor Copies and Review of Updated Print Runs</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Complimentary Copies</strong> The Licensor shall receive, free
          of charge, a number of copies from the first and each subsequent updated print run of the
          Game, as specified in <span class="xref">Schedule No.&nbsp;1, Section A.8</span>. These
          copies shall be delivered to the Licensor immediately after production.</p></li>
        <li><p><strong class="rubric">Review of Updated Print Runs</strong> If any changes have been
          made to the Game since the previous print run, the Licensee shall inform the Licensor of
          such changes. If the Licensor reasonably determines that the changes are significant, the
          Licensor shall be entitled to review the updated version prior to granting approval for
          production of the new print run.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>License Fee, Payments, and Royalties</h2>
      <ol class="subs">
        <li><p><strong class="rubric">License Fee and Advance Payment</strong> The Licensee shall
          pay the Licensor the license fee in the amount specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.6</span>. Upon the commencement of this
          Agreement, the Licensee shall be invoiced by the Licensor for a non-refundable advance
          payment towards the license fee as outlined in
          <span class="xref">Schedule No.&nbsp;1, Section A.7</span>. This advance payment must be
          paid by the Licensee to the Licensor no later than 30 (thirty) days from the commencement
          of this Agreement.</p></li>
        <li><p><strong class="rubric">Application of the Advance Payment</strong> The advance
          payment of the first royalty fee shall be applied towards future royalty payments until an
          equal amount has been earned based on the formula in
          <span class="xref">Schedule No.&nbsp;1, Section A.6</span>.</p></li>
        <li><p><strong class="rubric">Production Quantity and Release Date Approval</strong> The
          Licensee is required to report the finalized production quantity and estimated release
          date to the Licensor for approval before full production may commence.</p></li>
        <li>
          <p><strong class="rubric">Calculation of Remaining License Fee on Fixed Cost
            Basis</strong> If the license fee is based on a percentage of the Manufacturer&rsquo;s
            Suggested Retail Price (MSRP), per-unit cost, or any other fixed cost method, the
            Licensee must pay the remaining balance of the initial license fee by the end of the
            month following the conclusion of production. This payment shall be calculated using the
            following formula:</p>
          <p class="formula"><strong>License Fee
            (<span class="xref">Schedule No.&nbsp;1, Section A.6</span>) &times; Number of Copies
            Produced</strong></p>
        </li>
        <li><p><strong class="rubric">Confirmation of the Finalized MSRP</strong> When reporting the
          end of production, the Licensee must also confirm the finalized MSRP to ensure accurate
          calculations.</p></li>
        <li><p><strong class="rubric">License Fee Based on Net Sales or Post-Sale
          Calculations</strong> If the license fee is based on a percentage of Net Sales, or any
          other method that can only be accurately calculated after sales have occurred, the
          Licensee shall be invoiced based on the formula in
          <span class="xref">Schedule No.&nbsp;1, Section A.6</span> and using the contents of the
          Sales Reports provided by the Licensee as outlined in
          <span class="xref">Clause 7.1</span>. Payments shall be made by the Licensee to the
          Licensor within 30 (thirty) days from the due date of the Sales Reports, as specified in
          <span class="xref">Clause 7.1</span>.</p></li>
        <li><p><strong class="rubric">Future Print Runs and Royalty Payments</strong> For future
          print runs of the Game, the Licensor shall invoice the Licensee for royalty payments based
          on the conditions and formula outlined in
          <span class="xref">Clauses 6.4 to 6.6</span>, once the Licensee notifies the Licensor
          regarding a new print run. This notification must include the number of copies being
          produced and any updates to the MSRP, if applicable.</p></li>
        <li><p><strong class="rubric">Reprints Without Changes</strong> If the new print run is
          based entirely on a version of the Game that has already been approved by the
          Licensor&mdash;without any changes to the content, components, or presentation&mdash;the
          Licensee is not required to seek prior approval to initiate the print run. However, the
          Licensee must notify the Licensor in writing within 10 (ten) business days of initiating
          the print run and confirm the number of copies being produced as well as any changes to
          the MSRP. If the Licensee fails to provide this notification within the required
          timeframe, the Licensor may, at its discretion, impose a fee of USD $0.20 per copy
          included in the unreported print run.</p></li>
        <li><p><strong class="rubric">Payment Method</strong> All payments shall be made by bank
          transfer to the Licensor&rsquo;s bank account as specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.9</span>.</p></li>
        <li><p><strong class="rubric">Currency Conversion</strong> If the initial payment
          calculations are made in a foreign currency but invoiced in Japanese Yen, the conversion
          rate shall be based on the TTS (Telegraphic Transfer Selling Rate) at the end of trading
          on the last day of the month preceding the invoice date, as provided by Mitsubishi UFJ
          Research and Consulting Co., Ltd.</p></li>
        <li><p><strong class="rubric">Withholding Tax</strong> If any payment under this Agreement
          is subject to withholding tax, the Licensee shall pay the withholding tax and deduct it
          from the payment. The Licensee must provide the Licensor with the official certificate of
          such payment without delay.</p></li>
        <li><p><strong class="rubric">Late Payment Penalties</strong> In the event of late payment
          by the Licensee that exceeds the original due date by more than 30 (thirty) calendar days,
          the Licensee shall be required to pay interest on the overdue amount at the statutory rate
          for late payments.</p></li>
        <li><p><strong class="rubric">Infringement and Penalties</strong> If any copies of the Game
          are sold in violation of the Licensor&rsquo;s rights, and the Licensor demonstrates that
          such infringement is due to the Licensee&rsquo;s actions or omissions, the Licensee shall
          pay a penalty equal to five times the license fee for the number of copies sold
          illicitly.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Sales Reports and Reporting Periods</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Sales Reports</strong> The Licensee shall provide sales
          reports for the Game at the timing and frequency as specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.13</span> (hereinafter collectively
          referred to as the &ldquo;Calculated Periods&rdquo; and individually as &ldquo;Each
          Calculated Period&rdquo;). These reports must be submitted to the Licensor within
          30 (thirty) days following the end of each Calculated Period, regardless of whether the
          royalty payments are fixed or variable.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Accounting and Audit Rights</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Records and Inspection</strong> The Licensee shall maintain
          detailed accounting records related to the Game. The Licensor, or a representative
          thereof, shall have the right to review the Licensee&rsquo;s books and records pertaining
          to the Game, provided that prior notice is given, which shall not be less than
          7 (seven) days.</p></li>
        <li><p><strong class="rubric">Cost of Audit</strong> In the event that an audit reveals
          discrepancies exceeding 5% of the reported sales value, the Licensee shall bear the cost
          of the audit.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Term and Termination</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Term and Automatic Renewal</strong> The validity period of
          this Agreement is specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.10</span>. Upon expiration of the
          initial term, the Agreement shall automatically renew for the duration specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.10</span>. The Agreement will continue
          to renew automatically at the end of each renewal period, unless either party provides
          official notice at least 1 (one) month prior to the end of the current term that they do
          not wish to renew. In such a case, the Agreement will terminate on the specified end
          date.</p></li>
        <li><p><strong class="rubric">Sale-Out Period</strong> If either party does not wish to
          renew the Agreement, the Licensee shall have the right to continue marketing,
          distributing, and selling the Game for up to 6 (six) months following the termination (the
          &ldquo;Sale-Out Period&rdquo;).</p></li>
        <li><p><strong class="rubric">Breach and Termination for Non-Compliance</strong> If either
          party fails to comply with any of its obligations under this Agreement, and such failure
          is not remedied within 30 (thirty) days following notice given by the other party by
          registered letter with acknowledgement of receipt, the non-breaching party may terminate
          the Agreement without further notice or delay.</p></li>
        <li><p><strong class="rubric">Termination for Insolvency or Business Cessation</strong>
          This Agreement shall terminate immediately if the Licensee ceases operations, enters
          liquidation, is placed in administration or receivership, or is declared bankrupt. Upon
          termination, all rights to the Game shall immediately revert to the Licensor. The Licensee
          shall remain obligated to fulfill its reporting and license fee payment obligations even
          after termination.</p></li>
        <li><p><strong class="rubric">Termination for Force Majeure</strong> Either party may
          terminate this Agreement by providing written notice if the other party is unable to
          perform its obligations due to a force majeure event for a continuous period exceeding
          90 (ninety) days.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Target Sales Date and First Edition Volume</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Target Release Date</strong> The date specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.11</span> shall be considered the
          anticipated target date for the commencement of sales of the Game. The Licensee shall make
          their best efforts, in good faith, to meet this deadline. However, no penalties shall
          apply in the event that sales do not commence by this target date.</p></li>
        <li><p><strong class="rubric">Progress Updates</strong> In such a case, the Licensee shall,
          upon request by the Licensor, provide a reasonable progress update, including the status
          of localization, the revised projected release schedule, and any known factors
          contributing to the delay.</p></li>
        <li><p><strong class="rubric">First Edition Volume</strong> The estimated production volume
          of the first edition of the Game is specified in
          <span class="xref">Schedule No.&nbsp;1, Section A.12</span>. Upon submitting the finalized
          localized game data for review and approval by the Licensor&mdash;prior to commencing
          production of the first print run&mdash;the Licensee shall inform the Licensor in writing
          if the final number of copies in the first print run differs from the minimum quantity
          specified in <span class="xref">Schedule No.&nbsp;1, Section A.12</span>.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Product Liability Insurance</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Licensee&rsquo;s Insurance Obligation</strong> The Licensee
          shall be responsible for obtaining and maintaining adequate product liability insurance
          for the Game, covering any potential claims, damages, or losses arising from the use or
          sale of the Game. The Licensee shall ensure that such insurance meets industry standards
          and provides sufficient coverage for the territories in which the Game is marketed and
          sold.</p></li>
        <li><p><strong class="rubric">Waiver of Insurance</strong> In the event that the Licensee
          determines that product liability insurance is not required, the Licensee shall promptly
          inform the Licensor and agree to assume full responsibility for any potential liabilities
          that may arise from the Game&rsquo;s distribution, including but not limited to claims for
          injury, damage, or defects associated with the Game.</p></li>
        <li><p><strong class="rubric">Indemnity for Distribution Claims</strong> The Licensor shall
          not be held liable for any claims arising out of the Game&rsquo;s distribution, and the
          Licensee agrees to indemnify and hold the Licensor harmless from any such claims or
          losses.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Assignment and Sublicensing</h2>
      <ol class="subs">
        <li><p><strong class="rubric">No Assignment or Sublicensing</strong> The Licensee shall not
          assign, transfer, or sublicense any rights or obligations under this Agreement to any
          third party without the prior written consent of the Licensor.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Confidentiality</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Confidentiality Obligation</strong> The Licensee agrees to
          treat as confidential and not disclose to any third party, without the prior written
          consent of the Licensor, any information received from the Licensor that is designated as
          confidential or would reasonably be understood to be confidential given the nature of the
          information and the circumstances of disclosure. This includes, but is not limited to,
          information regarding the Game, business strategies, pricing, product plans, technical
          data, trade secrets, and any other proprietary or sensitive information, whether disclosed
          verbally, in writing, or by any other means.</p></li>
        <li><p><strong class="rubric">Survival</strong> This obligation of confidentiality shall
          survive the termination or expiration of this Agreement for a period of two (2) years, or
          for as long as the information remains confidential and is not publicly known through no
          fault of the Licensee, whichever is longer.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Ownership and Legal Warranty</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Ownership of Names and Modifications</strong> The Licensee and
          Licensor agree that all names under which the Game is marketed, as well as all
          modifications to the Game, are the property of the Licensor.</p></li>
        <li><p><strong class="rubric">Licensor&rsquo;s Warranty</strong> The Licensor warrants that
          they are the sole and exclusive owner of all rights to the Game, that the Game is an
          original work, and that it does not infringe upon the rights of privacy, copyright, or any
          other intellectual property rights of any third party. The Licensor further represents
          that the Game is not libelous or otherwise unlawful.</p></li>
        <li><p><strong class="rubric">Indemnification</strong> If any claim, action, or proceeding
          is brought against the Licensee arising from an actual or alleged breach of the
          representations or warranties made herein by the Licensor, and provided the Licensee gives
          the Licensor prompt written notice of such claim, the Licensor agrees to defend,
          indemnify, and hold harmless the Licensee from any resulting loss, expense, or
          damage.</p></li>
        <li><p><strong class="rubric">Conduct of Claims</strong> The Licensor shall have the sole
          right to select legal counsel and to manage or settle any such claim, action, or
          proceeding.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Entire Agreement and Amendments</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Entire Agreement</strong> This Agreement constitutes the
          entire understanding between the Parties with respect to the subject matter herein and
          supersedes all prior agreements, negotiations, and communications, whether written or
          oral.</p></li>
        <li><p><strong class="rubric">Amendments</strong> Any amendments or additions to this
          Agreement must be made in writing and signed by both Parties. Any modifications not made
          in this manner shall be deemed null and void.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Governing Law and Dispute Resolution</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Governing Law and Jurisdiction</strong> This Agreement shall
          be governed by and construed in accordance with the laws of Japan. The Parties agree that
          any disputes arising out of or in connection with this Agreement shall fall under the
          exclusive jurisdiction of the Tokyo District Court in Japan.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Prohibited Affiliations</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Representation and Warranty</strong> Each party represents and
          warrants that neither it nor any of its officers, directors, or controlling persons is
          currently involved with, or affiliated with, any criminal organization or group engaged in
          illegal, fraudulent, or violent activities. Each party further agrees not to engage in or
          become affiliated with such entities during the term of this Agreement.</p></li>
        <li><p><strong class="rubric">Termination for Breach</strong> If either party breaches this
          representation and warranty, the other party may terminate this Agreement immediately
          without prior notice. In such a case, the breaching party shall be liable for any damages
          resulting from the termination.</p></li>
      </ol>
    </li>

    <li class="art">
      <h2>Severability</h2>
      <ol class="subs">
        <li><p><strong class="rubric">Severability</strong> If any provision of this Agreement is
          held to be invalid or unenforceable, such provision shall be deemed severed from this
          Agreement and shall not affect the validity or enforceability of the remaining provisions,
          which shall remain in full force and effect.</p></li>
      </ol>
    </li>

  </ol>

  <div class="signatures">
    <div class="sig">
      <p class="sig-label">Signed by Licensee</p>
      <p class="sig-line sig-line--wide">Name:</p>
      <p class="sig-line">Date:</p>
    </div>
    <div class="sig">
      <p class="sig-label">Signed by Licensor</p>
      <p class="sig-line sig-line--wide">Name:</p>
      <p class="sig-line">Date:</p>
    </div>
  </div>

  <div class="schedule">
    <p class="schedule-title">Schedule No. 1</p>
    <table class="sched">
      <tbody>
        <tr>
          <th>A.1 Original game title</th>
          <td>{{GAME_TITLE}}</td>
        </tr>
        <tr>
          <th>A.2 Territories encompassed</th>
          <td>{{TERRITORIES}}</td>
        </tr>
        <tr>
          <th>A.3 Language versions</th>
          <td>{{LANGUAGE_VERSIONS}}</td>
        </tr>
        <tr>
          <th>A.4 Information on the Licensor<span class="note">(on the side or back of the box and
            in the instruction manual)</span></th>
          <td>&copy; {{FIRST_PUBLICATION_YEAR}}-{{RELEASE_YEAR}} {{GAME_DESIGNER}} / Arclight, Inc.
            <span class="note">(on the side or back of the box and in the instruction
            manual)</span></td>
        </tr>
        <tr>
          <th>A.5 Information on the author(s) of the Game<span class="note">(on the box cover and
            in the instruction manual)</span></th>
          <td>
            <ul class="cell-list">
              <li>Game Designer: {{GAME_DESIGNER}}</li>
              <li>Illustrator: {{ILLUSTRATOR}}</li>
            </ul>
            <span class="note">(on the box cover and in the instruction manual)</span>
          </td>
        </tr>
        <tr>
          <th>A.6 License fee</th>
          <td>{{LICENSE_FEE}}<br>Estimated MSRP: {{ESTIMATED_MSRP}}<br>Invoiced at the end of
            production</td>
        </tr>
        <tr>
          <th>A.7 Advance payment</th>
          <td>{{ADVANCE_PAYMENT}}<br>Invoiced at the commencement of this agreement</td>
        </tr>
        <tr>
          <th>A.8 Complimentary copies</th>
          <td>The first edition of the Game: {{COMP_COPIES_FIRST}} copies. Subsequent Print Runs:
            {{COMP_COPIES_REPRINT}} copies whenever there has been a change from a previous print
            run.</td>
        </tr>
        <tr>
          <th>A.9 Licensor&rsquo;s bank account</th>
          <td>Beneficiary name: ARCLIGHT INC.<br>Beneficiary account number(USD):
            7000025<br>Beneficiary bank: Kiraboshi Bank, Ltd.<br>SWIFT code/BIC code:
            TOMIJPJT<br>Branch name: KANDA-CHUO BRANCH (Branch #013) Bank address: 3-3
            Kandaogawamachi, Chiyoda-ku, Tokyo-to 101-0052, Japan<br>Phone:
            +81-03-3293-5941<br>Banking details subject to change with written notice from
            Licensor.</td>
        </tr>
        <tr>
          <th>A.10 Period of the Agreement validity</th>
          <td>Until {{AGREEMENT_END_DATE}}<br>(Auto-renews for successive periods of
            {{RENEWAL_PERIOD}})</td>
        </tr>
        <tr>
          <th>A.11 Target Release Date of the Game</th>
          <td>Until {{TARGET_RELEASE_DATE}}</td>
        </tr>
        <tr>
          <th>A.12 Minimal volume of the first edition</th>
          <td>{{MIN_FIRST_EDITION_VOLUME}}</td>
        </tr>
        <tr>
          <th>A.13 Sales Report Submission Timing</th>
          <td>{{SALES_REPORT_TIMING}}, starting from the date the Game is released</td>
        </tr>
      </tbody>
    </table>
  </div>

</div>
</div>
</body>
</html>$TPL$, $json$[
  {
    "name": "COMMENCEMENT_DATE",
    "label": "締結日（英語表記）",
    "group": "I. 締結・当事者",
    "required": true,
    "placeholder": "例: July 15th, 2026",
    "helpText": "契約書冒頭 Commenced on に入る。英語の日付表記で記入"
  },
  {
    "name": "LICENSEE_NAME",
    "label": "ライセンシー名称",
    "group": "I. 締結・当事者",
    "required": true,
    "dbField": "vendor.vendor_name",
    "helpText": "[取引先] ボタンで自動入力（英文名は必要に応じて上書き）",
    "placeholder": "例: Korea Boardgames Co., Ltd."
  },
  {
    "name": "LICENSEE_ADDRESS",
    "label": "ライセンシー所在地（英語表記）",
    "group": "I. 締結・当事者",
    "required": true,
    "type": "textarea",
    "dbField": "vendor.address",
    "placeholder": "例: 10, Yopung-gil, Tanhyeon-myeon, Paju-si, Gyeonggi-do, Korea, 10862"
  },
  {
    "name": "LICENSEE_TAX_ID",
    "label": "納税者番号",
    "group": "I. 締結・当事者",
    "required": true,
    "placeholder": "例: 128-81-91230"
  },
  {
    "name": "LICENSEE_REPRESENTATIVE",
    "label": "代表者氏名（英語表記）",
    "group": "I. 締結・当事者",
    "required": true,
    "dbField": "vendor.vendor_rep",
    "placeholder": "例: Jerome Sung"
  },
  {
    "name": "LICENSEE_REP_TITLE",
    "label": "代表者役職（英語表記）",
    "group": "I. 締結・当事者",
    "required": true,
    "placeholder": "例: Vice president / CEO"
  },
  {
    "name": "GAME_TITLE",
    "label": "原題（対象作品・A.1）",
    "group": "II. 作品・権利表示",
    "required": true,
    "dbField": "work.title",
    "helpText": "[作品] ボタンで作品台帳から自動入力",
    "placeholder": "例: Night Parade"
  },
  {
    "name": "TERRITORIES",
    "label": "テリトリー（A.2）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: Korea"
  },
  {
    "name": "LANGUAGE_VERSIONS",
    "label": "言語版（A.3）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: Korean"
  },
  {
    "name": "FIRST_PUBLICATION_YEAR",
    "label": "初出年（A.4 コピーライト表記）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: 2025"
  },
  {
    "name": "RELEASE_YEAR",
    "label": "発売年（A.4 コピーライト表記）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: 2027"
  },
  {
    "name": "GAME_DESIGNER",
    "label": "ゲームデザイナー（A.4／A.5）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: Ibuink"
  },
  {
    "name": "ILLUSTRATOR",
    "label": "イラストレーター（A.5）",
    "group": "II. 作品・権利表示",
    "required": true,
    "placeholder": "例: Teeziro"
  },
  {
    "name": "LICENSE_FEE",
    "label": "ライセンス料（A.6）",
    "group": "III. 対価",
    "required": true,
    "helpText": "料率・基準を英語で記入（製造終了時に請求）",
    "placeholder": "例: 8% of the Net Price, excluding tax"
  },
  {
    "name": "ESTIMATED_MSRP",
    "label": "想定MSRP（A.6）",
    "group": "III. 対価",
    "required": true,
    "placeholder": "例: $11"
  },
  {
    "name": "ADVANCE_PAYMENT",
    "label": "前払金（A.7）",
    "group": "III. 対価",
    "required": true,
    "helpText": "契約開始時に請求（返金不可・ロイヤリティに充当）",
    "placeholder": "例: $2,000"
  },
  {
    "name": "COMP_COPIES_FIRST",
    "label": "献本 初版部数（A.8）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "placeholder": "例: 12"
  },
  {
    "name": "COMP_COPIES_REPRINT",
    "label": "献本 増刷部数（A.8）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "helpText": "前刷から変更があった増刷ごと",
    "placeholder": "例: 3"
  },
  {
    "name": "AGREEMENT_END_DATE",
    "label": "契約満了日（A.10・英語表記）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "placeholder": "例: August 31st, 2028"
  },
  {
    "name": "RENEWAL_PERIOD",
    "label": "自動更新期間（A.10・英語表記）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "helpText": "満了1か月前までに不更新通知が無ければ自動更新",
    "placeholder": "例: 2 (two) years"
  },
  {
    "name": "TARGET_RELEASE_DATE",
    "label": "目標発売日（A.11・英語表記）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "placeholder": "例: August 31st, 2027"
  },
  {
    "name": "MIN_FIRST_EDITION_VOLUME",
    "label": "初版最低部数（A.12）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "placeholder": "例: 5,000"
  },
  {
    "name": "SALES_REPORT_TIMING",
    "label": "売上報告時期（A.13・英語表記）",
    "group": "IV. 期間・数量・報告",
    "required": true,
    "helpText": "発売日起点。報告は各計算期間終了後30日以内",
    "placeholder": "例: End of every January and July"
  }
]$json$::jsonb,
         'ARC-TPL-LICENSE-OUT-001 初版（Night Parade/KBG ベース・条文無改変）', 'legalbridge-v2'
  FROM template;

-- 注意: CTE 内の INSERT 行は同一文の外側 UPDATE から見えない（Postgres の仕様）。
-- current_version_id の差し替えは必ず別文で行う。
UPDATE document_templates t SET current_version_id = v.id
  FROM document_template_versions v
 WHERE t.template_key = 'license_out_en' AND v.template_id = t.id AND v.version_no = 1;

SELECT t.template_key, t.document_prefix, t.current_version_id, v.version_no,
       jsonb_array_length(v.field_schema::jsonb) AS fields
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'license_out_en';

COMMIT;
