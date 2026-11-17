-- =====================================================================
-- 212 著作物利用許諾基本契約書V5（license_master_v5）の登録
--
--   出版・ボードゲーム共通の基本契約（著作物利用許諾基本契約書V5）と、その個別条件書V5 の 3 本を一度に登録する。
--   事業別条項（出版／ボードゲーム）は基本契約に置かず、個別条件書に置く（基本契約V5 第3条第5項）。
--
--   ・V5 は新しいキーとして足す。既存のひな形（license_master・pub_master_*・individual_license_terms_v3/v4・
--     pub_license_terms_v3/_annex/_multi）と、その版で作った文書には触れない（旧基本契約の相手先は従来の条件書）。
--   ・項目（入力欄）はコードが持つ（LICENSE_MASTER_V5_VARIABLES・LICENSE_TERMS_VARIABLES・PUB_TERMS_VARIABLES）。variables は空。
--   ・採番は従来の帯を続ける（基本契約 LIC／ボードゲームの条件書 ILT／出版の条件書 PUBT）。
--   ・アプリ側は V5 のキーを扱う版（documents/license-master-v5.ts ほか）が先に出ていること。
--
--   本文は infra/v3/templates/license_master_v5.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/212_v5_license_templates.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'license_master_v5';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!-- license_master_v5 r2 -->
<!--
  著作物利用許諾基本契約書V5（license_master_v5）。出版・ボードゲーム共通の基本契約。本番へは infra/v3/212 が運ぶ
  （infra/v3/tools/make-template-sql.mjs で本文から作る。直すときはここを直して SQL を作り直す）。
  事業別条項（出版・ボードゲーム）は基本契約に置かず、個別利用許諾条件書V5 に置く（第3条第5項）。
  差し込みは licenseMasterV5Patch（apps/legalbridge-v3/src/server/documents/license-master-v5.ts）の値。
  ページ番号・書類番号は @page の余白ボックスで出す（描画器は Chromium の既定のヘッダー・フッターを切っている）。
