\set ON_ERROR_STOP on
\pset pager off

-- 049_nda_template_revision.sql
-- NDA テンプレート改訂（2026-08-12 レビュー反映・新版 INSERT ＋ current_version_id 差し替え）。
--   ① 第8条: 有効期間の既定を「本契約締結日から本件業務が終了する日まで」に（変数未入力でも脱落しない）
--   ② 頭書き: 「期間」ブロックを新設し 有効期間／秘密保持義務の存続 を明記（目視チェック用）
--   ③ 第7条: 返還・廃棄に消去困難な複製物・法定保存のただし書＋2項を本文限定に
--   ④ 第10条の2（個人情報の取扱い）: フォームのチェックボックス INCLUDE_PERSONAL_INFO で条件挿入
--   あわせて CONTRACT_PERIOD / CONFIDENTIALITY_PERIOD を任意化（未入力＝既定文言）。
-- 注意: 旧版で確定済みの NDA 文書は版差のため PDF 再生成不可になる（明示エラー）。
--       必要な旧文書は本ファイル適用前に PDF 化するか、無効化→新版で再作成すること。

\if :{?confirm_nda_revision}
\else
  \echo 'Run with: -v confirm_nda_revision=REVISE_NDA_TEMPLATE_V2'
  \quit 2
\endif
SELECT :'confirm_nda_revision' = 'REVISE_NDA_TEMPLATE_V2' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 現行版が想定どおり（V1 初版）であることを確認してから差し替える。
-- 一致しない場合は本番側に未知の改訂があるため何もせず中断する。
DO $$
DECLARE current_md5 text;
BEGIN
  SELECT md5(v.html_source) INTO current_md5
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'nda';
  IF current_md5 IS NULL THEN
    RAISE EXCEPTION 'nda テンプレートが見つかりません';
  END IF;
  IF current_md5 <> '98ee4aae9f46cc8e8c6a5fe16bc872c4' THEN
    RAISE EXCEPTION 'nda の現行版が想定（V1初版）と異なります (md5=%)。内容を確認してから改訂してください', current_md5;
  END IF;
END $$;

