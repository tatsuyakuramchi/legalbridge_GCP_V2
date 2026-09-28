-- =====================================================================
-- 150 海外発注書：基本契約なしのとき、標準約款（Schedule A）を末尾に付ける
--
--   V1 の海外発注書（0107）は Schedule A を本文にそのまま持っていた。148 は約款を
--   部分テンプレート（{{> 名前}}）として拾う作りだったので、見つからずに約款を
--   付けないまま新しい版を作っていた（NOTICE「約款は付けません」）。
--
--   1. V1 の Schedule A を部分テンプレート terms_spot_intl_2026 として登録する
--      （本文は infra/v3/templates/terms_spot_intl_2026.html。0107 と同じ）。
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
  terms_html constant text := $terms${{!-- 海外発注書の標準約款（Schedule A）。基本契約なしのとき、海外発注書の末尾に差し込む（150）。本文は V1 の 0107 と同じ。 --}}
<style>
  /* ── Part 2 (Schedule A) 用 ── */
  .terms-wrap { line-height: 1.7; font-size: 10pt; page-break-before: always; }
  .terms-doc-title { text-align: center; font-size: 14pt; font-weight: 700; letter-spacing: 0.05em; margin: 0 0 2mm 0; }
  .terms-ver { text-align: right; font-size: 9pt; color: #444; margin: 0 0 5mm 0; }
  .terms-lead { margin: 0 0 5mm 0; }
  .terms-h { font-size: 10.5pt; font-weight: 700; background: #f2f2f2; padding: 4px 9px; border-left: 4px solid #111; margin: 6mm 0 2.5mm 0; break-after: avoid; page-break-after: avoid; }
  .terms-ol { margin: 0 0 1.5mm 0; padding-left: 18px; }
  .terms-ol > li { margin: 0 0 1.8mm 0; }
  .terms-sub { list-style: none; padding-left: 0; margin: 1mm 0 0 0; }
  .terms-sub li { padding-left: 1.5em; text-indent: -1.5em; margin: 0 0 1.2mm 0; }
  .terms-wrap ol, .terms-wrap li { break-inside: avoid; page-break-inside: avoid; }
</style>
<!-- ════════ PART 2 — SCHEDULE A: INDEPENDENT CONTRACTOR STANDARD TERMS ════════ -->

<div class="terms-wrap">
  <div class="terms-doc-title">Schedule A — Independent Contractor Standard Terms</div>
  {{#if TERMS_VERSION_DATE}}<div class="terms-ver">({{TERMS_VERSION_DATE}})</div>{{/if}}

  <div class="terms-lead">
    These Standard Terms, together with each applicable Order Form, any Data Processing Addendum
    ("DPA"), and any incorporated specifications, constitute the entire agreement ("Agreement")
    between the Company and the Contractor.
  </div>

  <div class="terms-h">Article 1 — Order of Precedence</div>
  <ol class="terms-ol">
    <li>Where documents conflict, the following order governs:
      <table class="prec-table">
        <tr><td>(a)</td><td>Special Terms in the Order Form</td></tr>
        <tr><td>(b)</td><td>The Order Form or Statement of Work</td></tr>
        <tr><td>(c)</td><td>Any DPA (data protection matters only)</td></tr>
        <tr><td>(d)</td><td>These Standard Terms</td></tr>
      </table>
    </li>
    <li>No terms proposed by the Contractor — including terms on invoices, emails, or online forms — apply unless expressly accepted in writing by the Company.</li>
  </ol>

  <div class="terms-h">Article 2 — Formation of Agreement</div>
  <ol class="terms-ol">
    <li>Each Order Form becomes binding when the Contractor signs it, confirms acceptance in writing, or commences performance with knowledge of its terms. Silence does not constitute acceptance. The Company may withdraw any Order Form before acceptance.</li>
    <li>Each Order Form shall specify: services, deliverables, fees, payment due date, acceptance criteria, completion date, and any special requirements.</li>
  </ol>

  <div class="terms-h">Article 3 — Independent Contractor Status</div>
  <ol class="terms-ol">
    <li>The Contractor is an independent contractor, not an employee, agent, or partner of the Company. This Agreement does not create an employment relationship.</li>
    <li>The Contractor determines the manner and means of performing the services, subject to the requirements set out in the Order Form.</li>
    <li>The Contractor is solely responsible for all taxes, social security contributions, insurance, and regulatory obligations applicable in the Contractor's jurisdiction, except for taxes the Company is legally required to withhold.</li>
  </ol>

  <div class="terms-h">Article 4 — Services and Deliverables</div>
  <ol class="terms-ol">
    <li>The Contractor shall perform the services and provide the deliverables described in the Order Form with the skill, care, and diligence reasonably expected of a qualified professional in the relevant field.</li>
    <li>Unless the Order Form provides otherwise, the Contractor shall supply its own equipment and working environment at its own cost.</li>
  </ol>

  <div class="terms-h">Article 5 — Service Warranty; Remedies</div>
  <ol class="terms-ol">
    <li>The Contractor expressly warrants that: (i) all services will be performed with the skill, care, and diligence reasonably expected of a qualified professional; and (ii) all deliverables will conform to the description, quality, and specifications in the Order Form (the "<strong>Warranty</strong>").</li>
    <li>If any deliverable or service fails to satisfy the Warranty ("<strong>Non-Conforming Performance</strong>"), the Company may — by written notice within the period in Article 5.4 — elect one or more of the following contractual remedies (independent of any statutory regime): (i) <strong>Cure</strong> — require repair, replacement, or re-performance within a period designated by the Company; (ii) <strong>Fee Reduction</strong> — reduce fees in proportion to the deficiency where cure is unavailable or not timely; or (iii) <strong>Damages</strong> — claim compensation for direct loss, including costs of substitute performance.</li>
    <li>These remedies are cumulative.</li>
    <li>The Company must notify the Contractor in writing of Non-Conforming Performance within <strong>six (6) months</strong> after acceptance of the relevant deliverable or completion of services. This limitation does not apply where the deficiency is attributable to the Contractor's fraud, willful misconduct, or gross negligence.</li>
    <li>The Company shall not unilaterally reduce fees or reject deliverables on grounds outside this Article.</li>
  </ol>

  <div class="terms-h">Article 6 — Fees and Payment</div>
  <ol class="terms-ol">
    <li>The Company shall pay the fees stated in the Order Form (exclusive of taxes and withholding) on the payment due date stated in the Order Form.</li>
    <li>The Company shall not reduce agreed fees or delay payment except in accordance with this Agreement. If mandatory law requires a shorter payment period or stricter terms, such law prevails.</li>
    <li>Payment shall be made by wire transfer or equivalent, with all transfer charges borne by the Company (OUR) unless the Order Form states otherwise.</li>
    <li>Late payment accrues interest at {{LATE_PAYMENT_RATE}} per annum, calculated daily from the day after the due date until actual payment.</li>
  </ol>

  <div class="terms-h">Article 7 — Taxes and Withholding</div>
  <ol class="terms-ol">
    <li>All fees are exclusive of taxes unless the Order Form states otherwise. The Contractor is responsible for all taxes and charges applicable in the Contractor's jurisdiction, except for taxes the Company is legally required to withhold.</li>
    <li>If the Company is required to withhold tax, it shall do so and provide the Contractor with appropriate documentation. The Contractor shall provide any tax residency certificate, treaty form, or other documentation requested for tax compliance or treaty benefit purposes. The Company has no obligation to gross up withheld amounts unless the Order Form expressly provides otherwise.</li>
  </ol>

  <div class="terms-h">Article 8 — Delivery and Acceptance</div>
  <ol class="terms-ol">
    <li>The Contractor shall deliver each deliverable by the deadline and in the manner specified in the Order Form. The Company shall inspect and notify the Contractor of acceptance or rejection in accordance with the acceptance criteria and period in the relevant line item.</li>
    <li>If the Company gives no notification within the inspection period, the deliverable is deemed accepted for defects reasonably discoverable upon inspection — but deemed acceptance does not waive the Company's rights under Article 5 regarding latent defects.</li>
    <li>Acceptance of a deliverable does not limit the Company's rights under Article 5 with respect to latent defects or non-conforming performance not reasonably discoverable during the inspection period. Ownership and license rights in deliverables are governed by Article 9.</li>
  </ol>

  <div class="terms-h">Article 9 — Intellectual Property</div>
  <ol class="terms-ol">
    <li><strong>Assignment.</strong> Unless the Order Form specifies a license model, all IP rights in deliverables created by the Contractor for the Company are assigned to the Company upon full payment. The Contractor shall execute any documents needed to perfect the assignment. Where moral rights cannot be assigned, the Contractor agrees not to assert them against the Company or its licensees.</li>
    <li><strong>Background Materials.</strong> The Contractor retains ownership of pre-existing materials, tools, and know-how developed independently of this Agreement. To the extent Background Materials are incorporated into deliverables, the Contractor grants the Company a worldwide, perpetual, irrevocable, royalty-free, sublicensable license to use them as part of the deliverables.</li>
    <li><strong>Third-Party Materials.</strong> The Contractor shall not incorporate any third-party materials (including AI-generated content, open-source software, stock content, or images) into deliverables without first obtaining all necessary licenses and disclosing such materials to the Company in writing.</li>
  </ol>

  <div class="terms-h">Article 10 — AI Tools and Open-Source Software</div>
  <ol class="terms-ol">
    <li>The Contractor shall not use generative AI, code-generation, or similar tools unless approved in writing by the Company for the relevant Order Form. Where approved, the Contractor shall disclose upon request: the tool name and version; whether Company or personal data was input; and any restrictions on the Company's use of the output.</li>
    <li>The Contractor shall not input any personal data, confidential information, credentials, or non-public Company materials into any AI tool without the Company's prior written consent.</li>
    <li>The Contractor shall not incorporate open-source software into deliverables in any manner that would require the Company's proprietary code or data to be disclosed or licensed under open-source terms, without the Company's prior written approval.</li>
  </ol>

  <div class="terms-h">Article 11 — IP Warranties</div>
  <ol class="terms-ol">
    <li>The Contractor warrants that deliverables do not infringe any third-party intellectual property rights and that no third-party rights prevent the Company from using them as intended. Where third-party materials are incorporated, the Contractor shall hold all necessary licenses before delivery.</li>
    <li>If a third party brings a claim against the Company arising from the Contractor's breach of this Article, the Contractor shall defend and indemnify the Company at its own cost. This indemnity does not apply to claims arising from Company-Designated Materials.</li>
    <li>"<strong>Company-Designated Materials</strong>" are materials provided by or specifically directed by the Company. The Company warrants that it holds the rights needed for the Contractor's use. Claims arising from Company-Designated Materials are the Company's responsibility, except where caused by the Contractor's unauthorized use.</li>
  </ol>

  <div class="terms-h">Article 12 — Confidentiality</div>
  <ol class="terms-ol">
    <li>Each party shall keep the other's confidential information strictly confidential, not disclose it to third parties without prior written consent, and use it only for performance of this Agreement. Standard exceptions apply (public domain, independent development, legal compulsion with prior notice where permitted).</li>
    <li>These obligations survive termination for <strong>{{NDA_SURVIVAL_YEARS}} years</strong>.</li>
    <li>The Contractor shall obtain the Company's prior written consent before displaying any deliverables as portfolio items or on public channels.</li>
  </ol>

  <div class="terms-h">Article 13 — Personal Data Protection</div>
  <ol class="terms-ol">
    <li>The Contractor may process personal data only to the extent necessary for ordinary communications, payment administration, personnel or staff coordination, performance of the services, and delivery of the deliverables under the applicable Order Form.</li>
    <li>The Contractor shall not collect, copy, scan, photograph, export, disclose, transfer, or otherwise process any customer, visitor, lead, inquiry, end-user, or other third-party personal data unless the Company has expressly authorized such processing in writing.</li>
    <li>The Contractor shall implement reasonable technical and organizational measures to protect personal data handled in connection with this Agreement against unauthorized access, disclosure, loss, destruction, alteration, or misuse.</li>
    <li>The Contractor shall not disclose or transfer personal data to any third party, including subcontractors, staffing agencies, or assistants, except to the extent necessary for the performance of the services or with the Company's prior written consent.</li>
    <li>If the Contractor becomes aware of any actual or suspected unauthorized access, disclosure, loss, or misuse of personal data, the Contractor shall notify the Company promptly and cooperate in taking reasonable remedial measures.</li>
    <li>Upon completion of the services or upon the Company's request, the Contractor shall return or securely delete personal data received from or processed on behalf of the Company, unless retention is required by applicable law.</li>
    <li>If the Contractor is required to process customer data, visitor data, lead information, end-user data, or other personal data beyond the scope of Article 13.1, the parties shall agree in writing on additional data protection terms, including a data processing addendum where required by applicable law.</li>
  </ol>

  <div class="terms-h">Article 14 — Customer Flow-Down Requirements</div>
  <div>The Contractor shall comply with any customer-specific security, confidentiality, data protection, or compliance requirements notified by the Company in writing. If the Contractor cannot comply, it shall notify the Company before commencing the affected services.</div>

  <div class="terms-h">Article 15 — No Assignment</div>
  <div>The Contractor may not assign or transfer any rights or obligations under this Agreement without the Company's prior written consent. Any change of control of the Company does not give the Contractor a right to terminate.</div>

  <div class="terms-h">Article 16 — Subcontracting</div>
  <ol class="terms-ol">
    <li>The Contractor shall not engage any third party — including crowd-workers or AI-based agents — to perform any material part of the services without the Company's prior written consent.</li>
    <li>Approved subcontractors must be bound by obligations at least as protective as those in this Agreement. The Contractor remains fully liable for its subcontractors' acts and omissions.</li>
  </ol>

  <div class="terms-h">Article 17 — Sanctions; Anti-Corruption</div>
  <div>The Contractor warrants that it is not subject to any applicable sanctions list and has not violated any anti-bribery or anti-corruption law in connection with this Agreement. Breach of this Article entitles the Company to terminate immediately without compensation, and the Contractor shall indemnify the Company for resulting losses.</div>

  <div class="terms-h">Article 18 — Termination; Liability</div>
  <ol class="terms-ol">
    <li>The Company may terminate for the Contractor's material breach not cured within <strong>14 days</strong> of written notice. The Contractor may terminate for the Company's material breach not cured within <strong>30 days</strong> of written notice.</li>
    <li>Except for Excluded Claims, the Contractor's total liability under an Order Form shall not exceed the total fees paid or payable under that Order Form.</li>
    <li>Neither party shall be liable to the other for indirect, incidental, special, punitive, or consequential damages, including loss of profits, revenue, data, or business opportunity, except to the extent arising from Excluded Claims.</li>
    <li>"<strong>Excluded Claims</strong>" — to which no cap applies — means the Contractor's liability for: (i) fraud, willful misconduct, or gross negligence; (ii) breach of confidentiality; (iii) breach of data protection obligations; (iv) IP infringement or misappropriation; (v) breach of sanctions or anti-corruption obligations; or (vi) unauthorized subcontracting.</li>
  </ol>

  <div class="terms-h">Article 19 — Force Majeure</div>
  <ol class="terms-ol">
    <li>A party affected by an event genuinely beyond its reasonable control (excluding economic conditions, currency movements, cost increases, and personal circumstances of the Contractor) is excused from affected obligations during the event, provided it notifies the other party in writing within <strong>5 business days</strong> and uses reasonable efforts to mitigate.</li>
    <li>Fees for work performed or deliverables accepted before the event remain payable. If a Force Majeure Event affecting the Contractor persists for more than <strong>30 consecutive days</strong>, the Company may terminate immediately without compensation for unperformed work.</li>
  </ol>

  <div class="terms-h">Article 20 — Entire Agreement; Amendments</div>
  <div>This Agreement is the entire agreement on its subject matter and supersedes all prior representations and understandings. Amendments require written signatures of both parties, except that the Company may issue written instructions that supplement scope without altering fees or payment terms. No waiver of breach constitutes a waiver of future breaches.</div>

  <div class="terms-h">Article 21 — Settlement on Early Termination</div>
  <div>On early termination, fees shall be settled on a pro-rata basis reflecting work completed and accepted up to the termination date.</div>

  <div class="terms-h">Article 22 — Governing Law and Dispute Resolution</div>
  <div>The governing law and dispute resolution mechanism applicable to this Agreement shall be as stated in the Order Form. Where the Order Form does not specify, the parties shall agree in writing before commencing any dispute resolution process.</div>

  <div class="terms-h">Article 23 — Miscellaneous</div>
  <div>Unaddressed matters shall be resolved by good-faith discussion. If any provision is held invalid, the remainder continues in full force. These Terms prevail over any conflicting Contractor terms unless expressly agreed otherwise in writing.</div>

</div>
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
    VALUES ('terms_spot_intl_2026', '海外発注書の標準約款（Schedule A）', 'partial', true)
    RETURNING id INTO partial_id;
  END IF;
  IF partial_cur IS DISTINCT FROM terms_html THEN
    SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
      FROM v3.document_template_versions WHERE template_id = partial_id;
    INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
    VALUES (partial_id, next_no, terms_html, '[]'::jsonb, '150: V1（0107）の Schedule A', 'sql:150')
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
  IF strpos(src, 'Schedule A — Independent Contractor Standard Terms') > 0 THEN
    RAISE NOTICE '150: 現行版（版 %）は Schedule A を本文に持っています（148 の前の版）。差し込みはしません', from_no;
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
         format('150: 基本契約なしのとき標準約款（Schedule A）を末尾に付ける（%s 版から）', from_no), 'sql:150'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '150: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に差し込みがあり、約款が登録されていること。約款が使う項目の既定値も出す
-- （空だと「interest at  per annum」のように抜けて刷られる）。
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, '{{> terms_spot_intl_2026}}') > 0) AS 約款の差し込み,
       (strpos(v.html_source, '{{#unless HAS_BASE_CONTRACT}}') > 0) AS 基本契約なしのときだけ,
       (SELECT count(*) FROM v3.document_templates p
         WHERE p.template_key = 'terms_spot_intl_2026' AND p.category = 'partial' AND p.is_active) AS 約款の登録
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';

SELECT e->>'name' AS 項目, COALESCE(e->>'default', e->>'defaultValue', '（既定値なし）') AS 既定値
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       jsonb_array_elements(COALESCE(v.variables, '[]'::jsonb)) e
 WHERE t.template_key = 'intl_purchase_order'
   AND e->>'name' IN ('LATE_PAYMENT_RATE', 'NDA_SURVIVAL_YEARS', 'TERMS_VERSION_DATE');
