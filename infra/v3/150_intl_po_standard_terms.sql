-- =====================================================================
-- 150 海外発注書：基本契約なしのとき、標準約款（Cross-Border Spot Order 用）を末尾に付ける
--
--   約款は PR #130（V2 の infra/gcp/sql/081）で作った Cross-Border Spot Order 用の
--   STANDARD TERMS AND CONDITIONS FOR SERVICE OUTSOURCING（2026 改訂版・全 18 条）。
--   081 は約款を海外発注書の本文に直接足していた。V3 の 148 は本文を丸ごと置き換え、
--   約款は部分テンプレート（{{> 名前}}）だけを拾う作りだったので、081 の約款が落ちていた。
--
--   1. 081 の約款を部分テンプレート terms_spot_intl_2026 として登録する
--      （本文は infra/v3/templates/terms_spot_intl_2026.html。081 と同じ。文書番号だけ
--       V3 の ORDER_NO でも埋まるようにした）。
--   2. 海外発注書の現行版の </body> の前に
--        {{#unless HAS_BASE_CONTRACT}}{{> terms_spot_intl_2026}}{{/unless}}
--      を足した新しい版を作り、現行版にする。項目の宣言（variables）は引き継ぐ。
--   何度流しても同じ（登録済み・差し込み済みなら何もしない）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/150_intl_po_standard_terms.sql
--        （Cloud SQL Studio にそのまま貼ってもよい）
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'intl_purchase_order';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  terms_html constant text := $terms${{!-- 海外発注書の標準約款（Cross-Border Spot Order 用・2026 改訂版 Rev. 2026-09-28・全 21 条）。
     基本契約なしのとき、海外発注書の末尾に差し込む（infra/v3/151）。
     本文は Arclight_Standard_Terms_Service_Outsourcing_2026_Rev20260928_EN.pdf と同じ。
     原本の「Purchase Order No. [●]」には発注書番号を差し込む。 --}}
<section class="lb-intl-standard-terms"
  style="break-before:page; page-break-before:always; font-family:Arial,Helvetica,sans-serif; font-size:9.2pt; line-height:1.45; color:#111;">
  <div style="text-align:center; margin:0 0 7mm;">
    <div style="font-size:14pt; font-weight:700; letter-spacing:.02em;">STANDARD TERMS AND CONDITIONS FOR SERVICE OUTSOURCING</div>
    <div style="margin-top:2mm; font-size:9.5pt;">For Cross-Border Spot Orders — 2026 Revised Edition</div>
    <div style="margin-top:2mm; font-size:8.8pt; color:#444;">Exhibit to Purchase Order No. {{#if DOCUMENT_NUMBER}}{{DOCUMENT_NUMBER}}{{else}}{{ORDER_NO}}{{/if}}</div>
  </div>
  <p style="margin:0 0 1.4mm;">These Standard Terms and Conditions (the “Terms”) apply to the Purchase Order issued by Arclight, Inc. (the “Purchaser”) to the contractor identified in that Purchase Order (the “Contractor”) where no master agreement is specified. The Purchase Order and these Terms collectively constitute the “Agreement”. If any provision of the Purchase Order conflicts with these Terms, the Purchase Order shall prevail.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 1 — Formation of Agreement</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The Agreement is formed when the Contractor accepts the Purchase Order by signed copy, email or other electronic notice, commencement of the work, or any other unambiguous expression of acceptance.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Any material amendment to the scope, fee, delivery schedule or other material condition must be agreed in writing or by electronic communication.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 2 — Performance of Work; Independence</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The Contractor shall perform the services and produce the deliverables stated in the Purchase Order with reasonable professional skill, care and diligence.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. The Contractor acts as an independent contractor and is responsible for the method, personnel, equipment and working environment used to perform the services. Nothing in the Agreement creates an employment, partnership, joint venture or agency relationship.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 3 — Remuneration; Changes in Scope</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The remuneration shall be the amount stated in the Purchase Order.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. If either party proposes a material change in scope, specifications, deliverables or schedule, the parties shall agree the corresponding fee and schedule adjustment before the additional work is performed.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. The Contractor is not entitled to additional remuneration for material additional work unless such work was requested or approved by the Purchaser in writing or by electronic communication. Where the Purchaser has requested such work, the parties shall promptly agree a reasonable adjustment of the remuneration in accordance with paragraph 2.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 4 — Delivery; Acceptance Inspection</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The Contractor shall deliver the deliverables by the deadline and in the manner stated in the Purchase Order or applicable specifications.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Unless another period is stated in the Purchase Order, the Purchaser shall inspect the deliverables within ten (10) business days after receipt and notify the Contractor of acceptance or non-conformity.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. If the Purchaser gives no such notice within the applicable inspection period, the deliverables shall be deemed accepted.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. If the Contractor anticipates that it will not meet a delivery deadline, it shall promptly notify the Purchaser of the reason and the expected delivery date. If a deliverable is not delivered by the deadline and the purpose of the Purchase Order can no longer reasonably be achieved (including where the deliverable is intended for a specific event or release date), the Purchaser may terminate the Agreement immediately by notice without a cure period.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 5 — Non-Conformity</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. If a deliverable fails to conform to the Agreement, the Purchaser may require correction or replacement within a reasonable period at no additional charge. If the Contractor fails to correct or replace the deliverable within such period, the Purchaser may, at its option, reduce the remuneration in proportion to the non-conformity or terminate the Agreement in whole or in part by notice.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Unless otherwise stated in the Purchase Order, the Purchaser may notify the Contractor of latent or subsequently discovered non-conformity within six (6) months after acceptance.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. The Contractor is not responsible for non-conformity caused solely by materials, specifications or instructions supplied by the Purchaser.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 6 — Payment; Taxes; Bank Charges</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. Payment timing, currency and payment method shall be as stated in the Purchase Order. If the Purchase Order does not state a payment date, and in any event, the Purchaser shall pay the remuneration no later than sixty (60) days after its receipt of the deliverables (or, for services without deliverables, after completion of the services), irrespective of the inspection period under Article 4.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Each party is responsible for taxes imposed on its own income. If the Purchaser is required by applicable law to deduct or withhold tax, the Purchaser may make the required deduction and remit it to the competent authority. Unless expressly agreed otherwise, no gross-up applies.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. Bank and remittance charges shall be allocated as stated in the Purchase Order.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. The Contractor shall, upon request, provide a certificate of residence and any other documents required to apply a reduced rate of, or exemption from, withholding tax under an applicable tax treaty. If such documents are not provided before the payment date, the Purchaser may withhold tax at the rate prescribed by Japanese domestic law.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">5. Unless the Purchase Order states otherwise, the remuneration is inclusive of any value-added, sales or similar taxes chargeable by the Contractor.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 7 — Intellectual Property Rights</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. Unless the Purchase Order expressly provides otherwise, all intellectual property rights in the deliverables shall belong to the Purchaser in accordance with paragraph 2, and the remuneration includes full consideration for such assignment.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Where ownership belongs to the Purchaser under paragraph 1, upon full payment the Contractor assigns to the Purchaser all transferable intellectual property rights in the deliverables, including the rights provided for in Articles 27 and 28 of the Copyright Act of Japan and any equivalent rights under other applicable laws, and including the right to modify, reproduce, distribute, publish, translate, adapt and otherwise exploit them worldwide for the full duration of such rights. Pending full payment, the Contractor grants the Purchaser a non-exclusive, worldwide and royalty-free licence to use the deliverables for the purposes of the Purchase Order.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. To the extent any right cannot validly be assigned, the Contractor grants the Purchaser an exclusive, worldwide, perpetual, irrevocable, transferable, sublicensable and royalty-free licence to exercise that right to the fullest extent permitted by law.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. To the fullest extent permitted by applicable law, the Contractor shall not assert moral rights or similar personal rights against the Purchaser or any person authorized by the Purchaser in connection with the permitted use of the deliverables.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">5. Intellectual property rights in materials owned by the Contractor before the Purchase Order or developed independently of it (“Background Materials”) remain with the Contractor. To the extent Background Materials are incorporated in the deliverables, the Contractor grants the Purchaser a non-exclusive, worldwide, perpetual, irrevocable, transferable, sublicensable and royalty-free licence to use them as part of, or in connection with, the deliverables.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 8 — Third-Party Rights; Generative AI</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The Contractor warrants that it has authority to perform the services and grant or assign the rights contemplated by the Agreement.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. The Contractor warrants that, excluding Purchaser-designated materials, the deliverables do not infringe third-party intellectual property rights.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. If third-party materials, fonts, images, software, AI-generated outputs or other third-party content are incorporated, the Contractor shall obtain all permissions necessary for the Purchaser’s intended use and, on request, disclose the applicable licence conditions.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. The Contractor shall indemnify the Purchaser against third-party claims arising from breach of this Article, except to the extent caused by Purchaser-designated materials.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">5. The Contractor shall not use generative artificial intelligence tools to create all or any part of the deliverables without the Purchaser’s prior written consent. Where such consent is given, the Contractor shall disclose the tools used and the portions of the deliverables concerned, and shall remain responsible under Article 7 and this Article.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 9 — Confidentiality</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. Each party shall keep confidential all non-public business, technical and commercial information received from the other party and use it only for purposes of the Agreement.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. This obligation does not apply to information that is public without breach, lawfully known before disclosure, lawfully obtained from a third party without restriction, or independently developed.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. The confidentiality obligation survives termination for five (5) years.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. The Contractor shall not publish or display unpublished deliverables, work-in-progress or project information in a portfolio, website, social media or other public channel without the Purchaser’s prior consent.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 10 — Data Protection</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. Each party shall comply with applicable privacy and data protection laws.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Where the Contractor processes personal data provided by the Purchaser, the Contractor shall: (a) use it only as necessary for the services and not disclose it to any third party (other than an approved subcontractor bound by equivalent obligations) without the Purchaser’s prior written consent; (b) implement reasonable technical and organizational safeguards at least equivalent to those required of the Purchaser under the Act on the Protection of Personal Information of Japan; (c) promptly report any personal-data incident to the Purchaser and cooperate in its remediation; (d) return or delete such personal data upon completion of the services or upon request; and (e) provide, upon request, information reasonably required for the Purchaser to comply with its obligations concerning the provision of personal data to a third party in a foreign country, including information on the personal data protection system of the Contractor’s country.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 11 — Assignment</h3>
  <p style="margin:0 0 1.4mm;">Neither party may assign or transfer the Agreement or any material right or obligation under it without the other party’s prior written consent, except that the Purchaser may assign the Agreement to an affiliate or successor in connection with a merger, corporate reorganization or transfer of the relevant business.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 12 — Subcontracting</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The Contractor shall not subcontract all or a material part of the services without the Purchaser’s prior written consent.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Approved subcontracting does not relieve the Contractor of responsibility. The Contractor shall impose equivalent confidentiality, intellectual property and data-protection obligations on the subcontractor.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 13 — Compliance with Laws</h3>
  <p style="margin:0 0 1.4mm;">Each party shall comply with all applicable laws and regulations relating to its performance of the Agreement, including applicable anti-bribery, sanctions, export-control and trade-control laws.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 14 — Organized Crime and Restricted Parties</h3>
  <p style="margin:0 0 1.4mm;">Each party represents that it is not controlled by an organized criminal group, terrorist organization or person subject to applicable asset-freeze or trade sanctions, and shall not use such persons in connection with the Agreement. A material breach of this Article entitles the other party to terminate the Agreement immediately.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 15 — Termination; Damages</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. If either party materially breaches the Agreement and fails to remedy the breach within a reasonable cure period after written notice, the non-breaching party may terminate the Agreement.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. The Purchaser may terminate the Agreement in whole or in part for convenience at any time before completion by notice to the Contractor. In such case, the Purchaser shall pay the compensation set out in Article 16 and reimburse reasonable out-of-pocket costs actually incurred by the Contractor for the purpose of the Agreement that cannot reasonably be cancelled or mitigated. Such payment shall be the Contractor’s sole remedy for termination under this paragraph.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">3. Either party may terminate the Agreement immediately by notice if the other party becomes insolvent, suspends payments, or becomes subject to bankruptcy, liquidation, rehabilitation or similar proceedings.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">4. Except for fraud, willful misconduct, gross negligence, breach of confidentiality, infringement of intellectual property rights, or liability that cannot legally be limited, each party’s aggregate liability arising from the Agreement shall not exceed the total remuneration payable under the Purchase Order.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">5. Except where prohibited by applicable law, neither party is liable for indirect, incidental, special or consequential damages. This paragraph does not limit the Contractor’s obligations under Article 8.4 or liability for the matters excluded under paragraph 4.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 16 — Settlement upon Early Termination</h3>
  <p style="margin:0 0 1.4mm;">If the Agreement terminates before completion for reasons not attributable to the Contractor, the Purchaser shall pay reasonable compensation for conforming services properly performed up to the effective date of termination, taking into account the agreed remuneration and degree of completion. No payment is due for defective, unusable or unperformed portions.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 17 — Force Majeure</h3>
  <p style="margin:0 0 1.4mm;">Neither party is liable for delay or failure to perform its obligations (other than payment obligations) to the extent caused by events beyond its reasonable control, including natural disasters, epidemics, war, acts of government and failures of public infrastructure, provided that it promptly notifies the other party. If such an event continues for more than thirty (30) days, either party may terminate the Agreement by notice, and Article 16 shall apply.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 18 — Notices</h3>
  <p style="margin:0 0 1.4mm;">Notices under the Agreement may be given by email to the addresses stated in the Purchase Order or subsequently notified by a party. A notice by email is effective when it reaches the recipient’s mail server, unless the sender receives a delivery-failure message.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 19 — Survival</h3>
  <p style="margin:0 0 1.4mm;">Articles 5.2, 6, 7, 8, 9, 10, 15, 16, 18, 20 and 21, and any other provisions which by their nature are intended to survive, shall survive the expiry or termination of the Agreement.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 20 — Governing Law; Jurisdiction</h3>
  <p style="margin:0 0 1.4mm;">The Agreement is governed by the laws of Japan, without regard to conflict-of-laws rules. The Tokyo District Court shall have exclusive jurisdiction as the court of first instance over any dispute arising out of or in connection with the Agreement.</p>
  <h3 style="font-size:10pt; margin:4.5mm 0 1.5mm; break-after:avoid; page-break-after:avoid;">Article 21 — Language; Matters Not Stipulated</h3>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">1. The governing language of the Agreement is English. Any translation is provided for convenience only unless the parties expressly agree otherwise.</p>
  <p style="margin:0 0 1.4mm; padding-left:1.4em; text-indent:-1.4em;">2. Any matter not stipulated in the Agreement shall be resolved through good-faith consultation between the parties.</p>
  <p style="margin:6mm 0 0; font-size:8pt; color:#555; text-align:right;">Arclight Standard Terms for Service Outsourcing — 2026 Revised Edition (Rev. 2026-09-28)</p>
</section>
$terms$;
  partial_id bigint;
  partial_cur text;
  next_no int;
  new_id bigint;
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
BEGIN
  -- 1. 部分テンプレート
  SELECT t.id, v.html_source INTO partial_id, partial_cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'terms_spot_intl_2026';
  IF partial_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, is_active)
    VALUES ('terms_spot_intl_2026', '海外発注書の標準約款（Cross-Border Spot Order 用）', 'partial', true)
    RETURNING id INTO partial_id;
  END IF;
  IF partial_cur IS DISTINCT FROM terms_html THEN
    SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
      FROM v3.document_template_versions WHERE template_id = partial_id;
    INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
    VALUES (partial_id, next_no, terms_html, '[]'::jsonb, '150: PR #130（081）の Cross-Border Spot Order 用 Standard Terms', 'sql:150')
    RETURNING id INTO new_id;
    UPDATE v3.document_templates SET current_version_id = new_id, category = 'partial', is_active = true
     WHERE id = partial_id;
    RAISE NOTICE '150: 約款 terms_spot_intl_2026 を登録（版 %）', next_no;
  ELSE
    RAISE NOTICE '150: 約款 terms_spot_intl_2026 は登録済み';
  END IF;

  -- 2. 海外発注書に差し込む
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, '{{> terms_spot_intl_2026}}') > 0 THEN
    RAISE NOTICE '150: 海外発注書には差し込み済み。何もしません';
    RETURN;
  END IF;
  IF strpos(src, 'lb-intl-standard-terms') > 0 THEN
    RAISE NOTICE '150: 現行版（版 %）は 081 の約款を本文に持っています（148 の前の版）。差し込みはしません', from_no;
    RETURN;
  END IF;
  IF strpos(src, '</body>') = 0 THEN
    RAISE EXCEPTION '</body> が見つかりません。146 で現行版を書き出して確かめてください';
  END IF;
  new_html := regexp_replace(src, '</body>',
    E'{{#unless HAS_BASE_CONTRACT}}\n{{> terms_spot_intl_2026}}\n{{/unless}}\n</body>');

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('150: 基本契約なしのとき標準約款（Cross-Border Spot Order 用）を末尾に付ける（%s 版から）', from_no), 'sql:150'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '150: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に差し込みがあり、約款が登録されていること。
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, '{{> terms_spot_intl_2026}}') > 0) AS 約款の差し込み,
       (strpos(v.html_source, '{{#unless HAS_BASE_CONTRACT}}') > 0) AS 基本契約なしのときだけ,
       (SELECT count(*) FROM v3.document_templates p
         WHERE p.template_key = 'terms_spot_intl_2026' AND p.category = 'partial' AND p.is_active) AS 約款の登録
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';