WITH tpl AS (
  SELECT t.id AS template_id,
         (SELECT COALESCE(MAX(version_no), 0) + 1
            FROM document_template_versions WHERE template_id = t.id) AS next_no
    FROM document_templates t
   WHERE t.template_key = 'nda'
), inserted AS (
  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT template_id, next_no, $NDA${{!--
  nda.html — Phase 22.21.88
  ユーザー提供の頭書き形式 NDA デザインを Handlebars 化したもの。

  使用変数 (templates_config.json: nda):
    {{CONTRACT_NO}}             自動採番された文書番号
    {{CONTRACT_DATE_FORMATTED}} 契約締結日 (例: 2026年5月12日)
    {{PARTY_A_NAME}}            甲 名称
    {{PARTY_A_ADDRESS}}         甲 住所
    {{PARTY_A_REP}}             甲 代表者 (肩書込み 例: 代表取締役 山田 太郎)
    {{PARTY_B_NAME}}            乙 名称
    {{PARTY_B_ADDRESS}}         乙 住所
    {{PARTY_B_REP}}             乙 代表者
    {{NDA_PURPOSE}}             検討目的・本件業務
    {{CONTRACT_PERIOD}}         有効期間 (任意。未入力時: 本契約締結日から本件業務が終了する日まで)
    {{CONFIDENTIALITY_PERIOD}}  秘密保持義務存続期間 (任意。未入力時: 本契約終了後5年間)
    {{INCLUDE_PERSONAL_INFO}}   true で第10条の2（個人情報の取扱い）を挿入
    {{RETURN_DISPOSAL}}         返還・廃棄 (任意、デフォルト: 相手方の要請に応じて速やかに返還又は廃棄する。)
    {{JURISDICTION}}            合意管轄 (例: 東京地方裁判所)
    {{GOVERNING_LAW}}           準拠法 (任意、デフォルト: 日本法)

  注意:
    - 第3条第3項は「乙のグループ会社に対する開示」を許す条文で、
      乙 = 自社 (Arclight) を前提とした文言。フォームでも乙 = 自社で
      埋める運用を推奨。
--}}
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>秘密保持契約書 - {{CONTRACT_NO}}</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 20mm 22mm 25mm;
      @bottom-center {
        content: "- " counter(page) " -";
        font-size: 8.5pt;
        font-family: "Noto Serif CJK JP", "IPAMincho", serif;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Noto Serif CJK JP", "IPAMincho", "Yu Mincho", "Hiragino Mincho ProN", "MS Mincho", serif;
      font-size: 10pt;
      line-height: 1.75;
      color: #000;
      background: #fff;
    }

    /* ===== ドキュメントヘッダー ===== */
    .doc-header {
      display: flex;
      justify-content: flex-end;
      gap: 1.5em;
      align-items: baseline;
      margin-bottom: 0.5em;
      font-size: 8.5pt;
      color: #555;
      letter-spacing: 0.05em;
    }

    /* ===== タイトル ===== */
    h1.contract-title {
      text-align: center;
      font-size: 14pt;
      font-weight: bold;
      letter-spacing: 0.35em;
      margin-bottom: 0.9em;
      text-decoration: underline;
    }

    /* ===== 頭書き表 ===== */
    .tobogaki {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1.4em;
      font-size: 9pt;
      line-height: 1.6;
      border-top: 1.5pt solid #1a1a1a;
      border-bottom: 1.5pt solid #1a1a1a;
    }

    .tobogaki th,
    .tobogaki td {
      border: none;
      border-bottom: 0.5pt solid #d8d8d8;
      padding: 0.45em 0.7em;
      vertical-align: top;
    }

    .tobogaki .sec-row td {
      padding-top: 0.9em;
      padding-bottom: 0.25em;
      border-bottom: 0.5pt solid #888;
      font-size: 7.5pt;
      font-weight: bold;
      letter-spacing: 0.25em;
      color: #555;
      text-transform: uppercase;
    }

    .tobogaki .col-item {
      width: 36%;
      font-weight: bold;
      color: #1a1a1a;
      padding-left: 0.5em;
    }

    .tobogaki .col-item .art-ref {
      font-size: 7.5pt;
      font-weight: normal;
      color: #777;
    }

    .tobogaki .col-item .sub-note {
      display: block;
      font-size: 7.5pt;
      font-weight: normal;
      color: #888;
      margin-top: 0.1em;
    }

    .tobogaki .col-value {
      width: 64%;
      word-break: break-all;
      overflow-wrap: break-word;
      color: #1a1a1a;
    }

    .tobogaki .special-cell {
      min-height: 2.5em;
      word-break: break-all;
      overflow-wrap: break-word;
      color: #1a1a1a;
      white-space: pre-wrap;
    }

    /* ===== 前文 ===== */
    .preamble {
      font-size: 9.5pt;
      text-indent: 1em;
      margin-bottom: 0.9em;
      line-height: 1.7;
      text-align: justify;
    }

    /* ===== 条文 ===== */
    .article {
      margin-bottom: 0.9em;
      page-break-inside: auto;
    }

    .article-title {
      font-weight: bold;
      font-size: 10pt;
      margin-bottom: 0.15em;
      page-break-after: avoid;
    }

    .article-content {
      padding-left: 0;
    }

    .article-content p {
      margin-bottom: 0.35em;
      text-align: justify;
    }

    .sub-item {
      padding-left: 2em;
      margin-top: 0.15em;
    }

    .sub-item p {
      margin-bottom: 0.25em;
    }

    .margin-note {
      text-align: center;
      margin: 1.5em 0 2em;
      font-size: 9pt;
    }

    .page-break { page-break-after: always; }
    .no-break   { page-break-inside: avoid; }

    /* ===== 署名欄 ===== */
    .signature-block {
      margin-top: 2.5em;
      page-break-inside: avoid;
    }

    .signature-block .sig-intro {
      font-size: 9.5pt;
      margin-bottom: 1.2em;
      line-height: 1.7;
    }

    .signature-block .date-line {
      text-align: right;
      margin-bottom: 1.5em;
      font-size: 10pt;
    }

    .party {
      margin-bottom: 1.4em;
    }

    .party .party-label {
      font-weight: bold;
      margin-bottom: 0.25em;
    }

    .party .party-row {
      display: flex;
      margin-bottom: 0.2em;
    }

    .party .party-row .label {
      min-width: 4em;
    }

    .party .party-row .value {
      flex: 1;
      word-break: break-all;
    }

    @media print {
      body {
        background: #fff;
      }
    }
  </style>
</head>
<body>

<div class="doc-header">
  <span>契約番号：{{CONTRACT_NO}}</span>
  <span>契約締結日：{{CONTRACT_DATE_FORMATTED}}</span>
</div>

<h1 class="contract-title">秘密保持契約書</h1>

<!-- ======================================================
     頭書き（当事者目録・契約条件一覧）
     ====================================================== -->
<table class="tobogaki">
  <tbody>

    <!-- 当事者 -->
    <tr class="sec-row"><td colspan="2">当　事　者</td></tr>
    <tr>
      <td class="col-item">甲</td>
      <td class="col-value">
        {{PARTY_A_ADDRESS}}<br>
        {{PARTY_A_NAME}}<br>
        {{PARTY_A_REP}}
      </td>
    </tr>
    <tr>
      <td class="col-item">乙</td>
      <td class="col-value">
        {{PARTY_B_ADDRESS}}<br>
        {{PARTY_B_NAME}}<br>
        {{PARTY_B_REP}}
      </td>
    </tr>

    <!-- 基本条件 -->
    <tr class="sec-row"><td colspan="2">基　本　条　件</td></tr>
    <tr>
      <td class="col-item">
        検討目的・本件業務<span class="art-ref">（前文・第１条）</span>
        <span class="sub-note">秘密情報を利用できる目的</span>
      </td>
      <td class="col-value">{{NDA_PURPOSE}}</td>
    </tr>

    <!-- 期間 -->
    <tr class="sec-row"><td colspan="2">期　　　　　間</td></tr>
    <tr>
      <td class="col-item">
        有効期間<span class="art-ref">（第８条）</span>
      </td>
      <td class="col-value">{{#if CONTRACT_PERIOD}}{{CONTRACT_PERIOD}}{{else}}本契約締結日から本件業務が終了する日まで{{/if}}</td>
    </tr>
    <tr>
      <td class="col-item">
        　秘密保持義務の存続<span class="art-ref">（第８条）</span>
      </td>
      <td class="col-value">{{#if CONFIDENTIALITY_PERIOD}}{{CONFIDENTIALITY_PERIOD}}{{else}}本契約終了後5年間{{/if}}</td>
    </tr>

    <!-- 手続 -->
    <tr class="sec-row"><td colspan="2">手　　　　　続</td></tr>
    <tr>
      <td class="col-item">
        返還・廃棄<span class="art-ref">（第７条）</span>
        <span class="sub-note">本件業務終了時又は開示者から要求があった場合</span>
      </td>
      <td class="col-value">{{#if RETURN_DISPOSAL}}{{RETURN_DISPOSAL}}{{else}}相手方の要請に応じて速やかに返還又は廃棄する。{{/if}}</td>
    </tr>

  </tbody>
</table>

<!-- 前文 -->
<p class="preamble">
  頭書き記載の甲（以下「甲」という。）と乙（以下「乙」という。）は、頭書き記載の検討目的・本件業務について検討するにあたり、甲又は乙が相手方に開示する秘密情報の取扱いについて、以下のとおり秘密保持契約（以下「本契約」という。）を締結する。
</p>

<!-- ======================================================
     条文本体
     ====================================================== -->
<div class="article">
<div class="article-title">第1条（目的）</div>
<div class="article-content">
<p>本契約は、本件業務に関連して相互に開示される情報の機密保持に関する取扱いを定め, もって秘密情報の適正な管理及び活用を図ることを目的とする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第2条（秘密情報の定義）</div>
<div class="article-content">
<p>1.　本契約において「秘密情報」とは、本件業務に関連して、一方当事者（以下「開示者」という。）が相手方（以下「受領者」という。）に対し、書面、口頭、電磁的記録その他の方法により開示する一切の情報をいう。ただし、開示者が秘密である旨を明示した情報又は, その性質上秘密であることが明らかな情報に限る。</p>
<p>2.　前項にかかわらず、以下の各号に該当する情報は秘密情報に含まれないものとする。</p>
<div class="sub-item">
<p>（1）開示の時点において既に公知であった情報</p>
<p>（2）開示の時点において受領者が適法に保有していた情報</p>
<p>（3）開示後に受領者の責めに帰すべき事由によらずして公知となった情報</p>
<p>（4）正当な権利を有する第三者から秘密保持義務を負うことなく適法に取得した情報</p>
<p>（5）法令により開示が義務付けられた情報（ただし、法的に許容される範囲で事前に開示者に通知するものとする。）</p>
</div>
</div>
</div>

<div class="article">
<div class="article-title">第3条（秘密保持義務）</div>
<div class="article-content">
<p>1.　受領者は、秘密情報を本件業務の目的以外に使用してはならない。</p>
<p>2.　受領者は、事前に開示者の書面による同意を得ることなく、秘密情報を第三者に開示又は漏洩してはならない。</p>
<p>3.　前項にかかわらず、乙は、本件業務の目的の範囲内で、乙の親会社、子会社、関連会社その他乙と同一の企業グループに属する会社（以下「乙グループ会社」という。）に対して、甲の事前承諾を得ることなく、秘密情報を開示又は共有することができる。この場合、乙は、乙グループ会社に対し本契約と同等の秘密保持義務を課すものとし、乙グループ会社による秘密情報の取扱いについて、自己の行為と同様に責任を負うものとする。</p>
<p>4.　受領者は、秘密情報について善良な管理者の注意をもって管理し、秘密情報の漏洩、滅失、き損の防止に必要な措置を講じなければならない。</p>
</div>
</div>

<div class="article">
<div class="article-title">第4条（従業員等への秘密保持義務の周知）</div>
<div class="article-content">
<p>受領者は、本件業務に従事する自己の役員、従業員、代理人その他の関係者に対し、本契約と同等の秘密保持義務を課し、これを遵守させるものとする。受領者は、これらの者による秘密情報の取扱いについて、自己の行為と同様の責任を負うものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第5条(第三者への業務委託)</div>
<div class="article-content">
<p>受領者が本件業務の全部又は一部を第三者に委託する場合には、事前に開示者の書面による承諾を得るものとし、当該第三者に対して本契約と同等以上の秘密保持義務を課すものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第6条(秘密情報の複製等)</div>
<div class="article-content">
<p>受領者は, 本件業務の遂行に必要な範囲内においてのみ秘密情報を複製, 翻案することができる。この場合, 複製物等についても本契約の定めが適用されるものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第7条(秘密情報の返還・廃棄)</div>
<div class="article-content">
<p>1.　受領者は、開示者から要求があった場合又は本件業務が終了した場合には、速やかに秘密情報及びその複製物等を開示者に返還し、又は廃棄しなければならない。ただし、バックアップその他の技術的理由により合理的に消去することが困難な複製物等及び法令又は社内規程に基づき保存が義務付けられる秘密情報については、この限りでない。この場合、受領者は、当該秘密情報及びその複製物等を保有する限り、本契約に定める秘密保持義務を負うものとする。</p>
<p>2.　前項本文の場合において、受領者は開示者の要求に応じて、秘密情報及びその複製物等の返還又は廃棄を証明する書面を開示者に提出するものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第8条(有効期間)</div>
<div class="article-content">
<p>本契約の有効期間は、{{#if CONTRACT_PERIOD}}{{CONTRACT_PERIOD}}{{else}}本契約締結日から本件業務が終了する日まで{{/if}}とする。ただし、秘密保持義務については、{{#if CONFIDENTIALITY_PERIOD}}{{CONFIDENTIALITY_PERIOD}}{{else}}本契約終了後5年間{{/if}}存続するものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第9条(損害賠償)</div>
<div class="article-content">
<p>受領者が本契約に違反し開示者に損害を与えた場合, 受領者は開示者に対し, 当該損害(弁護士費用を含む。)を賠償する責任を負う。</p>
</div>
</div>

<div class="article">
<div class="article-title">第10条(差止請求)</div>
<div class="article-content">
<p>開示者は, 受領者が本契約に違反し又は違反するおそれがある場合, 受領者に対して違反行為の停止又は予防を請求することができる。</p>
</div>
</div>

{{#if INCLUDE_PERSONAL_INFO}}
<div class="article">
<div class="article-title">第10条の2（個人情報の取扱い）</div>
<div class="article-content">
<p>1.　秘密情報に個人情報の保護に関する法律に定める個人情報又は個人データが含まれる場合、受領者は、同法その他の関係法令及び開示者の指示に従い、これを取り扱うものとする。</p>
<p>2.　受領者は、前項の情報につき漏えい、滅失又は毀損の事故が発生し、又はそのおそれを認識した場合には、直ちに開示者に報告し、開示者と協議のうえ必要な措置を講じるものとする。</p>
</div>
</div>
{{/if}}

<div class="article">
<div class="article-title">第11条(契約の解除)</div>
<div class="article-content">
<p>開示者は, 受領者が本契約の条項に違反した場合, 催告することなく本契約を解除することができる。</p>
</div>
</div>

<div class="article">
<div class="article-title">第12条(協議)</div>
<div class="article-content">
<p>本契約に定めのない事項又は本契約の条項について疑義が生じた場合は, 甲乙誠実に協議して解決するものとする。</p>
</div>
</div>

<div class="article">
<div class="article-title">第13条(準拠法・管轄裁判所)</div>
<div class="article-content">
<p>1.　本契約は{{#if GOVERNING_LAW}}{{GOVERNING_LAW}}{{else}}日本法{{/if}}に準拠し, {{#if GOVERNING_LAW}}{{GOVERNING_LAW}}{{else}}日本法{{/if}}に従って解釈されるものとする。</p>
<p>2.　本契約に関して紛争が生じた場合は, {{JURISDICTION}}を第一審の専属的合意管轄裁判所とする。</p>
</div>
</div>

<div class="margin-note">(以下余白)</div>

<!-- ======================================================
     署名欄(末尾)
     ====================================================== -->
<div class="signature-block no-break">
  <p class="sig-intro">以上、本契約の成立を証するため、本書２通を作成し、甲乙記名押印のうえ、各１通を保有又は、本書の電磁的記録を作成し、甲乙合意の後電子署名を施し、各自その電磁的記録を保管する。</p>

  <div class="date-line">締結日：{{CONTRACT_DATE_FORMATTED}}</div>

  <div class="party">
    <div class="party-label">甲</div>
    <div class="party-row">
      <span class="label">所在地　</span>
      <span class="value">{{PARTY_A_ADDRESS}}</span>
    </div>
    <div class="party-row">
      <span class="label">会社名　</span>
      <span class="value">{{PARTY_A_NAME}}</span>
    </div>
    <div class="party-row">
      <span class="label">代表者　</span>
      <span class="value">{{PARTY_A_REP}}　　　　　㊞</span>
    </div>
  </div>

  <div class="party">
    <div class="party-label">乙</div>
    <div class="party-row">
      <span class="label">所在地　</span>
      <span class="value">{{PARTY_B_ADDRESS}}</span>
    </div>
    <div class="party-row">
      <span class="label">会社名　</span>
      <span class="value">{{PARTY_B_NAME}}</span>
    </div>
    <div class="party-row">
      <span class="label">代表者　</span>
      <span class="value">{{PARTY_B_REP}}　　　　　㊞</span>
    </div>
  </div>
</div>

</body>
</html>$NDA$, $json$[
  {
    "name": "CONTRACT_DATE_FORMATTED",
    "group": "I. ヘッダ",
    "label": "契約締結日",
    "helpText": "PDF 上部の「契約締結日」と末尾「締結日」欄に表示",
    "required": true,
    "placeholder": "例: 2026年5月12日"
  },
  {
    "name": "PARTY_A_NAME",
    "group": "II. 甲 (取引先側)",
    "label": "甲 名称",
    "helpText": "[取引先] ボタンで vendor から自動入力。例: 株式会社サンプル",
    "required": true
  },
  {
    "name": "PARTY_A_ADDRESS",
    "type": "textarea",
    "group": "II. 甲 (取引先側)",
    "label": "甲 住所",
    "required": true,
    "placeholder": "例: 東京都千代田区サンプル1-2-3"
  },
  {
    "name": "PARTY_A_REP",
    "group": "II. 甲 (取引先側)",
    "label": "甲 代表者",
    "helpText": "肩書込みで記入",
    "required": true,
    "placeholder": "例: 代表取締役 山田 太郎"
  },
  {
    "name": "PARTY_B_NAME",
    "group": "III. 乙 (自社想定)",
    "label": "乙 名称",
    "helpText": "[自社] ボタンで company-profile から自動入力。例: 株式会社アークライト",
    "required": true,
    "placeholder": "株式会社アークライト"
  },
  {
    "name": "PARTY_B_ADDRESS",
    "type": "textarea",
    "group": "III. 乙 (自社想定)",
    "label": "乙 住所",
    "required": true,
    "placeholder": "東京都千代田区小川町１－２　風雲堂ビル２階"
  },
  {
    "name": "PARTY_B_REP",
    "group": "III. 乙 (自社想定)",
    "label": "乙 代表者",
    "helpText": "第3条第3項のグループ会社開示条項は乙=自社を前提",
    "required": true,
    "placeholder": "代表取締役　青柳　昌行"
  },
  {
    "name": "NDA_PURPOSE",
    "type": "textarea",
    "group": "IV. 契約内容",
    "label": "秘密保持の目的 (検討目的・本件業務)",
    "helpText": "頭書きの「検討目的・本件業務」欄に表示。第8条の既定文言「本件業務が終了する日まで」はここで定義した本件業務を指す",
    "required": true,
    "placeholder": "例: 〇〇事業に関する協業検討のため"
  },
  {
    "name": "CONTRACT_PERIOD",
    "group": "IV. 契約内容",
    "label": "契約期間 (任意)",
    "helpText": "未入力なら「本契約締結日から本件業務が終了する日まで」が第8条と頭書きに挿入される（推奨・更新漏れが起きない）。期間を区切りたい場合のみ「本契約締結日から」を含めて記入",
    "placeholder": "（未入力＝本契約締結日から本件業務が終了する日まで）"
  },
  {
    "name": "CONFIDENTIALITY_PERIOD",
    "group": "IV. 契約内容",
    "label": "秘密保持義務存続期間 (任意)",
    "helpText": "未入力なら「本契約終了後5年間」が第8条と頭書きに挿入される。変更する場合のみ「本契約終了後」を含めて記入",
    "placeholder": "（未入力＝本契約終了後5年間）"
  },
  {
    "name": "RETURN_DISPOSAL",
    "type": "textarea",
    "group": "IV. 契約内容",
    "label": "返還・廃棄の取扱い (任意)",
    "helpText": "頭書きの「返還・廃棄」欄に表示。未入力なら「相手方の要請に応じて速やかに返還又は廃棄する。」がデフォルト挿入される。特約があるときのみ記入 (例: 業務終了から30日以内に削除証明書を提出)",
    "placeholder": "相手方の要請に応じて速やかに返還又は廃棄する。"
  },
  {
    "name": "INCLUDE_PERSONAL_INFO",
    "type": "boolean",
    "group": "IV. 契約内容",
    "label": "個人情報条項を挿入（第10条の2）",
    "helpText": "受領者側が会員・購買データ等の個人情報・個人データの実データに接触する場合のみ ON。委託契約側で手当てする場合は不要"
  },
  {
    "name": "GOVERNING_LAW",
    "group": "V. 一般条項",
    "label": "準拠法 (任意)",
    "helpText": "未入力なら「日本法」がデフォルト挿入される。海外当事者向けに変更したいときのみ記入",
    "placeholder": "日本法"
  },
  {
    "name": "JURISDICTION",
    "group": "V. 一般条項",
    "label": "合意管轄",
    "required": true,
    "placeholder": "例: 東京地方裁判所"
  }
]$json$::jsonb,
         '2026-08-12 レビュー反映（第7/8条・頭書き期間欄・第10条の2条件挿入）', 'legalbridge-v2'
    FROM tpl
  RETURNING id, template_id, version_no
)
UPDATE document_templates t
   SET current_version_id = inserted.id
  FROM inserted
 WHERE t.id = inserted.template_id;

SELECT t.template_key, t.current_version_id, v.version_no, md5(v.html_source) AS new_md5
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'nda';

COMMIT;