-->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>著作物利用許諾基本契約書 {{docNo}}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 13mm 14mm 16mm;
    @bottom-left {
      content: "著作物利用許諾基本契約書　{{docNo}}";
      font: 6.5pt "Noto Sans CJK JP", "Yu Gothic", sans-serif; color: #777; vertical-align: top; padding-top: 3mm;
    }
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font: 6.5pt "Noto Sans CJK JP", "Yu Gothic", sans-serif; color: #777; vertical-align: top; padding-top: 3mm;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", sans-serif; font-size: 8.6pt; line-height: 1.52; color: #222; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; }
  h1 { font-size: 17pt; margin: 4px 0 6px; letter-spacing: .02em; }
  .meta { font-size: 8pt; color: #555; text-align: left; line-height: 1.5; }
  .meta b { font-family: monospace; font-weight: 600; color: #333; }
  .sub { font-size: 10.5pt; font-weight: 700; margin: 6px 0 8px; }
  .box { background: #f3f3f3; padding: 8px 10px; margin-bottom: 12px; }
  .box .grid { display: grid; grid-template-columns: 50% 50%; row-gap: 1px; font-size: 8.4pt; }
  .box .lbl { font-weight: 700; color: #444; }
  .box .pre { margin-top: 6px; padding-top: 6px; border-top: 1px solid #ddd; color: #555; font-size: 8pt; }
  h2 { break-after: avoid; font-size: 10.5pt; border-left: 4px solid #222; padding-left: 7px; margin: 14px 0 6px; }
  h3 { font-size: 9pt; background: #eee; padding: 2px 6px; margin: 10px 0 4px; }
  .kv { display: grid; grid-template-columns: 25% 75%; row-gap: 3px; margin: 0 0 4px 6px; }
  .kv .k { color: #555; }
  .art { break-inside: avoid; margin: 0 0 3px; text-align: justify; }
  .art b { font-weight: 700; }
  .art .p { display: block; padding-left: 1.1em; text-indent: -1.1em; }
  .chap { break-after: avoid; font-weight: 700; color: #555; font-size: 8.2pt; margin: 8px 0 2px; }
  .end { text-align: right; color: #555; margin-top: 4px; }
  .sig { break-inside: avoid; display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #ccc; margin-top: 6px; }
  .sig > div { padding: 8px 10px; position: relative; }
  .sig > div + div { border-left: 1px solid #ccc; }
  .sig .t { font-weight: 700; margin-bottom: 4px; }
  .sig .f { font-size: 7.4pt; color: #666; margin-top: 4px; }
  .sig .v { border-bottom: 1px solid #555; width: 66%; min-height: 16px; }
  .sig .seal { position: absolute; right: 12px; top: 34px; width: 60px; height: 60px; border: 1px solid #ccc; font-size: 7.4pt; color: #777; display: flex; align-items: center; justify-content: center; text-align: center; }
  .note { break-after: avoid; font-size: 7.6pt; color: #666; }
</style>
</head>
<body>

<div class="head">
  <h1>著作物利用許諾基本契約書</h1>
  <div class="meta">締結日：{{formatDateCompact signDate}}<br>書類番号：<b>{{docNo}}</b></div>
</div>
<div class="sub">出版・ボードゲーム共通 ／ 個別条件書により著作物ごとの許諾内容を定める</div>

<div class="box">
  <div class="grid">
    <div class="lbl">当事者</div><div></div>
    <div>許諾者（甲）：{{licensorName}}</div><div>被許諾者（乙）：{{licenseeName}}</div>
  </div>
  <div class="pre">{{licensorName}}（以下「甲」という。）と{{licenseeName}}（以下「乙」という。）は、甲が権利を有する著作物の利用許諾に関する基本的な条件について、本書のとおり契約（以下「本契約」という。）を締結する。</div>
</div>

<h2>1. 基本条件</h2>
<div class="kv">
  <div class="k">個別条件書</div><div>個別利用許諾条件書（第3条。出版・ボードゲーム共通の様式）。本契約と一体をなし、矛盾するときは個別条件書が優先する。</div>
  <div class="k">業務委託</div><div>乙が発行する発注書による（第12条）</div>
  <div class="k">有効期間</div><div>締結日から5年間。満了3か月前までに書面で申入れがなければ5年ごとに自動更新。個別条件書の許諾期間は、締結時の残存期間が2年以上なら本契約の満了日まで、2年未満なら満了日からさらに5年（第23条）</div>
  <div class="k">支払先</div><div>{{#if hasBank}}{{BANK_INFO}} ／ {{/if}}振込手数料：乙負担</div>
  <div class="k">税務</div><div>消費税：外税 ／ 源泉徴収：{{#if withholding}}あり{{else}}なし{{/if}} ／ 適格請求書発行事業者：{{#if licensorInvoiceNo}}登録済（{{licensorInvoiceNo}}）{{else}}未登録{{/if}}</div>
  <div class="k">通知先</div><div>甲：{{licensorContact}}<br>乙：{{licenseeContact}}</div>
  <div class="k">準拠法・管轄</div><div>日本法 ／ 東京地方裁判所（第一審専属）</div>
</div>

<h2>2. 契約条項</h2>

<div class="chap">第1章　総則</div>
<p class="art"><b>第1条（目的・適用）</b>　本契約は、甲が乙に対し、甲が権利を有する著作物の利用を許諾するにあたっての基本条件と、乙が甲に委託する業務の基本条件を定める。利用許諾に関する定めは第3条の個別条件書が締結された著作物に、委託業務に関する定めは第12条の発注書が発行された業務に適用する。乙は、個別条件書の締結前でも、発注書により委託業務を発注できる。</p>
<p class="art"><b>第2条（定義）</b>　本契約において、(1)「本著作物」とは個別条件書の対象著作物欄に記載された著作物（原稿、イラスト、ルール、キャラクター、設定その他の構成要素を含む。）を、(2)「本製品」とは乙が本著作物を利用して制作する出版物、電子書籍、ボードゲーム製品その他個別条件書に定める製品を、(3)「個別条件書」とは第3条に基づき締結される個別利用許諾条件書（追加・変更の合意書を含む。）をいう。</p>
<p class="art"><b>第3条（個別条件書）</b>　甲および乙は、本著作物ごとに個別条件書を締結し、対象著作物、利用類型、独占・非独占の別、許諾地域・言語・期間、対価の算定方式と支払時期、監修、著作権表示、生成AIの利用の有無（利用するときはその範囲と方法）その他の個別条件を定める。
<span class="p">2　条件が未確定でも開発等を先行させる必要があるときは、個別条件書に「暫定許諾」と明記し、確定の期限（定めがないときは暫定許諾の開始日から6か月）と暫定の対価（料率等）を定めて、許諾を開始できる。暫定許諾で乙が行えるのは、個別条件書に定めがない限り、試作、監修のための提出および発売前の告知に限る。量産、予約の受付、販売および再許諾は、個別条件書にその旨と範囲を定めたときに限り行える。期限までに確定した条件は、暫定許諾の開始日に遡って適用する。</span>
<span class="p">3　前項の期限までに条件が確定しないときは、暫定許諾は期限の到来をもって終了する。この場合、乙は新たな製造、配信および再許諾を中止し、前項により量産が認められていたときに限り、終了までに製造した本製品を終了日から6か月間（個別条件書に別段の定めがあるときはその期間）販売できる。乙は、終了日現在の在庫数と終了までの製造数・販売数を甲に報告し、これらの対価は暫定の対価により精算する。</span>
<span class="p">4　個別条件書に記載のない利用は許諾されない。新たな利用は、追加の個別条件書その他の書面による合意を要する。</span>
<span class="p">5　個別条件書には、利用類型（出版、ボードゲーム等）に応じて乙所定の事業別条項を定める。事業別条項は個別条件書と一体をなし、これを変更するときは個別条件書の特記事項に定める。特記事項で本契約または事業別条項を変更するときは、変更する条項とその内容を特定して記載する。</span></p>

<div class="chap">第2章　許諾</div>
<p class="art"><b>第4条（利用許諾）</b>　甲は乙に対し、個別条件書に定める範囲で、本著作物を複製、翻案、公衆送信、頒布その他本製品の制作・販売に必要な方法で利用することを許諾する。独占・非独占の別が個別条件書にないときは非独占とする。
<span class="p">2　前項の許諾には、本製品の広告宣伝・販売促進のための本著作物の一部利用（表紙、イラスト、画像等）を含み、その対価は無償とする。</span></p>
<p class="art"><b>第5条（再許諾・委託）</b>　乙は、印刷・製造・流通・配信その他本製品の制作・販売に必要な範囲で第三者に委託し、または再許諾できる。これ以外の再許諾（海外版、商品化等）は、個別条件書に定めがある場合または甲の事前の書面承諾を得た場合に限る。
<span class="p">2　乙は、再許諾先に本契約と同等の義務を課し、その行為について甲に対し責任を負う。</span></p>
<p class="art"><b>第6条（成果物の帰属）</b>　乙または乙の委託先が本製品のために創作した部分（編集、装丁、組版データ、翻訳、ルール改変、デザイン等）の権利は乙に帰属する。乙は、委託先との契約により、当該部分の著作権の譲渡または必要な利用許諾と、その著作者による著作者人格権の不行使を確保する。ただし、本著作物に係る甲の権利（著作権法第28条の権利を含む。）を制限しない。</p>
<p class="art"><b>第7条（著作者人格権）</b>　甲は、本契約に基づく利用について、乙および乙の許諾を受けた者に対し著作者人格権を行使しない。甲以外に本著作物の著作者（共同著作者、甲の委託先その他実際に創作した者）があるときは、甲は、その者から同様の不行使の約束を得る。ただし、甲の名誉または声望を害する方法による利用については、この限りでない。</p>
<p class="art"><b>第8条（生成AIの取扱い）</b>　本条において「生成AI」とは、指示に応じて文章、画像、音声その他の表現を自動的に生成する人工知能技術をいう。
<span class="p">2　甲は乙に対し、本著作物（甲が第三者に制作させた部分を含む。）が、生成AIにより生成された表現を含まず、甲または正当な権利者の創作によるものであることを表明し、保証する。ただし、個別条件書に生成AIの利用範囲と方法を明記して乙が承諾したものは除く。</span>
<span class="p">3　誤字脱字の確認、資料の検索、表現を生成しない画像処理その他、本著作物の表現そのものを生成しない補助的な利用は、前項の生成AIの利用に当たらない。</span>
<span class="p">4　甲は、個別条件書の締結後に本著作物を加筆、修正、追加制作する場合も、乙の書面による事前の承諾なく生成AIを利用しない。</span>
<span class="p">5　甲は、乙から合理的な求めがあったときは、制作過程を示す資料（下書き、ラフ、レイヤー付きデータ、制作記録等）を提示するなど、第2項の確認に協力する。</span>
<span class="p">6　甲が第2項または第4項に違反したときは、乙は、当該本著作物について、差替えまたは修正の請求、当該個別条件書の解除および損害（本製品の回収、廃棄、再制作の費用を含む。）の賠償の請求ができる。</span>
<span class="p">7　前項にかかわらず、甲が、乙からの指摘または第三者からの申立てを受ける前に自ら違反を発見して乙に書面で申告し、乙の求めに応じて相当の期間内に差替えまたは修正を完了したときは、甲の賠償責任は、差替えまたは修正のために乙に生じた費用（再制作、再校正、データ差替え等の費用）に限られる。ただし、甲に故意があるときは、この限りでない。</span>
<span class="p">8　乙は、甲の書面による事前の承諾なく、本著作物を生成AIその他のAIシステムの学習用データとして利用し、または第三者に提供しない。乙は、再許諾先にも同等の制限を課す。</span></p>

<div class="chap">第3章　制作・販売・業務委託</div>
<p class="art"><b>第9条（制作・監修）</b>　乙は、自己の責任と費用で本製品を企画・制作し、仕様、構成、デザインその他の制作内容を決定する。
<span class="p">2　乙が本著作物の内容（題号、名称、キャラクターの設定、ルールの根幹を含む。）を実質的に変更するときは、甲の事前の承諾を得る。編集上または制作上必要な軽微な修正は、この限りでない。</span>
<span class="p">3　個別条件書で甲の監修を定めたときは、乙は、監修の対象（校正刷り、表紙、試作サンプル、パッケージ、広告物等）を甲に提示する。甲は、受領後10営業日以内に回答し、合理的な理由なく承認を拒まない。期間内に回答がないときは、承認したものとみなす。</span></p>
<p class="art"><b>第10条（販売）</b>　乙は、本製品の価格、発行部数・製造数量、仕様、販路、販売方法および時期を自らの裁量で決定し、印刷、製造、流通その他の業務を第三者に委託できる。ただし、本著作物の価値または甲の名誉・信用を著しく損なう態様では販売しない。
<span class="p">2　乙は、発売前に、発売予定日、予定部数・数量および販売地域の概要を甲に通知する。</span>
<span class="p">3　許諾地域内で販売した本製品が越境EC等により許諾地域外に流通しても、乙が意図的に助長したものでない限り、許諾地域の違反とはしない。</span></p>
<p class="art"><b>第11条（販売終了）</b>　利用類型（紙書籍、電子書籍、ボードゲーム製品、デジタル版等）ごとに、販売可能な在庫または配信が実質的に失われ、乙に重版、再製造または再配信の予定がない状態が12か月続いたときは、甲は、乙に継続の意思を書面で確認できる。
<span class="p">2　乙が前項の確認の受領後45日以内に継続の意思を通知せず、または通知後6か月以内に重版、再製造、再配信等に着手しないときは、甲は、当該利用類型に限り許諾を終了できる。他の利用類型および本契約の効力には影響しない。</span></p>

<p class="art"><b>第12条（業務の委託）</b>　乙は、甲に対し、本製品に関する執筆、加筆・修正、イラスト・デザインの制作、監修、翻訳、イベントへの出演その他の業務（以下「委託業務」という。）を委託することができる。
<span class="p">2　委託業務の内容、納期、報酬の額、支払期日その他の条件は、乙が発行する発注書（電子メールその他の電磁的方法によるものを含む。）に定める。発注書は本契約に基づく個別契約とし、発注書に定めのない事項は本契約による。成果物の利用を報酬に含めるときは、含まれる利用の範囲（本製品、媒体、版または刷）を発注書に記載する。発注書だけで成果物の利用許諾を完結させるときは、対象、媒体、地域、期間その他の利用の範囲を発注書に明記する。</span>
<span class="p">3　委託業務に特定受託事業者に係る取引の適正化等に関する法律（以下「フリーランス法」という。）または製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律（以下「取適法」という。）が適用されるときは、乙はこれらを遵守し、発注書をもって取引条件の明示とする。報酬は、成果物の受領日（成果物の無い監修・出演等の役務は、その役務の提供を終えた日）から60日以内のできる限り短い期間内で発注書に定める期日までに支払う。</span>
<span class="p">4　乙は、甲の責めに帰すべき事由がないのに、成果物の受領を拒み、報酬を減額し、または成果物を返品しない。乙が報酬の支払を遅延したときは、支払期日の翌日から支払日まで、フリーランス法または取適法が適用される取引では年14.6%、その他の取引では年3%の割合による遅延損害金を支払う。</span>
<span class="p">5　委託業務により甲が新たに創作した成果物の著作権は、発注書に譲渡の定めがない限り甲に留保され、成果物は本著作物として乙に利用が許諾される。発注書に譲渡の定めがあるときは、成果物の著作権（著作権法第27条および第28条の権利を含む。）は報酬の支払時に乙に移転し、その対価は報酬に含まれる。甲が従前から有していた権利は甲に留保される。</span>
<span class="p">6　前項により甲に著作権が留保される成果物の利用の対価は、次の各号のとおりとする。</span>
<span class="p">(1)　個別条件書または発注書に利用許諾の条件（利用許諾料の算定方式等）の定めがないとき　委託業務の報酬に、発注書に定める本製品への利用に係る利用許諾料を含む。</span>
<span class="p">(2)　利用許諾の条件の定めがあり、その適用の開始を特定の版、刷、製造回その他の時点（例：第2版以降）と定めたとき　適用の開始前の利用（例：初版）に係る利用許諾料は委託業務の報酬に含まれ、適用の開始以後の利用については、個別条件書に定める利用許諾料のみを支払う。</span>
<span class="p">(3)　利用許諾の条件の定めがあり、適用の開始の定めがないとき　委託業務の報酬とは別に、当初から個別条件書に定める利用許諾料を支払う。</span>
<span class="p">7　前項の「版」および「刷」は発注書または個別条件書の記載による。初版の増刷（第2刷以降）の利用許諾料が報酬に含まれるかは発注書に定め、定めがないときは、報酬に含まれるのは初版第1刷の利用に係るものに限る。</span>
<span class="p">8　乙は、委託業務に関し、甲に対するハラスメントの防止に必要な措置を講じ、甲からの相談に適切に対応する。</span>
<span class="p">9　委託業務に関するハラスメントその他不当な取扱いの相談窓口は、次のとおりとする。KADOKAWAグループホットライン（WEBフォーム：https://koueki-tsuhou.com/slmfze8pka9s/　電話：0120-996-206　平日8:30〜19:00／土曜8:30〜17:00）</span>
<span class="p">10　乙は、甲が前項の相談を行ったことを理由として、甲に不利益な取扱いをしない。</span></p>

<div class="chap">第4章　対価</div>
<p class="art"><b>第13条（対価）</b>　乙は甲に対し、個別条件書に定める算定方式（印税方式、製造数量方式、売上方式、一括払い（買取）方式、再許諾収入の分配その他）により算定した対価を支払う。献本、見本、販促のための無償頒布分は対価の対象としない。</p>
<p class="art"><b>第14条（支払・報告・監査）</b>　乙は、個別条件書に定める時期に、算定根拠（数量、単価、料率）を記載した明細を甲に提出のうえ、基本条件記載の口座へ振り込んで支払う。消費税は外税とし、法令に基づき源泉徴収を行う。甲は適格請求書発行事業者の登録状況とその変更を乙に通知する。
<span class="p">2　甲は、明細に疑義があるときは受領後12か月以内に申し出ることができ、乙は算定の根拠資料を合理的な範囲で開示する。</span>
<span class="p">3　甲は、対価の計算を確認するため、年1回を限度として、30日前までに書面で通知したうえで、乙の通常の営業時間内に、乙の帳簿その他の関係書類を監査することができる。監査は、甲自らまたは甲が指定する公認会計士、税理士その他守秘義務を負う専門家が行い、対象は監査の通知日から遡って2年以内の期間とする。</span>
<span class="p">4　監査の費用は甲の負担とする。ただし、監査の結果、対象期間の支払額に5%以上の過少支払が判明したときは、合理的な監査費用は乙の負担とする。</span>
<span class="p">5　監査の結果、過少支払が判明したときは、乙は不足額を速やかに支払う。過払いが判明したときは、以後の支払と相殺し、または甲が返還する。監査で知り得た乙の情報は、第18条の秘密情報として扱う。</span></p>

<div class="chap">第5章　権利の保証と保全</div>
<p class="art"><b>第15条（表明保証）</b>　甲は乙に対し、(1)本著作物について許諾に必要な権利を有し、または権利者から必要な権限を得ていること、(2)個別条件書に開示したものを除き、乙の利用に第三者の追加許諾や対価の支払を要しないこと、(3)本著作物が第三者の権利を侵害せず、法令・公序良俗に反しないことを表明し保証する。第三者の原作・素材を含むときは、原許諾の概要を個別条件書に記載する。
<span class="p">2　甲が前項に違反し第三者との紛争が生じたときは、甲は自己の責任と費用で解決し、乙の損害（合理的な弁護士費用を含む。）を賠償する。</span>
<span class="p">3　乙が本製品のために追加した素材、乙が行った改変または乙が定めた製品の仕様に起因して第三者との紛争が生じたときは、乙が自己の責任と費用で解決する。</span>
<span class="p">4　本製品について第三者から請求を受けた当事者は、速やかに相手方に通知する。前2項により責任を負う当事者がその防御と解決を主導し、相手方は合理的な範囲で協力する。責任を負う当事者は、相手方の事前の承諾なく、相手方の責任を認める内容の和解をしない。紛争の解決のために素材の差替え、販売の停止または本製品の回収を要するときは、その費用は紛争の原因を生じた当事者が負担する。</span></p>
<p class="art"><b>第16条（著作権表示）</b>　乙は、本製品の適切な位置に、個別条件書に定める著作権表示（©表示、権利者名、発行年等）を行う。</p>
<p class="art"><b>第17条（侵害への対応）</b>　本著作物に対する第三者の侵害を知ったときは、甲乙は相互に通知し協力して対処する。乙は、海賊版等の緊急の侵害について、甲に事後報告のうえ削除申請等の初動対応を行うことができる。</p>

<div class="chap">第6章　一般条項</div>
<p class="art"><b>第18条（秘密保持）</b>　各当事者は、本契約の有効期間中および終了後3年間、本契約に関して知り得た相手方の非公知の情報を、相手方の事前の承諾なく第三者に開示しない。ただし、乙が本製品の制作・販売・宣伝および再許諾に必要な範囲で使用する場合、ならびに委託先、弁護士、税理士等に必要な範囲で開示する場合を除く。公知情報、既保有情報、独自開発情報、第三者から適法に取得した情報、法令等により開示を求められた情報は秘密情報に含まない。</p>
<p class="art"><b>第19条（個人情報の保護）</b>　各当事者は、本契約に関して取得した相手方または第三者の個人情報（個人情報の保護に関する法律に定める個人情報をいう。以下同じ。）を、同法その他の関係法令および個人情報保護委員会のガイドラインに従って適切に取り扱う。
<span class="p">2　各当事者は、個人情報を本契約の履行に必要な範囲でのみ利用し、法令に基づく場合を除き、相手方の事前の承諾なく第三者に提供しない。ただし、本契約の履行のために委託先に取り扱わせる場合は、本条と同等の義務を課し、委託先を適切に監督するときに限り、この限りでない。</span>
<span class="p">3　乙は、甲が個人である場合、甲の氏名、筆名、住所、連絡先、口座情報および個人番号その他の個人情報を、本契約の締結・履行、対価の支払、支払調書の作成その他の税務手続、著作権表示ならびに本契約に関する連絡のために利用する。個人番号は、行政手続における特定の個人を識別するための番号の利用等に関する法律に従い、税務手続のためにのみ取り扱う。</span>
<span class="p">4　乙が本製品の販売、配信、イベントその他の事業活動を通じて取得した購入者等の個人情報は、乙が自らの責任とプライバシーポリシーに従って取り扱い、乙は甲にこれを提供する義務を負わない。</span>
<span class="p">5　各当事者は、個人情報の漏えい、滅失、毀損および不正アクセスを防止するため、組織的、人的、物理的および技術的な安全管理措置を講じる。</span>
<span class="p">6　個人情報の漏えい等の事故が発生し、またはそのおそれがあるときは、当該当事者は直ちに相手方に通知し、原因の調査、被害の拡大防止および再発防止のために必要な措置を講じるとともに、法令に基づく個人情報保護委員会への報告および本人への通知について相互に協力する。</span>
<span class="p">7　各当事者は、本契約の終了時または相手方の求めがあったときは、相手方から受領した個人情報を、相手方の指示に従い返還し、または復元できない方法で消去する。ただし、法令により保存が義務付けられたものは、この限りでない。</span></p>
<p class="art"><b>第20条（譲渡禁止・承継）</b>　甲は、許諾期間中、乙の事前の書面承諾なく本著作物の著作権を譲渡し、または担保に供しない。各当事者は、相手方の承諾なく本契約上の地位・権利義務を第三者に譲渡しない。
<span class="p">2　合併、会社分割、相続等により権利義務が承継されたときは、承継人が本契約に拘束される。甲は、組織変更、代表者の変更、甲の死亡その他権利者の変更を、知った日から1か月以内に乙に書面で通知する。</span></p>
<p class="art"><b>第21条（不可抗力）</b>　天災地変、戦争、感染症、通信障害、法令の改廃その他の不可抗力による履行遅滞・不能について、当事者は責任を負わない。ただし、金銭債務はこの限りでない。</p>
<p class="art"><b>第22条（解除）</b>　各当事者は、相手方が本契約または個別条件書に違反し、15営業日以上の期間を定めた書面の是正要求に応じないときは、本契約または当該個別条件書を解除できる。
<span class="p">2　相手方に、(1)破産・民事再生等の申立て、(2)差押え・不渡り等の信用悪化、(3)第25条違反のいずれかがあるときは、催告なく直ちに解除できる。</span></p>
<p class="art"><b>第23条（有効期間）</b>　本契約の有効期間は、締結日から5年間とする。期間満了の3か月前までにいずれの当事者からも書面による終了の申入れがないときは、本契約は同一の条件でさらに5年間更新され、以後も同様とする。
<span class="p">2　個別条件書の許諾期間は、個別条件書に別段の定めがない限り、個別条件書に定める許諾開始日（定めがないときは締結日）から、次の各号に定める日までとする。</span>
<span class="p">(1)　個別条件書の締結日において本契約の残存期間が2年以上あるとき　本契約の期間満了日</span>
<span class="p">(2)　個別条件書の締結日において本契約の残存期間が2年未満であるとき　本契約の期間満了日から5年を経過する日</span>
<span class="p">3　本契約が前項の期間中に第1項により更新されたときは、その時点で有効な個別条件書の許諾期間は、更新後の本契約の期間満了日と前項により定まる日のいずれか遅い日まで延長される。ただし、個別条件書に許諾期間の更新の方法（自動更新の有無、更新の単位、終了の通知期限等）を定めたときは、本項および前項によらず、その定めによる。</span>
<span class="p">4　本契約が期間満了（第1項の終了の申入れによるものを含む。）により終了したときでも、その時点で有効な個別条件書は、その許諾期間の満了まで存続し、その間は本契約の各条項が当該個別条件書に適用される。</span>
<span class="p">5　本契約が第22条または第25条により解除されたときは、解除した当事者が別段の意思を表示しない限り、すべての個別条件書も同時に終了する。個別条件書だけが解除されたときは、本契約および他の個別条件書の効力に影響しない。</span></p>
<p class="art"><b>第24条（終了後の措置）</b>　本契約または個別条件書が期間満了（更新の拒絶によるものを含む。）により終了したときは、乙は次のとおり取り扱うことができる。
<span class="p">(1)　紙媒体・製品　終了日に製造済みの在庫を、終了日から12か月間（個別条件書に別段の定めがあるときはその期間）販売できる。乙は、終了日から30日以内に在庫数を甲に報告し、販売の期間の満了後に最終の報告を行う。</span>
<span class="p">(2)　電子書籍・デジタル版　終了日以後の新規の販売および配信は停止する。終了日までの購入者に対する再ダウンロード、更新データの提供その他購入者の利用の維持は継続できる。</span>
<span class="p">(3)　再許諾先　乙は、終了を再許諾先に通知し、前2号と同じ取扱いを求める。</span>
<span class="p">2　前項の販売・提供に係る対価は個別条件書に従う。終了前に生じた支払・報告義務は終了後も存続する。</span>
<span class="p">3　解除による終了、権利の瑕疵、第三者の権利侵害または製品の安全上の問題による終了のときは、在庫の販売および提供の継続の可否と期間を甲乙協議して定める。ただし、甲の責めに帰すべき事由により乙が解除したときは、乙は第1項の取扱いができる。</span></p>
<p class="art"><b>第25条（反社会的勢力の排除）</b>　各当事者は、自らならびにその役員（取締役、執行役、業務を執行する社員その他これらに準ずる者をいう。）および実質的に経営に関与する者が、現在および将来にわたり、次の各号のいずれにも該当しないことを表明し、確約する。
<span class="p">(1)　暴力団、暴力団員、暴力団員でなくなった時から5年を経過しない者、暴力団準構成員、暴力団関係企業、総会屋等、社会運動等標ぼうゴロ、特殊知能暴力集団その他これらに準ずる者（以下「反社会的勢力」という。）であること</span>
<span class="p">(2)　反社会的勢力が経営を支配し、または経営に実質的に関与していると認められる関係を有すること</span>
<span class="p">(3)　自己もしくは第三者の不正の利益を図り、または第三者に損害を加える目的をもって反社会的勢力を利用していると認められる関係を有すること</span>
<span class="p">(4)　反社会的勢力に対して資金等を提供し、または便宜を供与するなどの関与をしていると認められる関係を有すること</span>
<span class="p">(5)　その他反社会的勢力と社会的に非難されるべき関係を有すること</span>
<span class="p">2　各当事者は、自らまたは第三者を利用して、相手方に対し、暴力的な要求行為、法的な責任を超えた不当な要求行為、取引に関して脅迫的な言動をし、もしくは暴力を用いる行為、風説を流布し、偽計もしくは威力を用いて相手方の信用を毀損し、もしくは業務を妨害する行為、その他これらに準ずる行為を行わないことを確約する。</span>
<span class="p">3　各当事者は、再許諾先、委託先その他本契約の履行に関与する第三者が反社会的勢力に該当しないよう努め、該当することが判明したときは、当該第三者との契約の解除その他必要な措置を講じる。</span>
<span class="p">4　各当事者は、相手方が前3項のいずれかに違反したときは、何らの催告を要せず、直ちに本契約および個別条件書の全部または一部を解除できる。</span>
<span class="p">5　前項により解除した当事者は、解除によって相手方に生じた損害を賠償する責任を負わない。解除された当事者は、解除した当事者に生じた損害を賠償する。</span>
<span class="p">6　第4項により乙が解除した場合でも、第24条（終了後の措置）に基づく在庫の販売および提供の継続を妨げない。</span></p>
<p class="art"><b>第26条（損害賠償）</b>　当事者の一方が本契約（個別条件書および発注書を含む。）に違反して相手方に損害を与えたときは、相手方に現実に生じた通常かつ直接の損害（以下「実損害」という。）を賠償する。
<span class="p">2　前項にかかわらず、第15条（表明保証）、第18条（秘密保持）、第19条（個人情報の保護）もしくは第25条（反社会的勢力の排除）の違反により、または故意もしくは重大な過失により相手方に損害を与えたときは、実損害に限らず、当該違反と相当因果関係のある一切の損害（逸失利益および合理的な弁護士費用を含む。）を賠償する。</span>
<span class="p">3　前2項の賠償額に上限は設けない。</span></p>
<p class="art"><b>第27条（従前の合意）</b>　本契約の締結前の合意（書面、電子メール、口頭を問わない。）の扱いは、個別条件書に定めるところによる。定めがないときは従前の合意は存続し、本契約・個別条件書と抵触する部分は本契約・個別条件書が優先する。既に発生した債権債務は影響を受けない。</p>
<p class="art"><b>第28条（準拠法・管轄）</b>　本契約は日本法に準拠し、本契約に関する紛争は東京地方裁判所を第一審の専属的合意管轄裁判所とする。</p>
<p class="art"><b>第29条（通知・協議）</b>　本契約に基づく通知は、基本条件または個別条件書に記載の通知先に対し、書面または電子メールで行う。本契約に定めのない事項は、当事者が誠実に協議して解決する。</p>
<p class="art"><b>第30条（存続）</b>　本契約の終了後も、第6条から第8条まで、第12条から第15条まで、第18条、第19条、第23条、第24条、第25条第5項、第26条、第28条および本条は、なお効力を有する。</p>
<p class="end">（以下余白）</p>

<h2>3. 署名</h2>
<p class="note">甲および乙は、本契約の成立を証するため、本書の電磁的記録を作成し、各自電子署名を施して保管する。書面により締結する場合は本書2通を作成し、記名押印のうえ各1通を保有する。</p>
<div class="sig">
  <div><div class="t">許諾者（甲）</div>
    <div class="f">住所</div><div class="v">{{licensorAddress}}</div>
    <div class="f">{{#if licensorIsCorp}}会社名{{else}}氏名{{/if}}</div><div class="v">{{licensorName}}</div>
    <div class="f">代表者名</div><div class="v">{{#if licensorIsCorp}}{{licensorRep}}{{else}}（個人のため省略）{{/if}}</div>
    <div class="seal">署名<br>／押印</div></div>
  <div><div class="t">被許諾者（乙）</div>
    <div class="f">住所</div><div class="v">{{licenseeAddress}}</div>
    <div class="f">会社名</div><div class="v">{{licenseeName}}</div>
    <div class="f">代表者名</div><div class="v">{{licenseeRep}}</div>
    <div class="seal">署名<br>／押印</div></div>
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'license_master';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'license_master_v5';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('license_master_v5', '著作物利用許諾基本契約書V5', base_category, 'LIC', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'LIC'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '212: 著作物利用許諾基本契約書V5は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '212: 著作物利用許諾基本契約書V5', 'sql:212')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '212: 著作物利用許諾基本契約書V5を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '<!-- license_master_v5 r2 -->') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'license_master_v5';

-- =====================================================================
-- 212 個別利用許諾条件書V5・ボードゲーム（individual_license_terms_v5）の登録
--
--   出版・ボードゲーム共通の基本契約（著作物利用許諾基本契約書V5）と、その個別条件書V5 の 3 本を一度に登録する。
--   事業別条項（出版／ボードゲーム）は基本契約に置かず、個別条件書に置く（基本契約V5 第3条第5項）。
--
--   ・V5 は新しいキーとして足す。既存のひな形（license_master・pub_master_*・individual_license_terms_v3/v4・
--     pub_license_terms_v3/_annex/_multi）と、その版で作った文書には触れない（旧基本契約の相手先は従来の条件書）。
--   ・項目（入力欄）はコードが持つ（LICENSE_MASTER_V5_VARIABLES・LICENSE_TERMS_VARIABLES・PUB_TERMS_VARIABLES）。variables は空。
--   ・採番は従来の帯を続ける（基本契約 LIC／ボードゲームの条件書 ILT／出版の条件書 PUBT）。
--   ・アプリ側は V5 のキーを扱う版（documents/license-master-v5.ts ほか）が先に出ていること。
--
--   本文は infra/v3/templates/individual_license_terms_v5.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/212_v5_license_templates.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'individual_license_terms_v5';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!-- individual_license_terms_v5 r2 -->
<!--
  個別利用許諾条件書V5・ボードゲーム（individual_license_terms_v5）。著作物利用許諾基本契約書V5（license_master_v5）の
  個別条件書。本番へは infra/v3/212 が運ぶ（infra/v3/tools/make-template-sql.mjs で本文から作る）。
  V4（individual_license_terms_v4）の体裁・差し込み（licenseTermsPatch）をそのまま使い、
  04 に事業別条項（ボードゲーム。基本契約V5 第3条第5項）を足した。通知先は 05。
  本文は 01〜05 ＋署名欄、可変長の一覧は改ページして別紙1〜3（V4 と同じ）。
-->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>個別利用許諾条件書 {{contractNo}}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 12mm 14mm 11mm;
    @top-right {
      content: "ARC-LICENSE / INDIVIDUAL TERMS / BOARD GAME";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #888;
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-right {
      content: "{{contractNo}}　個別利用許諾条件書";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #777;
      vertical-align: top; padding-top: 3mm;
    }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif;
    font-size: 7pt; line-height: 1.5; color: #1c1c1c;
  }
  p { margin: 0 0 1.2mm; }
  .en { color: #777; font-weight: normal; letter-spacing: .04em; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .04em; }
  .title-en { font-size: 7pt; color: #777; margin: 0 0 3mm; letter-spacing: .08em; }

  /* 罫線は上の濃い線と行の下の薄い線だけ（縦線なし）。 */
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: .6mm 1.2mm; vertical-align: top; text-align: left; font-weight: normal; }
  .meta td { border-top: 1px solid #222; border-bottom: .5px solid #bebebe; }
  .meta .k, .party .k { color: #888; font-weight: bold; margin-right: 1.5em; }
  .meta b { font-weight: bold; }
  .parties { margin: 1.5mm 0 2mm; }
  .parties td { width: 50%; border-top: 1px solid #222; border-bottom: .5px solid #bebebe; padding: 1.2mm 1.5mm; }
  .party .k { display: block; margin: 0 0 .5mm; letter-spacing: .06em; }
  .party .name { font-weight: bold; }

  h2 { font-size: 9pt; margin: 3mm 0 1.2mm; padding-bottom: .6mm; border-bottom: 1px solid #222;
       break-after: avoid; page-break-after: avoid; }
  h2 .no { color: #999; font-size: 7.5pt; margin-right: 1.2em; }
  h2 .en { font-size: 6.5pt; margin-left: 1.2em; }
  h3 { font-size: 7pt; margin: 2.5mm 0 1mm; break-after: avoid; }

  .kv td { border-bottom: .5px solid #d0d0d0; }
  .kv tr:first-child td { border-top: .5px solid #555; }
  .kv td.k { width: 22mm; background: #f5f5f5; font-weight: bold; white-space: nowrap; }
  .kv tr { break-inside: avoid; page-break-inside: avoid; }

  .grid th { background: #f2f2f2; font-weight: bold; border-top: 1px solid #555; border-bottom: .5px solid #999; }
  .grid td { border-bottom: .5px solid #d0d0d0; }
  .grid td.c, .grid th.c { text-align: center; }
  .grid tr { break-inside: avoid; page-break-inside: avoid; }
  .grid thead { display: table-header-group; }
  .grid tfoot td { background: #f5f5f5; font-weight: bold; border-top: .5px solid #555; }
  .grid td.sub { color: #555; border-bottom: .5px solid #d0d0d0; }
  .grid tr.has-sub td { border-bottom: none; }
  .grid tr.memo td { background: #fafafa; color: #555; }
  .role { color: #777; display: block; }

  /* 許諾料の欄。取引モデルごとのカードを横に並べる。 */
  .cards { display: flex; gap: 2mm; margin: 1mm 0 2mm; break-inside: avoid; }
  .card { flex: 1; border-top: 1px solid #555; border-bottom: .5px solid #d0d0d0; padding: 1mm 1.5mm; }
  .card .en { display: block; color: #1c1c1c; font-weight: bold; letter-spacing: .06em; }
  .card .name { font-weight: bold; }
  .card .rate { margin-top: .6mm; }
  .card .rate b { font-size: 10pt; margin-left: .6em; }
  .card .f { color: #555; }

  .sign { margin-top: 4mm; break-inside: avoid; page-break-inside: avoid; }
  .sign td { width: 50%; border-top: 1px solid #222; padding: 1.5mm 1.5mm 2mm; }
  .sign td + td { padding-left: 5mm; }
  .sign .who { color: #888; font-weight: bold; letter-spacing: .06em; }
  .party-sign { display: flex; align-items: flex-start; gap: 3mm; min-height: 9mm; }
  .party-sign .names { flex: 1; }
  /* 印の枠。 */
  .stamp { width: 15mm; height: 15mm; border: .5px dashed #888; border-radius: 50%;
           display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 8pt; }
  /* 署名日・署名の枠。高さは 12pt 固定（CloudSign の入力欄をこの枠に合わせる）。 */
  .field { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
  .field .lbl { width: 10mm; color: #555; }
  .field .box { flex: 1; height: 12pt; box-sizing: border-box; border: .5px solid #999; }
  /* 記名＋署名／押印の枠（ハイブリッド）。名称・代表者を左に刷り、右に印の丸。署名はこの枠に重ねる。 */
  .field.seal-row { align-items: stretch; }
  .sign .field .lbl { width: 14mm; }
  .field.seal-row .lbl { line-height: 1.3; align-self: center; white-space: nowrap; }
  .field .sign-box { height: 17mm; display: flex; align-items: center; justify-content: space-between; padding: 0 2mm; }
  .sign-box .pname { line-height: 1.45; }
  .sign-box .stamp { width: 13mm; height: 13mm; flex: none; }
  /* 通知先は 12pt 固定の枠（1行。長い連絡先ははみ出さず切る）。 */
  .notice td { padding-top: 0; padding-bottom: 0; vertical-align: middle; }
  .notice .fix { height: 12pt; line-height: 12pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 通知先と署名欄は割らない（署名欄だけが次のページに送られないように）。 */
  .tail { break-inside: avoid; page-break-inside: avoid; }

  .annex { break-before: page; page-break-before: always; }
  /* 別紙の見出しは3つとも同じ形（本文の 01〜04 と同じ組み方で、少し大きく）。 */
  .annex h2 { font-size: 10pt; margin: 0 0 1.5mm; }
  .annex h2 .no { font-size: 8pt; }
  .annex .part + .part { margin-top: 6mm; }
  .lead { color: #555; }
  .grid th .l2 { display: block; font-weight: normal; font-size: 6.5pt; white-space: nowrap; }
</style>
</head>
<body>

<h1>個別利用許諾条件書</h1>
<p class="title-en">INDIVIDUAL LICENSE TERMS ／ ボードゲーム</p>

<table class="meta">
  <tr>
    <td><span class="k">ISSUED</span><b>{{formatDateDot issueDate}}</b></td>
    <td><span class="k">NO.</span><b>{{contractNo}}</b></td>
    <td>{{#if workId}}<span class="k">WORK ID</span><b>{{workId}}</b>{{/if}}</td>
  </tr>
</table>

<table class="parties">
  <tr>
    <td class="party">
      <span class="k">LICENSOR / 許諾者</span>
      <div class="name">{{licensorName}}</div>
      <div>{{licensorAddress}}</div>
      {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
    </td>
    <td class="party">
      <span class="k">LICENSEE / 被許諾者</span>
      <div class="name">{{licenseeName}}</div>
      <div>{{licenseeAddress}}</div>
      {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
    </td>
  </tr>
</table>

<p>許諾者と被許諾者は、両者間の{{#if masterAgreement}}{{masterAgreement}}{{else}}基本契約{{/if}}（以下「基本契約」という。）に基づき、以下のとおり個別の利用許諾条件を定める。本条件書に定めのない事項は基本契約による。</p>

<h2><span class="no">01</span>対象著作物<span class="en">LICENSED WORKS</span></h2>
<p>許諾の対象となる著作物、構成要素、権利元、取引モデル別料率及び根拠文書は、別紙2「対象著作物一覧」に定める。別紙2の「適用料率」を第2条の許諾料計算に用いる。</p>

<h2><span class="no">02</span>許諾条件<span class="en">LICENSE TERMS</span></h2>
<table class="kv">
  <tr><td class="k">対象製品</td><td>「{{productName}}」（以下「対象製品」という。）</td></tr>
  <tr><td class="k">利用の範囲</td><td>被許諾者は、第1条に定める対象著作物を対象製品に利用し、対象製品を企画、開発、製造及び販売（販売店その他の第三者を通じた販売を含む。）し、並びに対象製品の広告、宣伝その他販売促進のために必要な範囲で対象著作物を利用することができる。これら以外の利用については、許諾者及び被許諾者が別途書面により合意するものとする。</td></tr>
  <tr><td class="k">許諾期間</td><td>本許諾の開始日は{{formatDate startDate}}とする。本許諾の終了、更新その他の有効期間に関する事項は、{{#if masterAgreement}}{{masterAgreement}}{{else}}基本契約{{/if}}の定めに従う。</td></tr>
  {{#if (eq sublicenseMode "consent")}}<tr><td class="k">再許諾</td><td>被許諾者は、許諾者の事前の書面による承諾を得た場合に限り、第三者に対して対象著作物の利用を再許諾することができる。再許諾に関する条件及び再許諾先は、第3条及び別紙3「再許諾先一覧」に定める。</td></tr>{{/if}}
  {{#if (eq sublicenseMode "covered")}}<tr><td class="k">再許諾</td><td>被許諾者は、本条件書に定める範囲内で、第三者に対して対象著作物の利用を再許諾することができる。再許諾に関する条件及び再許諾先は、第3条及び別紙3「再許諾先一覧」に定める。</td></tr>{{/if}}
  {{#if (eq sublicenseMode "none")}}<tr><td class="k">再許諾</td><td>被許諾者は、第三者に対して対象著作物の利用を再許諾することができない。</td></tr>{{/if}}
  {{#if supervisor}}<tr><td class="k">監修</td><td>被許諾者は、対象製品の内容について、許諾者が指定する監修者（{{supervisor}}）による監修を受けるものとする。</td></tr>{{/if}}
  <tr><td class="k">特記事項</td><td>{{#if specialExtras.length}}本条件書に関する個別の追加条件、例外その他の特記事項は、別紙1「特記事項」に定める。別紙1は本条件書の一部を構成し、本条件書の本文と一体として適用される。{{else}}なし{{/if}}</td></tr>
</table>

<p style="margin-top:2mm">各取引モデルにおける独占性、許諾地域及び許諾言語は、次のとおりとする。</p>
<h3>取引モデル別の許諾範囲 <span class="en">/ LICENSE SCOPE BY MODEL</span></h3>
<table class="grid">
  <thead><tr><th>取引モデル</th><th>独占性</th><th>許諾地域</th><th>許諾言語</th></tr></thead>
  <tbody>
  {{#each conds}}
    <tr><td>{{condName}}</td><td>{{condExclusivity}}</td><td>{{condRegion}}</td><td>{{condLang}}</td></tr>
  {{/each}}
  </tbody>
</table>

<h3>許諾料 <span class="en">/ ROYALTY</span></h3>
<p>被許諾者が許諾者に支払う許諾料は、各取引モデルに応じ、以下の算定基礎及び適用料率により算定する。構成要素ごとの料率及びその内訳は別紙2に定める。</p>
<div class="cards">
  {{#each conds}}
  <div class="card">
    {{#if condNameEn}}<span class="en">{{condNameEn}}</span>{{/if}}
    <div class="name">{{condName}}</div>
    <div class="rate">適用料率<b>{{appliedRate}}</b></div>
    <div class="f">{{condFormulaRated}}</div>
    {{#if hasGuarantee}}<div class="f">{{#if (gt ag 0)}}前払保証金 {{ag}} {{currency}}　{{/if}}{{#if (gt mg 0)}}最低保証 {{mg}} {{currency}}{{/if}}</div>{{/if}}
  </div>
  {{/each}}
</div>
<table class="kv">
  <tr><td class="k">算定基準日</td><td>許諾料の算定に用いる数量の基準日は、{{#each calcBaseRows}}{{edition}}については{{trigger}}{{#if note}}（{{note}}）{{/if}}{{#unless @last}}、{{/unless}}{{/each}}とする。</td></tr>
  <tr><td class="k">報告・支払</td><td>{{reportSentence}}</td></tr>
</table>

<h2><span class="no">03</span>再許諾<span class="en">SUBLICENSE</span></h2>
<p>第三者に再許諾したときは、再許諾先・取引モデル・地域・言語・料率・開始日を別紙3「再許諾先一覧」に記載する。追加時は別紙3に行を加え、その更新をもって本条件書の一部とする。</p>

<h2><span class="no">04</span>ボードゲームに関する定め<span class="en">BOARD GAME TERMS</span></h2>
<p>本条は、基本契約第3条第5項に定める事業別条項（ボードゲーム）とし、変更するときは別紙1「特記事項」に定める。</p>
<table class="kv">
  <tr><td class="k">ボードゲーム化の範囲</td><td>第2条の利用には、本条件書の範囲で、対象著作物をゲームのルール、カード、ボード、駒その他の構成要素に翻案し、被許諾者のゲームデザインと組み合わせることを含む。デジタル版（アプリ、PC、ブラウザ等）の提供は、別紙1に定めがある場合に限る。</td></tr>
  <tr><td class="k">素材・表示</td><td>許諾者は、許諾者及び被許諾者が別に定める期日及び形式（ファイル名・版、解像度、レイヤー構成等）で、別紙2の構成要素ごとに素材データを被許諾者に引き渡す。被許諾者は、印刷・製造に必要な範囲で、トリミング、色調整、配置の変更を行うことができる。商標・ロゴは、許諾者が示す表示の指針に従って使用する。</td></tr>
  <tr><td class="k">監修・承認</td><td>原許諾により許諾者又は原権利者の明示の承認を要する事項は別紙1で指定し、当該事項には基本契約第9条第3項の承認のみなしを適用しない。</td></tr>
  <tr><td class="k">製品の安全</td><td>被許諾者は、自ら製造・販売する対象製品の安全性及び表示について責任を負い、事故を知ったときは許諾者に通知する。許諾者が製品の仕様を指定する場合、又は再許諾先が製造・輸入する場合の、製品の安全・表示・事故の通知・回収の判断者と費用の負担は、別紙1に定める。</td></tr>
  <tr><td class="k">拡張・新版</td><td>拡張セット、新版、続編、他言語版その他の派生製品は、原則として新たな条件書による。ただし、第3条及び別紙3により再許諾を認めた他言語版、対象製品の再版、仕様の軽微な変更及び構成要素の差替えは、本条件書による。許諾者が対象著作物を用いたボードゲーム製品を第三者に許諾しようとするときは、被許諾者に優先交渉の機会を与える。</td></tr>
</table>

<div class="tail">
<h2><span class="no">05</span>通知先<span class="en">NOTICES</span></h2>
<table class="kv notice">
  <tr><td class="k"><div class="fix">許諾者</div></td><td><div class="fix">{{licensorContact}}</div></td></tr>
  <tr><td class="k"><div class="fix">被許諾者</div></td><td><div class="fix">{{licenseeContact}}</div></td></tr>
</table>

{{#unless (eq 署名欄 "表示しない")}}
<!-- 署名欄（署名・押印のどちらでもよい）。記名（名称・代表者）は自動で刷る。署名日の枠と、記名の枠の
     「署名／押印」の場所は空のまま（電子署名は CloudSign の入力欄をこの枠に重ね、紙なら印の丸に押印する）。 -->
<table class="sign">
  <tr>
    <td>
      <span class="who">LICENSOR / 許諾者</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licensorName}}</b>{{#if licensorIsCorp}}{{#if licensorRep}}<br>{{licensorRep}}{{/if}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
    <td>
      <span class="who">LICENSEE / 被許諾者</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licenseeName}}</b>{{#if licenseeRep}}<br>{{licenseeRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
  </tr>
</table>
{{/unless}}
</div>

<!-- 別紙。本文（署名欄まで）の後ろに改ページして付ける。 -->
<div class="annex">
<div class="part">
<h2><span class="no">別紙1</span>特記事項<span class="en">SPECIAL TERMS</span></h2>
{{#if specialExtras.length}}
<p class="lead">本条件書の本文に定める条件に加え、次の特記事項を適用する。</p>
{{#each specialExtras}}<p>{{#if seId}}({{seId}}) {{/if}}{{seText}}</p>{{/each}}
{{else}}
<p>なし</p>
{{/if}}
</div>

<div class="part">
<h2><span class="no">別紙2</span>対象著作物一覧<span class="en">LICENSED WORKS REGISTER</span></h2>
<p class="lead">一覧の1行が構成要素1点。コアロジックは許諾の対象そのもの、サブコンポーネントは追加の許諾料が発生する要素を示す。料率は取引モデルごとの合意料率を示し、「—」は当該モデルで料率がないことを示す。</p>
<table class="grid">
  <thead>
    <tr>
      <th class="c" style="width:7mm">No.</th>
      <th>構成要素</th>
      {{#if showHolder}}<th style="width:30mm">権利元</th>{{/if}}
      {{#each conds}}<th class="c" style="width:22mm">{{condHead1}}{{#if condHead2}}<span class="l2">{{condHead2}}</span>{{/if}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
  {{#each lcs}}
    <tr class="has-sub">
      <td class="c">{{index1 @index}}</td>
      <td><b>{{lcName}}</b><span class="role">{{lcRole}}</span></td>
      {{#if ../showHolder}}<td>{{lcHolder}}</td>{{/if}}
      {{#each dealRates}}<td class="c">{{this}}</td>{{/each}}
    </tr>
    <tr>
      <td class="sub"></td>
      <td class="sub" colspan="{{add (add ../conds.length 1) (or ../showHolder 0)}}">{{#if lcNote}}{{lcNote}}<br>{{/if}}根拠文書　{{lcSourceDoc}}</td>
    </tr>
  {{/each}}
  </tbody>
  {{#if conds.length}}
  <tfoot>
    <tr>
      <td></td>
      <td{{#if showHolder}} colspan="2"{{/if}}>適用料率</td>
      {{#each conds}}<td class="c">{{appliedRate}}</td>{{/each}}
    </tr>
  </tfoot>
  {{/if}}
</table>
</div>

<div class="part">
<h2><span class="no">別紙3</span>再許諾先一覧<span class="en">SUBLICENSE REGISTER</span></h2>
<p class="lead">一覧の1行が再許諾1件。再許諾先を追加したときは、その都度本別紙に行を加える。料率は、当該再許諾について被許諾者が許諾者に支払う許諾料の料率を示す。</p>
<table class="grid">
  <thead>
    <tr><th class="c" style="width:7mm">No.</th><th>再許諾先</th><th>取引モデル</th><th>地域 / 言語</th><th class="c" style="width:14mm">料率</th><th class="c" style="width:20mm">開始日</th></tr>
  </thead>
  <tbody>
  {{#each sublicensees}}
    <tr><td class="c">{{index1 @index}}</td><td>{{slPartner}}</td><td>{{slCond}}</td><td>{{slRegion}} / {{slLang}}</td>
      <td class="c">{{#if slRate}}{{slRate}}%{{/if}}</td><td class="c">{{formatDateDot slDate}}</td></tr>
    {{#if slNote}}<tr class="memo"><td></td><td>備考</td><td colspan="4">{{slNote}}</td></tr>{{/if}}
  {{/each}}
  {{#unless sublicensees.length}}
    <tr><td></td><td colspan="5">（本条件書の締結時点で再許諾先はない）</td></tr>
  {{/unless}}
  </tbody>
</table>
</div>
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'individual_license_terms_v4';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'individual_license_terms_v5';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('individual_license_terms_v5', '個別利用許諾条件書V5（ボードゲーム）', base_category, 'ILT', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'ILT'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '212: 個別利用許諾条件書V5（ボードゲーム）は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '212: 個別利用許諾条件書V5（ボードゲーム）', 'sql:212')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '212: 個別利用許諾条件書V5（ボードゲーム）を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '<!-- individual_license_terms_v5 r2 -->') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'individual_license_terms_v5';

-- =====================================================================
-- 212 個別利用許諾条件書V5・出版 一覧形式（pub_license_terms_v5）の登録
--
--   出版・ボードゲーム共通の基本契約（著作物利用許諾基本契約書V5）と、その個別条件書V5 の 3 本を一度に登録する。
--   事業別条項（出版／ボードゲーム）は基本契約に置かず、個別条件書に置く（基本契約V5 第3条第5項）。
--
--   ・V5 は新しいキーとして足す。既存のひな形（license_master・pub_master_*・individual_license_terms_v3/v4・
--     pub_license_terms_v3/_annex/_multi）と、その版で作った文書には触れない（旧基本契約の相手先は従来の条件書）。
--   ・項目（入力欄）はコードが持つ（LICENSE_MASTER_V5_VARIABLES・LICENSE_TERMS_VARIABLES・PUB_TERMS_VARIABLES）。variables は空。
--   ・採番は従来の帯を続ける（基本契約 LIC／ボードゲームの条件書 ILT／出版の条件書 PUBT）。
--   ・アプリ側は V5 のキーを扱う版（documents/license-master-v5.ts ほか）が先に出ていること。
--
--   本文は infra/v3/templates/pub_license_terms_v5.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/212_v5_license_templates.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'pub_license_terms_v5';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!-- pub_license_terms_v5 r6 -->
<!--
  個別利用許諾条件書V5・出版（pub_license_terms_v5）。少数作品用（一覧を01に載せる。別紙なし）。著作物利用許諾基本契約書V5（license_master_v5）の個別条件書。
  本番へは infra/v3/212 が運ぶ（infra/v3/tools/make-template-sql.mjs で本文から作る）。
  体裁は individual_license_terms_v5 と同じ（head・CSS を共有）。差し込みは pubTermsPatch の値（pub_license_terms_v3 と同じ名前）。
  07 が事業別条項（出版。基本契約V5 第3条第5項）。
-->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>個別利用許諾条件書 {{docNo}}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 12mm 14mm 11mm;
    @top-right {
      content: "ARC-LICENSE / INDIVIDUAL TERMS / PUBLISHING";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #888;
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-right {
      content: "{{docNo}}　個別利用許諾条件書（出版）";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #777;
      vertical-align: top; padding-top: 3mm;
    }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif;
    font-size: 7pt; line-height: 1.5; color: #1c1c1c;
  }
  p { margin: 0 0 1.2mm; }
  .en { color: #777; font-weight: normal; letter-spacing: .04em; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .04em; }
  .title-en { font-size: 7pt; color: #777; margin: 0 0 3mm; letter-spacing: .08em; }

  /* 罫線は上の濃い線と行の下の薄い線だけ（縦線なし）。 */
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: .6mm 1.2mm; vertical-align: top; text-align: left; font-weight: normal; }
  .meta td { border-top: 1px solid #222; border-bottom: .5px solid #bebebe; }
  .meta .k, .party .k { color: #888; font-weight: bold; margin-right: 1.5em; }
  .meta b { font-weight: bold; }
  .parties { margin: 1.5mm 0 2mm; }
  .parties td { width: 50%; border-top: 1px solid #222; border-bottom: .5px solid #bebebe; padding: 1.2mm 1.5mm; }
  .party .k { display: block; margin: 0 0 .5mm; letter-spacing: .06em; }
  .party .name { font-weight: bold; }

  h2 { font-size: 9pt; margin: 3mm 0 1.2mm; padding-bottom: .6mm; border-bottom: 1px solid #222;
       break-after: avoid; page-break-after: avoid; }
  h2 .no { color: #999; font-size: 7.5pt; margin-right: 1.2em; }
  h2 .en { font-size: 6.5pt; margin-left: 1.2em; }
  h3 { font-size: 7pt; margin: 2.5mm 0 1mm; break-after: avoid; }

  .kv td { border-bottom: .5px solid #d0d0d0; }
  .kv tr:first-child td { border-top: .5px solid #555; }
  .kv td.k { width: 22mm; background: #f5f5f5; font-weight: bold; white-space: nowrap; }
  .kv tr { break-inside: avoid; page-break-inside: avoid; }

  .grid th { background: #f2f2f2; font-weight: bold; border-top: 1px solid #555; border-bottom: .5px solid #999; }
  .grid td { border-bottom: .5px solid #d0d0d0; }
  .grid td.c, .grid th.c { text-align: center; }
  .grid tr { break-inside: avoid; page-break-inside: avoid; }
  .grid thead { display: table-header-group; }
  .grid tfoot td { background: #f5f5f5; font-weight: bold; border-top: .5px solid #555; }
  .grid td.sub { color: #555; border-bottom: .5px solid #d0d0d0; }
  .grid tr.has-sub td { border-bottom: none; }
  .grid tr.memo td { background: #fafafa; color: #555; }
  .role { color: #777; display: block; }

  /* 許諾料の欄。取引モデルごとのカードを横に並べる。 */
  .cards { display: flex; gap: 2mm; margin: 1mm 0 2mm; break-inside: avoid; }
  .card { flex: 1; border-top: 1px solid #555; border-bottom: .5px solid #d0d0d0; padding: 1mm 1.5mm; }
  .card .en { display: block; color: #1c1c1c; font-weight: bold; letter-spacing: .06em; }
  .card .name { font-weight: bold; }
  .card .rate { margin-top: .6mm; }
  .card .rate b { font-size: 10pt; margin-left: .6em; }
  .card .f { color: #555; }

  .sign { margin-top: 4mm; break-inside: avoid; page-break-inside: avoid; }
  .sign td { width: 50%; border-top: 1px solid #222; padding: 1.5mm 1.5mm 2mm; }
  .sign td + td { padding-left: 5mm; }
  .sign .who { color: #888; font-weight: bold; letter-spacing: .06em; }
  .party-sign { display: flex; align-items: flex-start; gap: 3mm; min-height: 9mm; }
  .party-sign .names { flex: 1; }
  /* 印の枠。 */
  .stamp { width: 15mm; height: 15mm; border: .5px dashed #888; border-radius: 50%;
           display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 8pt; }
  /* 署名日・署名の枠。高さは 12pt 固定（CloudSign の入力欄をこの枠に合わせる）。 */
  .field { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
  .field .lbl { width: 10mm; color: #555; }
  .field .box { flex: 1; height: 12pt; box-sizing: border-box; border: .5px solid #999; }
  /* 記名＋署名／押印の枠（ハイブリッド）。名称・代表者を左に刷り、右に印の丸。署名はこの枠に重ねる。 */
  .field.seal-row { align-items: stretch; }
  .sign .field .lbl { width: 14mm; }
  .field.seal-row .lbl { line-height: 1.3; align-self: center; white-space: nowrap; }
  .field .sign-box { height: 17mm; display: flex; align-items: center; justify-content: space-between; padding: 0 2mm; }
  .sign-box .pname { line-height: 1.45; }
  .sign-box .stamp { width: 13mm; height: 13mm; flex: none; }
  /* 通知先は 12pt 固定の枠（1行。長い連絡先ははみ出さず切る）。 */
  .notice td { padding-top: 0; padding-bottom: 0; vertical-align: middle; }
  .notice .fix { height: 12pt; line-height: 12pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 通知先と署名欄は割らない（署名欄だけが次のページに送られないように）。 */
  .tail { break-inside: avoid; page-break-inside: avoid; }

  .annex { break-before: page; page-break-before: always; }
  /* 別紙の見出しは3つとも同じ形（本文の 01〜04 と同じ組み方で、少し大きく）。 */
  .annex h2 { font-size: 10pt; margin: 0 0 1.5mm; }
  .annex h2 .no { font-size: 8pt; }
  .annex .part + .part { margin-top: 6mm; }
  .lead { color: #555; }
  .grid th .l2 { display: block; font-weight: normal; font-size: 6.5pt; white-space: nowrap; }
</style>
</head>
<body>

<h1>個別利用許諾条件書</h1>
<p class="title-en">INDIVIDUAL LICENSE TERMS ／ 出版</p>

<table class="meta">
  <tr>
    <td><span class="k">ISSUED</span><b>{{formatDateDot signDate}}</b></td>
    <td><span class="k">NO.</span><b>{{docNo}}</b></td>
    <td>{{#if agreementNo}}<span class="k">MASTER</span><b>{{agreementNo}}</b>{{/if}}</td>
  </tr>
</table>

<table class="parties">
  <tr>
    <td class="party">
      <span class="k">LICENSOR / 許諾者（甲）</span>
      <div class="name">{{licensorName}}</div>
      <div>{{licensorAddress}}</div>
      {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
      {{#if licensorInvoiceNo}}<div>登録番号 {{licensorInvoiceNo}}</div>{{/if}}
    </td>
    <td class="party">
      <span class="k">LICENSEE / 被許諾者（乙）</span>
      <div class="name">{{licenseeName}}</div>
      <div>{{licenseeAddress}}</div>
      {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
      {{#if licenseeInvoiceNo}}<div>登録番号 {{licenseeInvoiceNo}}</div>{{/if}}
    </td>
  </tr>
</table>

<p>甲と乙は、両者間の{{agreementTitle}}{{#if agreementNo}}（{{agreementNo}}）{{/if}}（以下「基本契約」という。）に基づき、以下のとおり個別の利用許諾条件を定める。本条件書に定めのない事項は基本契約による。</p>
{{#if payeeTerms}}<p>本条件書は、甲が対象著作物の共同著作者（権利者の一人）として有する取り分に係る許諾条件を定める。第1条の一覧の「料率」は甲に帰属する料率（対象著作物全体の料率に甲の取り分を乗じたもの）であり、括弧内は対象著作物全体の料率、甲の取り分は同一覧の「共同著作」欄に記載のとおりとする。甲に支払う許諾料は、甲に帰属する料率により算定する。</p>{{/if}}

<h2><span class="no">01</span>対象著作物<span class="en">LICENSED WORKS</span></h2>
<p class="lead">一覧の1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。許諾期間は作品ごとに同じNo.の下の行に示し、「更新 n 回」は許諾開始日（刊行日）から本条件書の締結日までに自動更新した回数を示す（第3条）。自動更新しない作品は「更新なし」、更新を止めた作品は「以後更新しない」と付す。</p>
<table class="grid">
  <thead>
    <tr>
      <th class="c" style="width:7mm">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th style="width:30mm">著作権表示</th>
      <th style="width:26mm">共同著作・第三者権利</th>
      <th class="c" style="width:20mm">紙<span class="l2">料率／独占区分</span></th>
      <th class="c" style="width:20mm">電子<span class="l2">料率／独占区分</span></th>
    </tr>
  </thead>
  {{#each titles}}
  <tbody>
    <tr{{#if hasNoteRow}} class="has-sub"{{/if}}>
      <td class="c">{{no}}</td>
      <td><b>{{title}}</b>{{#if edition}}<span class="role">{{edition}}</span>{{/if}}</td>
      <td>{{copyright}}</td>
      <td>{{thirdParty}}</td>
      <td class="c">{{printRate}}{{#if hasPrint}}／{{printExclusivity}}{{/if}}</td>
      <td class="c">{{digitalRate}}{{#if hasDigital}}／{{digitalExclusivity}}{{/if}}</td>
    </tr>
    {{#if hasNoteRow}}
    <tr>
      <td class="sub"></td>
      <td class="sub" colspan="5">{{#if hasTerm}}許諾期間　{{term}}{{/if}}{{#if hasShares}}　／　共同著作　{{coAuthors}}{{#if payeeShare}}（{{payeeShare}}）{{/if}}{{/if}}{{#if note}}　／　備考　{{note}}{{/if}}</td>
    </tr>
    {{/if}}
  </tbody>
  {{/each}}
  {{#unless titles.length}}
  <tbody><tr><td></td><td colspan="5">（対象著作物がありません。条件明細を選んでください）</td></tr></tbody>
  {{/unless}}
</table>

<h2><span class="no">02</span>許諾内容<span class="en">LICENSE SCOPE</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>対象出版物の複製・頒布（乙の子会社その他の出版社に再許諾して行わせることを含む）。独占・非独占の別は第1条の一覧の「紙」欄による。</td></tr>
  <tr><td class="k">電子書籍配信</td><td>主要電子書店における配信（DRM付き。電子書籍の配信事業者に再許諾して行わせることを含む）。独占・非独占の別は第1条の一覧の「電子」欄による。「電子」欄が「—」の作品は対象外とする。</td></tr>
  <tr><td class="k">再許諾</td><td>紙媒体出版・電子書籍配信の再許諾は、本条件書の許諾の範囲（地域・言語・媒体）内で行い、甲の個別の事前承諾を要しない。乙は、再許諾先を甲に通知し、再許諾先の行為について甲に対し責任を負う。</td></tr>
  <tr><td class="k">販促・広告利用</td><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><td class="k">二次利用</td><td>{{#if translationDerivative}}翻訳（二次的著作物の作成）及び翻訳物の出版・配信、映像化・商品化その他の二次利用は、いずれも本条件書の対象外とし、甲乙の別途合意による。翻訳権その他著作権法第27条・第28条に定める権利は甲に留保され、本条件書による許諾には含まれない。{{else}}翻訳版の出版・配信、映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。{{/if}}</td></tr>
</table>

<h2><span class="no">03</span>許諾期間・地域・言語<span class="en">TERM / TERRITORY / LANGUAGE</span></h2>
<table class="kv">
  <tr><td class="k">許諾期間</td><td>{{#if hasWorkTerms}}対象著作物ごとに第1条の一覧の「許諾期間」の行による（自動更新した回数は同行のとおり）。{{else}}{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{/if}}</td></tr>
  {{#if termEnd}}
  <tr><td class="k">更新</td><td>{{#if autoRenew}}期間満了の{{noticeBefore}}前までにいずれの当事者からも書面による終了の通知がない場合、同一条件で{{renewPeriod}}ごとに自動更新する。{{else}}自動更新しない。延長は甲乙協議のうえ書面で定める。{{/if}}</td></tr>
  {{/if}}
  <tr><td class="k">地域</td><td>{{region}}</td></tr>
  <tr><td class="k">言語</td><td>{{language}}</td></tr>
</table>

<h2><span class="no">04</span>許諾料<span class="en">ROYALTY</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>乙又は再許諾先が発行する対象出版物の税抜定価 × 印税対象部数 × 料率（第1条の一覧の「紙」欄）。印税対象部数は刷部数とし、見本・献本・破損分を除く。増刷時に刷部数の一部を印税対象部数から除く定め（非加算）のある作品は、一覧の備考欄の率による。初版部数その他の個別の取り決めは一覧の備考欄による。</td></tr>
  <tr><td class="k">電子書籍配信</td><td>乙又は再許諾先による配信の配信価格（税抜）× ダウンロード数 × 料率（第1条の一覧の「電子」欄）。「電子」欄が「—」の作品には電子書籍配信の許諾料は発生しない。</td></tr>
</table>

<h2><span class="no">05</span>支払時期・方法<span class="en">PAYMENT</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>{{#if hasPrintMedia}}刷部数確定の都度、{{payPrint}}までに支払う。{{else}}—{{/if}}</td></tr>
  <tr><td class="k">電子書籍配信</td><td>{{#if hasDigitalMedia}}毎年1月1日〜3月31日、4月1日〜6月30日、7月1日〜9月30日及び10月1日〜12月31日を集計期間とする。乙は、各集計期間に再許諾先（配信事業者）から受領した報告に基づき、当該集計期間の最終月の翌月末日までに甲に報告し、その翌月末日までに支払う。{{else}}—{{/if}}</td></tr>
  <tr><td class="k">消費税・源泉</td><td>上記金額は税抜とし、消費税（{{taxRate}}%）を別途加算する。{{#if withholding}}乙は法令に基づき所得税及び復興特別所得税を源泉徴収し、その残額を支払う。{{else}}甲が法人であるため源泉徴収は行わない。{{/if}}</td></tr>
  <tr><td class="k">報告</td><td>乙は支払の際、作品ごとの刷部数・定価・ダウンロード数・配信価格を記載した明細を甲に提出する。再許諾先が行うものは、再許諾先ごとに、受領した報告の対象期間を併記する。</td></tr>
  <tr><td class="k">振込先</td><td>{{#if hasBank}}{{BANK_INFO}}　{{/if}}振込手数料は乙の負担とする。</td></tr>
</table>

<h2><span class="no">06</span>権利処理・著作権表示<span class="en">RIGHTS / CREDIT</span></h2>
<table class="kv">
  <tr><td class="k">第三者の知的財産</td><td>一覧の「共同著作・第三者権利」欄に記載のある作品について、当該第三者の権利処理は甲が行い、甲は当該第三者に対する対価の支払について乙に責任が及ばないことを保証する。</td></tr>
  <tr><td class="k">著作権表示</td><td>乙は対象出版物の奥付その他甲乙が合意した位置に、一覧の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は備考欄による。{{#if translationDerivative}}別途合意により翻訳物を出版するときは、原著作物の題号及び原著作者名を、翻訳物であることが分かる形で表示する。{{/if}}</td></tr>
</table>

<h2><span class="no">07</span>出版に関する定め<span class="en">PUBLISHING TERMS</span></h2>
<p>本条は、基本契約第3条第5項に定める事業別条項（出版）とし、変更するときは第9条（特記事項）に定める。</p>
<table class="kv">
  <tr><td class="k">紙媒体の権利の形</td><td>第1条の一覧の「紙」欄が非独占の作品は非独占の利用許諾、独占の作品は独占的利用許諾とする。ただし、同一覧の備考欄または第9条（特記事項）に「出版権設定」とある作品は、甲は乙に著作権法第80条第1項第1号の出版権を設定する。</td></tr>
  <tr><td class="k">出版権の内容</td><td>出版権を設定した作品について、出版権の存続期間は当該作品の許諾期間とする。著作権法第81条の出版の時期および継続出版の義務は、同条ただし書の別段の定めとして、基本契約第10条（販売）および第11条（販売終了）による。乙は、改めて複製しようとするときは、その都度あらかじめ甲に通知する（同法第82条第2項）。甲は、乙が同法第80条第3項により第三者に複製または公衆送信を許諾することを承諾する。甲は出版権の設定の登録に協力し、出版権が消滅したときは乙が抹消の登録に協力する。</td></tr>
  <tr><td class="k">電子書籍・貸与</td><td>電子書籍は、第1条の一覧の「電子」欄に独占と明示した作品を除き非独占の利用許諾とし、乙は適切な技術的保護手段を施す。乙は、紙媒体出版物の貸与および図書館等による電子書籍の貸出について、管理団体を通じて許諾し、使用料を受領することができる。甲への配分は第9条（特記事項）に定め、定めがないときは乙が受領した使用料に当該作品の紙・電子の料率を乗じた額とする。</td></tr>
  <tr><td class="k">原稿の引渡し・校正</td><td>原稿を新たに引き渡す作品について、甲は、甲乙が別に定める期日までに完全な原稿（乙が出版に適すると合理的に認めたものをいう。）を乙に引き渡す。校正は甲乙が協力して行い、甲は乙に校正を委ねることができる。</td></tr>
  <tr><td class="k">改訂版・新版</td><td>誤植・誤記の訂正、組版・装丁・判型の変更その他の軽微な修正は本条件書による。本文の実質的な変更、書名の変更、増補、改訂版、新装版その他の新たな版は、甲の承諾を得て、新たな条件書による。甲が改訂版等を第三者から出版しようとするときは、乙に優先交渉の機会を与える。</td></tr>
</table>

<h2><span class="no">08</span>旧合意との関係<span class="en">PRIOR AGREEMENTS</span></h2>
<p>対象著作物に関する甲乙間の従前の合意（覚書・電子メールその他形式を問わない）の扱いは、基本契約第27条により第9条（特記事項）に定める。定めのない従前の合意は存続し、本条件書と抵触する部分は本条件書が優先する。本条件書と基本契約が矛盾する場合は本条件書が優先する。</p>

<h2><span class="no">09</span>特記事項<span class="en">SPECIAL TERMS</span></h2>
{{#if specialNotes}}<p>{{specialNotes}}</p>{{else}}<p>なし</p>{{/if}}

<div class="tail">
<h2><span class="no">10</span>通知先<span class="en">NOTICES</span></h2>
<table class="kv notice">
  <tr><td class="k"><div class="fix">甲</div></td><td><div class="fix">{{licensorContact}}</div></td></tr>
  <tr><td class="k"><div class="fix">乙</div></td><td><div class="fix">{{licenseeContact}}</div></td></tr>
</table>

{{#if showSignature}}
<!-- 署名欄（署名・押印のどちらでもよい）。記名（名称・代表者）は自動で刷る。署名日の枠と「署名／押印」の場所は空のまま。 -->
<table class="sign">
  <tr>
    <td>
      <span class="who">LICENSOR / 許諾者（甲）</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licensorName}}</b>{{#if licensorRep}}<br>{{licensorRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
    <td>
      <span class="who">LICENSEE / 被許諾者（乙）</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licenseeName}}</b>{{#if licenseeRep}}<br>{{licenseeRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
  </tr>
</table>
{{/if}}
</div>



</body>
</html>
$tpl$;
  vars constant jsonb := '[]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'pub_license_terms_v3';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms_v5';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('pub_license_terms_v5', '個別利用許諾条件書V5（出版・一覧形式）', base_category, 'PUBT', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'PUBT'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '212: 個別利用許諾条件書V5（出版・一覧形式）は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '212: 個別利用許諾条件書V5（出版・一覧形式）', 'sql:212')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '212: 個別利用許諾条件書V5（出版・一覧形式）を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '<!-- pub_license_terms_v5 r6 -->') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms_v5';

-- =====================================================================
-- 212 個別利用許諾条件書V5・出版 別紙形式（pub_license_terms_v5_annex）の登録
--
--   出版・ボードゲーム共通の基本契約（著作物利用許諾基本契約書V5）と、その個別条件書V5 の 3 本を一度に登録する。
--   事業別条項（出版／ボードゲーム）は基本契約に置かず、個別条件書に置く（基本契約V5 第3条第5項）。
--
--   ・V5 は新しいキーとして足す。既存のひな形（license_master・pub_master_*・individual_license_terms_v3/v4・
--     pub_license_terms_v3/_annex/_multi）と、その版で作った文書には触れない（旧基本契約の相手先は従来の条件書）。
--   ・項目（入力欄）はコードが持つ（LICENSE_MASTER_V5_VARIABLES・LICENSE_TERMS_VARIABLES・PUB_TERMS_VARIABLES）。variables は空。
--   ・採番は従来の帯を続ける（基本契約 LIC／ボードゲームの条件書 ILT／出版の条件書 PUBT）。
--   ・アプリ側は V5 のキーを扱う版（documents/license-master-v5.ts ほか）が先に出ていること。
--
--   本文は infra/v3/templates/pub_license_terms_v5_annex.html（このファイルは infra/v3/tools/make-template-sql.mjs が組み立てる）。
--   何度流しても同じ（未登録なら登録、登録済みで本文が同じなら何もしない、本文が違えば新しい版）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/212_v5_license_templates.sql
--   止めるとき: UPDATE v3.document_templates SET is_active = false WHERE template_key = 'pub_license_terms_v5_annex';
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  html constant text := $tpl$<!-- pub_license_terms_v5_annex r6 -->
<!--
  個別利用許諾条件書V5・出版（pub_license_terms_v5_annex）。多数作品用（一覧を別紙2に載せる）。著作物利用許諾基本契約書V5（license_master_v5）の個別条件書。
  本番へは infra/v3/212 が運ぶ（infra/v3/tools/make-template-sql.mjs で本文から作る）。
  体裁は individual_license_terms_v5 と同じ（head・CSS を共有）。差し込みは pubTermsPatch の値（pub_license_terms_v3 と同じ名前）。
  07 が事業別条項（出版。基本契約V5 第3条第5項）。
-->
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>個別利用許諾条件書 {{docNo}}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 12mm 14mm 11mm;
    @top-right {
      content: "ARC-LICENSE / INDIVIDUAL TERMS / PUBLISHING";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #888;
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-right {
      content: "{{docNo}}　個別利用許諾条件書（出版）";
      font: 6pt "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif; color: #777;
      vertical-align: top; padding-top: 3mm;
    }
  }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Aptos", "Yu Gothic", "Noto Sans CJK JP", "IPAGothic", sans-serif;
    font-size: 7pt; line-height: 1.5; color: #1c1c1c;
  }
  p { margin: 0 0 1.2mm; }
  .en { color: #777; font-weight: normal; letter-spacing: .04em; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .04em; }
  .title-en { font-size: 7pt; color: #777; margin: 0 0 3mm; letter-spacing: .08em; }

  /* 罫線は上の濃い線と行の下の薄い線だけ（縦線なし）。 */
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: .6mm 1.2mm; vertical-align: top; text-align: left; font-weight: normal; }
  .meta td { border-top: 1px solid #222; border-bottom: .5px solid #bebebe; }
  .meta .k, .party .k { color: #888; font-weight: bold; margin-right: 1.5em; }
  .meta b { font-weight: bold; }
  .parties { margin: 1.5mm 0 2mm; }
  .parties td { width: 50%; border-top: 1px solid #222; border-bottom: .5px solid #bebebe; padding: 1.2mm 1.5mm; }
  .party .k { display: block; margin: 0 0 .5mm; letter-spacing: .06em; }
  .party .name { font-weight: bold; }

  h2 { font-size: 9pt; margin: 3mm 0 1.2mm; padding-bottom: .6mm; border-bottom: 1px solid #222;
       break-after: avoid; page-break-after: avoid; }
  h2 .no { color: #999; font-size: 7.5pt; margin-right: 1.2em; }
  h2 .en { font-size: 6.5pt; margin-left: 1.2em; }
  h3 { font-size: 7pt; margin: 2.5mm 0 1mm; break-after: avoid; }

  .kv td { border-bottom: .5px solid #d0d0d0; }
  .kv tr:first-child td { border-top: .5px solid #555; }
  .kv td.k { width: 22mm; background: #f5f5f5; font-weight: bold; white-space: nowrap; }
  .kv tr { break-inside: avoid; page-break-inside: avoid; }

  .grid th { background: #f2f2f2; font-weight: bold; border-top: 1px solid #555; border-bottom: .5px solid #999; }
  .grid td { border-bottom: .5px solid #d0d0d0; }
  .grid td.c, .grid th.c { text-align: center; }
  .grid tr { break-inside: avoid; page-break-inside: avoid; }
  .grid thead { display: table-header-group; }
  .grid tfoot td { background: #f5f5f5; font-weight: bold; border-top: .5px solid #555; }
  .grid td.sub { color: #555; border-bottom: .5px solid #d0d0d0; }
  .grid tr.has-sub td { border-bottom: none; }
  .grid tr.memo td { background: #fafafa; color: #555; }
  .role { color: #777; display: block; }

  /* 許諾料の欄。取引モデルごとのカードを横に並べる。 */
  .cards { display: flex; gap: 2mm; margin: 1mm 0 2mm; break-inside: avoid; }
  .card { flex: 1; border-top: 1px solid #555; border-bottom: .5px solid #d0d0d0; padding: 1mm 1.5mm; }
  .card .en { display: block; color: #1c1c1c; font-weight: bold; letter-spacing: .06em; }
  .card .name { font-weight: bold; }
  .card .rate { margin-top: .6mm; }
  .card .rate b { font-size: 10pt; margin-left: .6em; }
  .card .f { color: #555; }

  .sign { margin-top: 4mm; break-inside: avoid; page-break-inside: avoid; }
  .sign td { width: 50%; border-top: 1px solid #222; padding: 1.5mm 1.5mm 2mm; }
  .sign td + td { padding-left: 5mm; }
  .sign .who { color: #888; font-weight: bold; letter-spacing: .06em; }
  .party-sign { display: flex; align-items: flex-start; gap: 3mm; min-height: 9mm; }
  .party-sign .names { flex: 1; }
  /* 印の枠。 */
  .stamp { width: 15mm; height: 15mm; border: .5px dashed #888; border-radius: 50%;
           display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 8pt; }
  /* 署名日・署名の枠。高さは 12pt 固定（CloudSign の入力欄をこの枠に合わせる）。 */
  .field { display: flex; align-items: center; gap: 2mm; margin-top: 1.2mm; }
  .field .lbl { width: 10mm; color: #555; }
  .field .box { flex: 1; height: 12pt; box-sizing: border-box; border: .5px solid #999; }
  /* 記名＋署名／押印の枠（ハイブリッド）。名称・代表者を左に刷り、右に印の丸。署名はこの枠に重ねる。 */
  .field.seal-row { align-items: stretch; }
  .sign .field .lbl { width: 14mm; }
  .field.seal-row .lbl { line-height: 1.3; align-self: center; white-space: nowrap; }
  .field .sign-box { height: 17mm; display: flex; align-items: center; justify-content: space-between; padding: 0 2mm; }
  .sign-box .pname { line-height: 1.45; }
  .sign-box .stamp { width: 13mm; height: 13mm; flex: none; }
  /* 通知先は 12pt 固定の枠（1行。長い連絡先ははみ出さず切る）。 */
  .notice td { padding-top: 0; padding-bottom: 0; vertical-align: middle; }
  .notice .fix { height: 12pt; line-height: 12pt; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* 通知先と署名欄は割らない（署名欄だけが次のページに送られないように）。 */
  .tail { break-inside: avoid; page-break-inside: avoid; }

  .annex { break-before: page; page-break-before: always; }
  /* 別紙の見出しは3つとも同じ形（本文の 01〜04 と同じ組み方で、少し大きく）。 */
  .annex h2 { font-size: 10pt; margin: 0 0 1.5mm; }
  .annex h2 .no { font-size: 8pt; }
  .annex .part + .part { margin-top: 6mm; }
  .lead { color: #555; }
  .grid th .l2 { display: block; font-weight: normal; font-size: 6.5pt; white-space: nowrap; }
</style>
</head>
<body>

<h1>個別利用許諾条件書</h1>
<p class="title-en">INDIVIDUAL LICENSE TERMS ／ 出版</p>

<table class="meta">
  <tr>
    <td><span class="k">ISSUED</span><b>{{formatDateDot signDate}}</b></td>
    <td><span class="k">NO.</span><b>{{docNo}}</b></td>
    <td>{{#if agreementNo}}<span class="k">MASTER</span><b>{{agreementNo}}</b>{{/if}}</td>
  </tr>
</table>

<table class="parties">
  <tr>
    <td class="party">
      <span class="k">LICENSOR / 許諾者（甲）</span>
      <div class="name">{{licensorName}}</div>
      <div>{{licensorAddress}}</div>
      {{#if licensorRep}}<div>{{licensorRep}}</div>{{/if}}
      {{#if licensorInvoiceNo}}<div>登録番号 {{licensorInvoiceNo}}</div>{{/if}}
    </td>
    <td class="party">
      <span class="k">LICENSEE / 被許諾者（乙）</span>
      <div class="name">{{licenseeName}}</div>
      <div>{{licenseeAddress}}</div>
      {{#if licenseeRep}}<div>{{licenseeRep}}</div>{{/if}}
      {{#if licenseeInvoiceNo}}<div>登録番号 {{licenseeInvoiceNo}}</div>{{/if}}
    </td>
  </tr>
</table>

<p>甲と乙は、両者間の{{agreementTitle}}{{#if agreementNo}}（{{agreementNo}}）{{/if}}（以下「基本契約」という。）に基づき、以下のとおり個別の利用許諾条件を定める。本条件書に定めのない事項は基本契約による。</p>
{{#if payeeTerms}}<p>本条件書は、甲が対象著作物の共同著作者（権利者の一人）として有する取り分に係る許諾条件を定める。別紙2の一覧の「料率」は甲に帰属する料率（対象著作物全体の料率に甲の取り分を乗じたもの）であり、括弧内は対象著作物全体の料率、甲の取り分は同一覧の「共同著作」欄に記載のとおりとする。甲に支払う許諾料は、甲に帰属する料率により算定する。</p>{{/if}}

<h2><span class="no">01</span>対象著作物<span class="en">LICENSED WORKS</span></h2>
<p>本条件書の対象著作物および対象出版物は、末尾の<b>別紙2「対象著作物一覧」</b>（全 {{titleCount}} 点）のとおりとする。紙媒体出版・電子書籍配信の料率および独占・非独占の別は、作品ごとに別紙2の各欄による。</p>

<h2><span class="no">02</span>許諾内容<span class="en">LICENSE SCOPE</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>対象出版物の複製・頒布（乙の子会社その他の出版社に再許諾して行わせることを含む）。独占・非独占の別は別紙2の一覧の「紙」欄による。</td></tr>
  <tr><td class="k">電子書籍配信</td><td>主要電子書店における配信（DRM付き。電子書籍の配信事業者に再許諾して行わせることを含む）。独占・非独占の別は別紙2の一覧の「電子」欄による。「電子」欄が「—」の作品は対象外とする。</td></tr>
  <tr><td class="k">再許諾</td><td>紙媒体出版・電子書籍配信の再許諾は、本条件書の許諾の範囲（地域・言語・媒体）内で行い、甲の個別の事前承諾を要しない。乙は、再許諾先を甲に通知し、再許諾先の行為について甲に対し責任を負う。</td></tr>
  <tr><td class="k">販促・広告利用</td><td>対象出版物の販売促進に必要な範囲での書影・抜粋の利用。</td></tr>
  <tr><td class="k">二次利用</td><td>{{#if translationDerivative}}翻訳（二次的著作物の作成）及び翻訳物の出版・配信、映像化・商品化その他の二次利用は、いずれも本条件書の対象外とし、甲乙の別途合意による。翻訳権その他著作権法第27条・第28条に定める権利は甲に留保され、本条件書による許諾には含まれない。{{else}}翻訳版の出版・配信、映像化・商品化その他の二次利用は本条件書の対象外とし、別途合意による。{{/if}}</td></tr>
</table>

<h2><span class="no">03</span>許諾期間・地域・言語<span class="en">TERM / TERRITORY / LANGUAGE</span></h2>
<table class="kv">
  <tr><td class="k">許諾期間</td><td>{{#if hasWorkTerms}}対象著作物ごとに別紙2の一覧の「許諾期間」の行による（自動更新した回数は同行のとおり）。{{else}}{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{/if}}</td></tr>
  {{#if termEnd}}
  <tr><td class="k">更新</td><td>{{#if autoRenew}}期間満了の{{noticeBefore}}前までにいずれの当事者からも書面による終了の通知がない場合、同一条件で{{renewPeriod}}ごとに自動更新する。{{else}}自動更新しない。延長は甲乙協議のうえ書面で定める。{{/if}}</td></tr>
  {{/if}}
  <tr><td class="k">地域</td><td>{{region}}</td></tr>
  <tr><td class="k">言語</td><td>{{language}}</td></tr>
</table>

<h2><span class="no">04</span>許諾料<span class="en">ROYALTY</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>乙又は再許諾先が発行する対象出版物の税抜定価 × 印税対象部数 × 料率（別紙2の一覧の「紙」欄）。印税対象部数は刷部数とし、見本・献本・破損分を除く。増刷時に刷部数の一部を印税対象部数から除く定め（非加算）のある作品は、一覧の備考欄の率による。初版部数その他の個別の取り決めは一覧の備考欄による。</td></tr>
  <tr><td class="k">電子書籍配信</td><td>乙又は再許諾先による配信の配信価格（税抜）× ダウンロード数 × 料率（別紙2の一覧の「電子」欄）。「電子」欄が「—」の作品には電子書籍配信の許諾料は発生しない。</td></tr>
</table>

<h2><span class="no">05</span>支払時期・方法<span class="en">PAYMENT</span></h2>
<table class="kv">
  <tr><td class="k">紙媒体出版</td><td>{{#if hasPrintMedia}}刷部数確定の都度、{{payPrint}}までに支払う。{{else}}—{{/if}}</td></tr>
  <tr><td class="k">電子書籍配信</td><td>{{#if hasDigitalMedia}}毎年1月1日〜3月31日、4月1日〜6月30日、7月1日〜9月30日及び10月1日〜12月31日を集計期間とする。乙は、各集計期間に再許諾先（配信事業者）から受領した報告に基づき、当該集計期間の最終月の翌月末日までに甲に報告し、その翌月末日までに支払う。{{else}}—{{/if}}</td></tr>
  <tr><td class="k">消費税・源泉</td><td>上記金額は税抜とし、消費税（{{taxRate}}%）を別途加算する。{{#if withholding}}乙は法令に基づき所得税及び復興特別所得税を源泉徴収し、その残額を支払う。{{else}}甲が法人であるため源泉徴収は行わない。{{/if}}</td></tr>
  <tr><td class="k">報告</td><td>乙は支払の際、作品ごとの刷部数・定価・ダウンロード数・配信価格を記載した明細を甲に提出する。再許諾先が行うものは、再許諾先ごとに、受領した報告の対象期間を併記する。</td></tr>
  <tr><td class="k">振込先</td><td>{{#if hasBank}}{{BANK_INFO}}　{{/if}}振込手数料は乙の負担とする。</td></tr>
</table>

<h2><span class="no">06</span>権利処理・著作権表示<span class="en">RIGHTS / CREDIT</span></h2>
<table class="kv">
  <tr><td class="k">第三者の知的財産</td><td>一覧の「共同著作・第三者権利」欄に記載のある作品について、当該第三者の権利処理は甲が行い、甲は当該第三者に対する対価の支払について乙に責任が及ばないことを保証する。</td></tr>
  <tr><td class="k">著作権表示</td><td>乙は対象出版物の奥付その他甲乙が合意した位置に、一覧の「著作権表示」欄の表示を行う。表示位置に個別の指定がある場合は備考欄による。{{#if translationDerivative}}別途合意により翻訳物を出版するときは、原著作物の題号及び原著作者名を、翻訳物であることが分かる形で表示する。{{/if}}</td></tr>
</table>

<h2><span class="no">07</span>出版に関する定め<span class="en">PUBLISHING TERMS</span></h2>
<p>本条は、基本契約第3条第5項に定める事業別条項（出版）とし、変更するときは別紙1「特記事項」に定める。</p>
<table class="kv">
  <tr><td class="k">紙媒体の権利の形</td><td>別紙2の一覧の「紙」欄が非独占の作品は非独占の利用許諾、独占の作品は独占的利用許諾とする。ただし、同一覧の備考欄または別紙1「特記事項」に「出版権設定」とある作品は、甲は乙に著作権法第80条第1項第1号の出版権を設定する。</td></tr>
  <tr><td class="k">出版権の内容</td><td>出版権を設定した作品について、出版権の存続期間は当該作品の許諾期間とする。著作権法第81条の出版の時期および継続出版の義務は、同条ただし書の別段の定めとして、基本契約第10条（販売）および第11条（販売終了）による。乙は、改めて複製しようとするときは、その都度あらかじめ甲に通知する（同法第82条第2項）。甲は、乙が同法第80条第3項により第三者に複製または公衆送信を許諾することを承諾する。甲は出版権の設定の登録に協力し、出版権が消滅したときは乙が抹消の登録に協力する。</td></tr>
  <tr><td class="k">電子書籍・貸与</td><td>電子書籍は、別紙2の一覧の「電子」欄に独占と明示した作品を除き非独占の利用許諾とし、乙は適切な技術的保護手段を施す。乙は、紙媒体出版物の貸与および図書館等による電子書籍の貸出について、管理団体を通じて許諾し、使用料を受領することができる。甲への配分は別紙1「特記事項」に定め、定めがないときは乙が受領した使用料に当該作品の紙・電子の料率を乗じた額とする。</td></tr>
  <tr><td class="k">原稿の引渡し・校正</td><td>原稿を新たに引き渡す作品について、甲は、甲乙が別に定める期日までに完全な原稿（乙が出版に適すると合理的に認めたものをいう。）を乙に引き渡す。校正は甲乙が協力して行い、甲は乙に校正を委ねることができる。</td></tr>
  <tr><td class="k">改訂版・新版</td><td>誤植・誤記の訂正、組版・装丁・判型の変更その他の軽微な修正は本条件書による。本文の実質的な変更、書名の変更、増補、改訂版、新装版その他の新たな版は、甲の承諾を得て、新たな条件書による。甲が改訂版等を第三者から出版しようとするときは、乙に優先交渉の機会を与える。</td></tr>
</table>

<h2><span class="no">08</span>旧合意との関係<span class="en">PRIOR AGREEMENTS</span></h2>
<p>対象著作物に関する甲乙間の従前の合意（覚書・電子メールその他形式を問わない）の扱いは、基本契約第27条により別紙1「特記事項」に定める。定めのない従前の合意は存続し、本条件書と抵触する部分は本条件書が優先する。本条件書と基本契約が矛盾する場合は本条件書が優先する。</p>

<div class="tail">
<h2><span class="no">09</span>通知先<span class="en">NOTICES</span></h2>
<table class="kv notice">
  <tr><td class="k"><div class="fix">甲</div></td><td><div class="fix">{{licensorContact}}</div></td></tr>
  <tr><td class="k"><div class="fix">乙</div></td><td><div class="fix">{{licenseeContact}}</div></td></tr>
</table>

{{#if showSignature}}
<!-- 署名欄（署名・押印のどちらでもよい）。記名（名称・代表者）は自動で刷る。署名日の枠と「署名／押印」の場所は空のまま。 -->
<table class="sign">
  <tr>
    <td>
      <span class="who">LICENSOR / 許諾者（甲）</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licensorName}}</b>{{#if licensorRep}}<br>{{licensorRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
    <td>
      <span class="who">LICENSEE / 被許諾者（乙）</span>
      <div class="field"><span class="lbl">署名日</span><span class="box"></span></div>
      <div class="field seal-row"><span class="lbl">記名<br>署名／押印</span><span class="box sign-box"><span class="pname"><b>{{licenseeName}}</b>{{#if licenseeRep}}<br>{{licenseeRep}}{{/if}}</span><span class="stamp">印</span></span></div>
    </td>
  </tr>
</table>
{{/if}}
</div>

<!-- 別紙。本文（署名欄まで）の後ろに改ページして付ける。 -->
<div class="annex">
<div class="part">
<h2><span class="no">別紙1</span>特記事項<span class="en">SPECIAL TERMS</span></h2>
{{#if specialNotes}}
<p class="lead">本条件書の本文に定める条件に加え、次の特記事項を適用する。</p>
<p>{{specialNotes}}</p>
{{else}}
<p>なし</p>
{{/if}}
</div>
<div class="part">
<h2><span class="no">別紙2</span>対象著作物一覧<span class="en">LICENSED WORKS REGISTER</span></h2>
<p class="lead">一覧の1行が作品1点（備考がある作品は同じNo.の下に続ける）。紙・電子の料率と独占区分は、それぞれの媒体について甲乙間で合意した条件を示す。「—」はその媒体の許諾が無いことを示す。許諾期間は作品ごとに同じNo.の下の行に示し、「更新 n 回」は許諾開始日（刊行日）から本条件書の締結日までに自動更新した回数を示す（第3条）。自動更新しない作品は「更新なし」、更新を止めた作品は「以後更新しない」と付す。</p>
<table class="grid">
  <thead>
    <tr>
      <th class="c" style="width:7mm">No.</th>
      <th>原著作物名／対象出版物名</th>
      <th style="width:30mm">著作権表示</th>
      <th style="width:26mm">共同著作・第三者権利</th>
      <th class="c" style="width:20mm">紙<span class="l2">料率／独占区分</span></th>
      <th class="c" style="width:20mm">電子<span class="l2">料率／独占区分</span></th>
    </tr>
  </thead>
  {{#each titles}}
  <tbody>
    <tr{{#if hasNoteRow}} class="has-sub"{{/if}}>
      <td class="c">{{no}}</td>
      <td><b>{{title}}</b>{{#if edition}}<span class="role">{{edition}}</span>{{/if}}</td>
      <td>{{copyright}}</td>
      <td>{{thirdParty}}</td>
      <td class="c">{{printRate}}{{#if hasPrint}}／{{printExclusivity}}{{/if}}</td>
      <td class="c">{{digitalRate}}{{#if hasDigital}}／{{digitalExclusivity}}{{/if}}</td>
    </tr>
    {{#if hasNoteRow}}
    <tr>
      <td class="sub"></td>
      <td class="sub" colspan="5">{{#if hasTerm}}許諾期間　{{term}}{{/if}}{{#if hasShares}}　／　共同著作　{{coAuthors}}{{#if payeeShare}}（{{payeeShare}}）{{/if}}{{/if}}{{#if note}}　／　備考　{{note}}{{/if}}</td>
    </tr>
    {{/if}}
  </tbody>
  {{/each}}
  {{#unless titles.length}}
  <tbody><tr><td></td><td colspan="5">（対象著作物がありません。条件明細を選んでください）</td></tr></tbody>
  {{/unless}}
</table>
</div>
</div>

</body>
</html>
$tpl$;
  vars constant jsonb := '[]'::jsonb;
  tpl_id bigint;
  cur text;
  base_category text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT category INTO base_category FROM v3.document_templates WHERE template_key = 'pub_license_terms_v3_annex';

  SELECT t.id, v.html_source INTO tpl_id, cur
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms_v5_annex';
  IF tpl_id IS NULL THEN
    INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active)
    VALUES ('pub_license_terms_v5_annex', '個別利用許諾条件書V5（出版・別紙形式）', base_category, 'PUBT', true)
    RETURNING id INTO tpl_id;
  ELSE
    UPDATE v3.document_templates SET number_prefix = COALESCE(number_prefix, 'PUBT'), is_active = true WHERE id = tpl_id;
  END IF;
  IF cur IS NOT DISTINCT FROM html THEN
    RAISE NOTICE '212: 個別利用許諾条件書V5（出版・別紙形式）は登録済み（本文も同じ）。何もしません';
    RETURN;
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars, '212: 個別利用許諾条件書V5（出版・別紙形式）', 'sql:212')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '212: 個別利用許諾条件書V5（出版・別紙形式）を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, t.label AS 名前, t.number_prefix AS 採番, t.is_active AS 有効,
       v.version_no AS 版, length(v.html_source) AS 本文の長さ,
       (strpos(v.html_source, '<!-- pub_license_terms_v5_annex r6 -->') > 0) AS 目印
  FROM v3.document_templates t
  LEFT JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms_v5_annex';
