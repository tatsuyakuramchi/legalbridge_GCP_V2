-- =====================================================================
-- LegalBridge V3 スキーマの後追い変更
--
--   001_schema.sql は CREATE TABLE IF NOT EXISTS で書いてあるので、
--   既に作られた表には流し直しても効かない。制約や列の変更はここに積む。
--   何度流しても同じ結果になるように書くこと。
--
--   実行: psql "$ADMIN_DSN" -f infra/v3/004_amend.sql
--   順番: 003_grants.sql の後、005_preflight.sql の前。
--   新しい表を足したときは 003_grants.sql も流し直すこと。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- A-001 メールのスレッドを案件に紐づけられるようにする
--
--   受信したメールから案件を起こしたとき、同じスレッドの続きが届いても
--   案件を二重に立てないために、スレッドIDを控える先が要る。
--   制約名は自動採番なので、名前を決め打ちにせず pg_constraint から引く。
-- ---------------------------------------------------------------------
DO $amend_matter_links$
DECLARE
  con   text;
  wanted constant text[] := ARRAY[
    'backlog_issue', 'document', 'agreement', 'condition', 'payment',
    'slack_thread', 'email_thread'];
BEGIN
  -- 既に email_thread を通す制約なら何もしない。
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%email_thread%'
  ) THEN
    RAISE NOTICE 'A-001: 適用済み';
  ELSE
    SELECT c.conname INTO con
      FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%target_type%'
     LIMIT 1;
    IF con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE v3.matter_links DROP CONSTRAINT %I', con);
    END IF;
    EXECUTE format(
      'ALTER TABLE v3.matter_links ADD CONSTRAINT matter_links_target_type_check
         CHECK (target_type = ANY (%L::text[]))', wanted);
    RAISE NOTICE 'A-001: matter_links.target_type に email_thread を足した';
  END IF;
END
$amend_matter_links$;

-- ---------------------------------------------------------------------
-- A-002 予定明細に名前を持たせる
--
--   毎月28万円の1年契約は12行並ぶ。どの行が何月分かを人が読めるように
--   名前を持たせる（「2026年4月分」「第1回 着手金」）。期日から機械的に
--   導ける場合もあるが、着手金・中間金のような区切りは導けない。
-- ---------------------------------------------------------------------
ALTER TABLE v3.condition_schedules ADD COLUMN IF NOT EXISTS label text;

COMMENT ON COLUMN v3.condition_schedules.label IS
  '明細行の名前。「2026年4月分」「第1回 着手金」など。空なら期日から表示を作る。';


-- ---------------------------------------------------------------------
-- A-003 案件に「進め方」を持たせる
--
--   取引モデル（ライセンス／業務委託／文書作成）だけでは、実際に何をする
--   のかが決まらない。相手方の文書をレビューするのか、自社で一から書くの
--   か、ひな形から起こすのかで、最初にやることも要る材料も違う。
--
--     counterparty_review … 他社文書レビュー型（相手方の文書を受け取る）
--     own_draft           … 自社ドラフト型（一から書く）
--     own_template        … 自社テンプレートドラフト型（ひな形から起こす）
--
--   既存の案件は空のまま。決まっていないものを勝手に決めない。
-- ---------------------------------------------------------------------
ALTER TABLE v3.matters ADD COLUMN IF NOT EXISTS document_style text;

DO $amend_doc_style$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'v3.matters'::regclass
       AND conname = 'matters_document_style_check'
  ) THEN
    ALTER TABLE v3.matters ADD CONSTRAINT matters_document_style_check
      CHECK (document_style IS NULL OR document_style IN
             ('counterparty_review', 'own_draft', 'own_template'));
    RAISE NOTICE 'A-003: matters.document_style を足した';
  ELSE
    RAISE NOTICE 'A-003: 適用済み';
  END IF;
END
$amend_doc_style$;

COMMENT ON COLUMN v3.matters.document_style IS
  '進め方。counterparty_review=他社文書レビュー / own_draft=自社ドラフト / own_template=自社テンプレート。';


-- ---------------------------------------------------------------------
-- A-004: 契約変更の「いつから適用か」
--
-- 改訂すると旧版がその瞬間に死んで新版が生きる作りだったので、
-- 「2027-04-01 から料率が変わる」を記録できなかった。回避策は
-- 「その日まで改訂しないで覚えておく」しか無く、記録システムとして敗けている。
--
-- 契約期間（term_start / term_end）とは別の列にする。旧版の term_end を
-- 切ると、契約は 2029 年まで続くのに満了アラートが 2027 年に鳴り、
-- 権利包絡チェックも「許諾は 2027 年まで」と誤認する。
--
-- 未来の改訂は status='scheduled' で置く。active のまま2行あると、
-- conditions を status='active' で絞っている8箇所が同じ条件を二重に数える。
-- scheduled ならその8箇所を1行も触らずに済む。
-- ---------------------------------------------------------------------

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS series_id bigint;

COMMENT ON COLUMN v3.conditions.effective_from IS
  'この版が適用され始める日。契約期間（term_start）とは別。適用終了日は持たない（系列の次版の前日として導ける）。';
COMMENT ON COLUMN v3.conditions.series_id IS
  '改訂の系列。初版の id を全版が持つ。AGの消化累計も予定明細もこの単位で数える。';

-- status に 'scheduled' を足す。列内 CHECK は自動命名なので、名前を引いて張り替える。
DO $amend_cond_status$
DECLARE
  old_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'v3.conditions'::regclass
                AND conname = 'conditions_status_chk') THEN
    RAISE NOTICE 'A-004: status の CHECK は適用済み';
  ELSE
    -- 先に新しい制約を張ってから古いものを外す。順番を逆にすると、
    -- その一瞬だけ status が無防備になる。
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_status_chk
      CHECK (status IN ('draft', 'active', 'scheduled', 'superseded', 'void'));

    SELECT c.conname INTO old_name
      FROM pg_constraint c
     WHERE c.conrelid = 'v3.conditions'::regclass
       AND c.contype = 'c'
       AND c.conname <> 'conditions_status_chk'
       AND pg_get_constraintdef(c.oid) LIKE '%status%'
       AND pg_get_constraintdef(c.oid) LIKE '%superseded%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%superseded_by_id%'
     LIMIT 1;
    IF old_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE v3.conditions DROP CONSTRAINT %I', old_name);
      RAISE NOTICE 'A-004: status の CHECK を張り替えた（旧 %）', old_name;
    ELSE
      RAISE NOTICE 'A-004: status の新しい CHECK を足した（旧制約は見つからず）';
    END IF;
  END IF;
END
$amend_cond_status$;

-- 予定の版は適用日が無いと意味を成さない。
DO $amend_cond_sched$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass
                    AND conname = 'conditions_scheduled_needs_date_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_scheduled_needs_date_chk
      CHECK (status <> 'scheduled' OR effective_from IS NOT NULL);
    RAISE NOTICE 'A-004: 予定の版に適用日を必須にした';
  END IF;
END
$amend_cond_sched$;

-- 既存行の埋め戻し。適用開始日は契約の開始日と同じとみなす。
UPDATE v3.conditions SET effective_from = term_start
 WHERE effective_from IS NULL AND term_start IS NOT NULL;

-- 系列。誰からも superseded_by_id で指されていない行が初版で、そこから前へ辿る。
WITH RECURSIVE chain(id, series_id) AS (
  SELECT c.id, c.id
    FROM v3.conditions c
   WHERE NOT EXISTS (SELECT 1 FROM v3.conditions p WHERE p.superseded_by_id = c.id)
  UNION ALL
  SELECT c.superseded_by_id, ch.series_id
    FROM v3.conditions c
    JOIN chain ch ON c.id = ch.id
   WHERE c.superseded_by_id IS NOT NULL
)
UPDATE v3.conditions t SET series_id = ch.series_id
  FROM chain ch
 WHERE t.id = ch.id AND t.series_id IS DISTINCT FROM ch.series_id;

-- 以後に入る行にも必ず系列を持たせる。アプリだけでなく移行スクリプトや
-- 手で入れた行にも効かせたいので、書き手ごとの取りこぼしが無いトリガにする。
CREATE OR REPLACE FUNCTION v3.set_condition_series() RETURNS trigger
LANGUAGE plpgsql AS $set_series$
BEGIN
  IF NEW.series_id IS NULL THEN NEW.series_id := NEW.id; END IF;
  RETURN NEW;
END
$set_series$;

DROP TRIGGER IF EXISTS conditions_series_bi ON v3.conditions;
CREATE TRIGGER conditions_series_bi BEFORE INSERT ON v3.conditions
  FOR EACH ROW EXECUTE FUNCTION v3.set_condition_series();

CREATE INDEX IF NOT EXISTS conditions_series_idx
  ON v3.conditions (series_id, effective_from);


-- ---------------------------------------------------------------------
-- A-005: 文書の採番プレフィックスを埋め戻す
--
-- V1/V2 はプレフィックスをコード側の表（DOCUMENT_PREFIXES）に持ち、
-- document_templates.document_prefix は「上書きしたいときだけ入れる列」
-- として使っていた。040 の移行はその列だけを写したので、実際に値が
-- 入っていた5件を除く21件がプレフィックス無しで入った。
--
-- V3 の発行はプレフィックスをDBから引き、無ければ
-- 「採番プレフィックスが設定されていません」で止まる。つまり
-- 発注書も検収書も利用許諾料計算書も、本番では1枚も出せない状態だった。
--
-- V3 はこれをDBの側の事実として持つ（テンプレートを足すのにコード変更が
-- 要る状態にしない）。値は V1/V2 が実際に使っていたものと同じにする。
-- 本番には ARC-PO-2026-0115 や ARC-INS-2026-0031 が実在するので、
-- 違う記号を振ると同じ書類の番号が途中で変わる。
-- ---------------------------------------------------------------------

UPDATE v3.document_templates t SET number_prefix = m.prefix
  FROM (VALUES
    ('purchase_order',                        'PO'),
    ('intl_purchase_order',                   'IPO'),
    ('inspection_certificate',                'INS'),
    ('license_master',                        'LIC'),
    ('individual_license_terms',              'ILT'),
    ('individual_license_terms_v3',           'ILT'),
    ('royalty_statement',                     'ROY'),
    ('service_master',                        'SVC'),
    ('pub_master_individual',                 'PUB'),
    ('pub_master_corporate',                  'PUB'),
    ('pub_license_terms',                     'PUBT'),
    ('pub_additional_terms',                  'PUBA'),
    ('sales_master_buyer',                    'SAL'),
    ('sales_master_credit',                   'SAL'),
    ('sales_master_standard',                 'SAL'),
    ('maintenance_spec',                      'MNT'),
    ('legal_response',                        'LG'),
    -- 汎用法務文書。V1 でも採番記号が無く、一度も発行できなかった。
    -- 法務回答書と同じ連番に載せる。
    ('legal_freeform',                        'LG'),
    ('notice_consent_personal_info_freelance','PR'),
    ('nda',                                   'NDA'),
    ('payment_notice',                        'PAY'),
    ('invoice',                               'INV')
  ) AS m(template_key, prefix)
 WHERE t.template_key = m.template_key
   AND COALESCE(btrim(t.number_prefix), '') = '';


-- ---------------------------------------------------------------------
-- A-006: 予定明細に支払期日を足す
--
-- due_on は「その回が発生する予定日」として作ってあり（実績にするときの
-- 発生日の既定値になる）、支払う日ではなかった。ところが列名も画面の見出しも
-- 「期日」で、期限一覧にも「期日」として並ぶ。並ぶ他のもの（支払・契約満了・
-- タスク）は全部「その日までにやること」なので、支払期日と読めてしまう。
--
-- 意味の違う2つを1列に載せていたのが原因なので、列を分ける。
-- 支払期日は payment_terms（「検収月の翌月末払い」など）から導く。
-- ---------------------------------------------------------------------

ALTER TABLE v3.condition_schedules ADD COLUMN IF NOT EXISTS pay_on date;

COMMENT ON COLUMN v3.condition_schedules.due_on IS
  'その回が発生する予定日。実績にするときの発生日の既定値になる。支払期日は pay_on。';
COMMENT ON COLUMN v3.condition_schedules.pay_on IS
  '支払期日。期限一覧にはこちらを出す（無ければ due_on）。';

-- 期限一覧は支払期日のほうを出す。
CREATE OR REPLACE VIEW v3.v_deadlines AS
SELECT 'matter'::text AS source, m.id AS ref_id, m.matter_no AS ref_no,
       m.title, m.due_on AS due_on, m.status
  FROM v3.matters m
 WHERE m.due_on IS NOT NULL AND m.status NOT IN ('done', 'canceled')
UNION ALL
SELECT 'agreement', a.id, a.agreement_no, a.title,
       CASE WHEN a.auto_renewal AND a.renewal_notice_months IS NOT NULL
            THEN a.expires_on - (a.renewal_notice_months || ' months')::interval
            ELSE a.expires_on END::date,
       a.status
  FROM v3.agreements a
 WHERE a.expires_on IS NOT NULL AND a.status = 'executed'
UNION ALL
SELECT 'payment', p.id, p.payment_no,
       COALESCE(pt.name, '') || ' への支払', p.due_on, p.status
  FROM v3.payments p
  LEFT JOIN v3.parties pt ON pt.id = p.party_id
 WHERE p.due_on IS NOT NULL AND p.status IN ('planned', 'approved')
UNION ALL
SELECT 'schedule', s.id, c.condition_no, c.name, COALESCE(s.pay_on, s.due_on), c.status
  FROM v3.condition_schedules s
  JOIN v3.conditions c ON c.id = s.condition_id
 WHERE COALESCE(s.pay_on, s.due_on) IS NOT NULL AND c.status = 'active'
UNION ALL
SELECT 'task', t.id, m.matter_no, t.title,
       (t.due_at AT TIME ZONE 'Asia/Tokyo')::date, t.status
  FROM v3.tasks t
  JOIN v3.matters m ON m.id = t.matter_id
 WHERE t.due_at IS NOT NULL AND t.status <> 'done';


-- ---------------------------------------------------------------------
-- A-007: 口座情報を読めるようにする
--
-- 支払通知書・請求書は振込先が無いと書類として成立しない。読み取りだけ
-- 開ける。書き込みは閉じたまま（口座の改ざんを防ぐ）。
--
-- 返す経路は requireRole("admin","legal") の下にだけ置いてある。ただし
-- AUTH_MODE=disabled のあいだは入れた人が全員 admin になるので、
-- 「アプリに入れる人＝口座を見られる人」であることを承知して運用する。
-- 閉じ直すときは REVOKE SELECT ON v3.party_bank_accounts。
-- ---------------------------------------------------------------------

GRANT SELECT ON v3.party_bank_accounts TO legalbridge_v3_runtime;

-- ---------------------------------------------------------------------
-- A-008: 書類に載る連絡先を持たせる（住所・電話）
--
-- V1 の vendors は住所と電話を持っていて、契約書・発注書・検収書の本文が
-- それを差していた（field_schema の dbField: vendor.address ほか）。V3 の
-- parties にその列が無かったので、住所欄のある書類は必ず手入力になっていた。
-- staff.phone も同じ理由で足す（担当者連絡先を出す本文がある）。
--
-- 値は移行元から埋め戻す。public は読むだけ。
-- ---------------------------------------------------------------------

ALTER TABLE v3.parties ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE v3.parties ADD COLUMN IF NOT EXISTS phone   text;
ALTER TABLE v3.parties ADD COLUMN IF NOT EXISTS email   text;
ALTER TABLE v3.staff   ADD COLUMN IF NOT EXISTS phone   text;

DO $a008$
BEGIN
  IF to_regclass('public.vendors') IS NOT NULL THEN
    UPDATE v3.parties p
       SET address = COALESCE(p.address, NULLIF(v.address, '')),
           phone   = COALESCE(p.phone,   NULLIF(v.phone, '')),
           email   = COALESCE(p.email,   NULLIF(v.email, ''))
      FROM public.vendors v
     WHERE v.id = p.legacy_id
       AND (p.address IS NULL OR p.phone IS NULL OR p.email IS NULL);
  END IF;
  IF to_regclass('public.staff') IS NOT NULL THEN
    UPDATE v3.staff s
       SET phone = NULLIF(ps.phone, '')
      FROM public.staff ps
     WHERE ps.id = s.legacy_id AND s.phone IS NULL;
  END IF;
END
$a008$;

-- ---------------------------------------------------------------------
-- A-009: 自社プロファイルを移す
--
-- 発注書は PARTY_A_NAME / PARTY_A_ADDRESS / PARTY_A_REP を必須にしていて、
-- 計算書は licensee / COMPANY_ADDRESS / COMPANY_TEL / COMPANY_INVOICE_NO を
-- 差している。どれも V1 の app_settings（COMPANY_* キー）から来ていたが、
-- V3 へは移していなかったので全部空欄だった。
--
-- V3 は settings.value に1件のJSONで持つ（アプリはこの形で読む）。
-- キー名は V1 の CompanyProfile と同じにする。
-- ---------------------------------------------------------------------

DO $a009$
DECLARE
  v jsonb := '{}'::jsonb;
  pair record;
BEGIN
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    FOR pair IN
      SELECT k.field, s.value
        FROM (VALUES
          ('name',       'COMPANY_NAME'),
          ('nameKana',   'COMPANY_NAME_KANA'),
          ('postalCode', 'COMPANY_POSTAL_CODE'),
          ('address',    'COMPANY_ADDRESS'),
          ('tel',        'COMPANY_TEL'),
          ('fax',        'COMPANY_FAX'),
          ('rep',        'COMPANY_REPRESENTATIVE'),
          ('invoiceNo',  'COMPANY_INVOICE_NO'),
          ('bankInfo',   'COMPANY_BANK_INFO'),
          ('sealNote',   'COMPANY_SEAL_NOTE')
        ) AS k(field, key)
        JOIN public.app_settings s ON s.key = k.key
    LOOP
      IF NULLIF(btrim(pair.value #>> '{}'), '') IS NOT NULL THEN
        v := v || jsonb_build_object(pair.field, btrim(pair.value #>> '{}'));
      END IF;
    END LOOP;
  END IF;

  -- V1 のハードコード既定（master-data/repository.ts 旧 companyProfile()）。
  -- 設定が未整備でも自社名と住所と代表者は書類に載る。
  v := jsonb_build_object(
         'name', '株式会社アークライト',
         'address', '東京都千代田区神田小川町1-2 風雲堂ビル2階',
         'rep', '代表取締役　青柳 昌行'
       ) || v;

  INSERT INTO v3.settings (key, value, updated_by)
  VALUES ('company_profile', v, 'A-009')
  ON CONFLICT (key) DO UPDATE
    -- すでに入っているものが正。足りないキーだけ埋める。
    SET value = EXCLUDED.value || v3.settings.value, updated_at = now();
END
$a009$;

-- ---------------------------------------------------------------------
-- A-010: 中身の無い口座の行を片づける
--
-- V1 のフォームは口座種別に「普通」を初期値で入れていた。銀行名も口座番号も
-- 名義も入れずに保存された取引先が、口座種別だけを持つ行として移ってきた
-- （移行直後で98件）。支払える情報が1つも無いので口座ではない。
--
-- 残しておくと、その取引先の検収書・支払通知書に「振込先: 普通」とだけ
-- 出る。空欄より悪い（振込先があるように見える）。
--
-- 消すのは「銀行名・支店名・口座番号・名義がすべて空」の行だけ。
-- 1つでも入っていれば残す（海外の銀行名だけ、のような行は情報として有効）。
-- ---------------------------------------------------------------------

DO $a010$
DECLARE
  removed int;
BEGIN
  WITH gone AS (
    DELETE FROM v3.party_bank_accounts
     WHERE bank_name IS NULL AND branch_name IS NULL
       AND account_number IS NULL AND account_holder_kana IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM gone;
  IF removed > 0 THEN
    RAISE NOTICE 'A-010: 中身の無い口座を % 件消した', removed;
  ELSE
    RAISE NOTICE 'A-010: 消すものは無い';
  END IF;
END
$a010$;

-- ---------------------------------------------------------------------
-- A-011: 訂正の理由を文書に持たせる
--
-- 差し替えは「元を無効にする」→「新しく作る」の2手でやるものではなく、
-- 訂正版を発行した瞬間に元が退く1手であるべき。その理由は版と版の関係に
-- 属するので、supersedes_id を持つ側（新しい版）に置く。
--
-- これまで理由は audit_events にしか残らず、版の履歴に出せなかった。
-- ---------------------------------------------------------------------

ALTER TABLE v3.documents ADD COLUMN IF NOT EXISTS supersede_reason text;
COMMENT ON COLUMN v3.documents.supersede_reason IS
  'なぜ前の版を差し替えたか。supersedes_id と対で持つ。';


-- ---------------------------------------------------------------------
-- A-012: 欠けた振込先を不整合として上げる
--
-- A-010 で「中身が1つも無い口座」は消したが、一部だけ入っている口座は
-- 残した（海外の銀行名だけ、のような行は情報として有効なので）。
-- ところが検収書・支払通知書は BANK_NAME / BRANCH_NAME / ACCOUNT_NUMBER /
-- ACCOUNT_HOLDER_KANA をそのまま差し込むので、欠けたぶんは空欄で出る。
-- 実際「口座番号と名義だけ」の振込先が載った書類が発行された。
--
-- 気づく先が無いのが問題なので、運用＞データ品質に出す。V1 の vendors から
-- そのまま移ったもので、V1 でも同じ欠け方をしていた（移行での欠落ではない）。
--
-- 口座種別は「普通」を書かない運用もあるので必須にしない。
-- 銀行名・支店名・口座番号・名義の4つが揃って初めて振り込める。
-- ---------------------------------------------------------------------

INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'PARTY_BANK_INCOMPLETE', 'party', b.party_id,
       -- 口座番号か名義が無いものは振り込めない。銀行名だけの欠けより重い。
       CASE WHEN b.account_number IS NULL OR b.account_holder_kana IS NULL
            THEN 'high' ELSE 'medium' END,
       jsonb_build_object(
         'partyName', p.name,
         'missing', (SELECT jsonb_agg(x) FROM unnest(ARRAY[
            CASE WHEN b.bank_name           IS NULL THEN '銀行名'   END,
            CASE WHEN b.branch_name         IS NULL THEN '支店名'   END,
            CASE WHEN b.account_number      IS NULL THEN '口座番号' END,
            CASE WHEN b.account_holder_kana IS NULL THEN '名義'     END
         ]) AS x WHERE x IS NOT NULL))
  FROM v3.party_bank_accounts b
  JOIN v3.parties p ON p.id = b.party_id
 WHERE b.bank_name IS NULL OR b.branch_name IS NULL
    OR b.account_number IS NULL OR b.account_holder_kana IS NULL
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  severity = EXCLUDED.severity, detail = EXCLUDED.detail, detected_at = now();

-- 埋まったものは閉じる。人が直したあとも開いたままだと、一覧が信用されなくなる。
UPDATE v3.data_quality_issues q
   SET status = 'resolved', resolved_at = now()
 WHERE q.rule_code = 'PARTY_BANK_INCOMPLETE' AND q.status = 'open'
   AND NOT EXISTS (
     SELECT 1 FROM v3.party_bank_accounts b
      WHERE b.party_id = q.target_id
        AND (b.bank_name IS NULL OR b.branch_name IS NULL
             OR b.account_number IS NULL OR b.account_holder_kana IS NULL));


-- ---------------------------------------------------------------------
-- A-013: 取引先の口座を V3 から直せるようにする
--
-- 移行してきた 2498 件の口座のうち 460 件が口座番号か名義を欠いていて、
-- そのままでは振り込めない。うち 383 件は名義（カナ）だけが無い。
-- 突き合わせた結果、V1 の元データが同じ形で（欠けの数が V1 と完全に一致）、
-- 移行の取りこぼしではなかった。直す先がどこかに要る。
--
-- 開けるのは INSERT と UPDATE だけ。DELETE は与えない（行ごと消す操作は
-- 用意していない。使わない口座は各欄を空にする）。
-- 触れる経路は取引先の画面1つだけで、requireRole("admin","legal") の下に置く。
-- 変更は audit_events に残す。
--
-- 003_grants.sql も同じ内容に直してある。新規に立てるときはそちらが効く。
-- ここは既に立っているデータベース用。
-- ---------------------------------------------------------------------

GRANT INSERT, UPDATE ON v3.party_bank_accounts TO legalbridge_v3_runtime;

-- ---------------------------------------------------------------------
-- A-014: 空白だけの値を NULL に揃える
--
-- 検収書の【ご連絡先】が空欄になる件を追ったとき、staff.email が
-- 空白だけの文字列だった。アプリは str() が btrim して判定するので
-- 「空」として扱い、書類には何も出ない。ところが SQL で
-- `email IS NULL` を探しても引っかからないので、DB を見た人は
-- 「入っているのに出ない」と読んでしまう。
--
-- 移行は NULLIF(x, '') で入れたが、これは空文字だけを NULL にする。
-- V1 側に ' ' のような空白入りが残っていると素通りする。
--
-- 揃えるのは、書類に差し込む項目だけ。意味は変わらない
-- （アプリはどちらも「空」として扱う）。
-- ---------------------------------------------------------------------

UPDATE v3.staff SET email = NULL       WHERE email IS NOT NULL      AND btrim(email) = '';
UPDATE v3.staff SET department = NULL  WHERE department IS NOT NULL AND btrim(department) = '';
UPDATE v3.staff SET phone = NULL       WHERE phone IS NOT NULL      AND btrim(phone) = '';

UPDATE v3.parties SET address = NULL WHERE address IS NOT NULL AND btrim(address) = '';
UPDATE v3.parties SET phone   = NULL WHERE phone   IS NOT NULL AND btrim(phone) = '';
UPDATE v3.parties SET email   = NULL WHERE email   IS NOT NULL AND btrim(email) = '';

UPDATE v3.party_contacts SET name = NULL  WHERE name IS NOT NULL  AND btrim(name) = '';
UPDATE v3.party_contacts SET email = NULL WHERE email IS NOT NULL AND btrim(email) = '';
UPDATE v3.party_contacts SET phone = NULL WHERE phone IS NOT NULL AND btrim(phone) = '';

UPDATE v3.party_bank_accounts SET bank_name = NULL
 WHERE bank_name IS NOT NULL AND btrim(bank_name) = '';
UPDATE v3.party_bank_accounts SET branch_name = NULL
 WHERE branch_name IS NOT NULL AND btrim(branch_name) = '';
UPDATE v3.party_bank_accounts SET account_type = NULL
 WHERE account_type IS NOT NULL AND btrim(account_type) = '';
UPDATE v3.party_bank_accounts SET account_number = NULL
 WHERE account_number IS NOT NULL AND btrim(account_number) = '';
UPDATE v3.party_bank_accounts SET account_holder_kana = NULL
 WHERE account_holder_kana IS NOT NULL AND btrim(account_holder_kana) = '';

-- ---------------------------------------------------------------------
-- A-015: 案件のやり取りを証憑として残す
--
-- 案件では担当者との Slack のやり取り、メールの送受信、ファイルの受け渡しを
-- 記録したい。これまで送信は audit_events に、受信メールは matter_links の
-- snapshot に、Slack の受信はどこにも残っていなかった。
--
-- 1本の表にまとめる。本文と生の payload（evidence）をそのまま持ち、
-- 追記だけ（UPDATE / DELETE は与えない）。外部側の ID（Slack の ts、
-- Gmail の message id、Drive の file id）で重複を弾く。
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.matter_communications (
  id           bigserial PRIMARY KEY,
  matter_id    bigint NOT NULL REFERENCES v3.matters(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('slack', 'email', 'cloudsign', 'drive', 'note')),
  -- in=受け取った / out=送った / note=記録だけ
  direction    text NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- 送った人（out）／差出人（in）／書いた人（note）
  actor        text NOT NULL,
  -- 相手。Slack のチャンネル・ユーザー、メールの宛先や差出人
  counterpart  text,
  subject      text,
  body         text,
  -- 外部側の ID。Slack の ts、Gmail の message id、Drive の file id
  external_ref text,
  external_url text,
  document_id  bigint REFERENCES v3.documents(id),
  -- 証憑。webhook の生の payload、送信のレシート、添付の一覧
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE v3.matter_communications IS
  '案件のやり取り（Slack・メール・CloudSign・Drive・メモ）。追記専用。evidence に生の記録を持つ。';
CREATE INDEX IF NOT EXISTS matter_communications_matter_idx
  ON v3.matter_communications (matter_id, occurred_at DESC);
-- 同じ Slack メッセージ・同じメールを二度記録しない。
CREATE UNIQUE INDEX IF NOT EXISTS matter_communications_ref_uq
  ON v3.matter_communications (channel, external_ref) WHERE external_ref IS NOT NULL;

-- 追記だけ。003_grants.sql も同じ内容にしてある。
GRANT SELECT, INSERT ON v3.matter_communications TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.matter_communications_id_seq TO legalbridge_v3_runtime;

COMMIT;

-- 確認
\echo '--- matter_links.target_type ---'
SELECT pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid = 'v3.matter_links'::regclass AND c.contype = 'c';

\echo '--- condition_schedules の列 ---'
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'condition_schedules'
 ORDER BY ordinal_position;

\echo '--- matters.document_style ---'
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='matters' AND column_name='document_style';

\echo '--- conditions の適用開始日と系列 ---'
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='conditions'
   AND column_name IN ('effective_from', 'series_id')
 ORDER BY column_name;

\echo '--- conditions.status で許す値 ---'
SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE conrelid='v3.conditions'::regclass AND conname='conditions_status_chk';

\echo '--- 系列が埋まっていない条件（0 であること） ---'
SELECT count(*) AS series_missing FROM v3.conditions WHERE series_id IS NULL;

\echo '--- 発行できないひな形（採番プレフィックス無し。0件が望ましい） ---'
-- 部分テンプレート（他のひな形に差し込む約款など）は書類ではないので数えない。
SELECT template_key, label, category
  FROM v3.document_templates
 WHERE is_active
   AND category IS DISTINCT FROM 'partial'
   AND template_key NOT LIKE '\_%'
   AND COALESCE(btrim(number_prefix), '') = ''
 ORDER BY category NULLS LAST, label;

\echo '--- 自社プロファイル ---'
SELECT jsonb_pretty(value) AS company_profile
  FROM v3.settings WHERE key = 'company_profile';

\echo '--- 書類に載る連絡先（住所・電話・メール）---'
SELECT
  count(*) FILTER (WHERE address IS NOT NULL) AS 住所あり,
  count(*) FILTER (WHERE phone   IS NOT NULL) AS 電話あり,
  count(*) FILTER (WHERE email   IS NOT NULL) AS メールあり,
  count(*) AS 取引先件数
  FROM v3.parties;

\echo '--- 中身の無い口座（0 であること）---'
SELECT count(*) AS 種別しか無い口座
  FROM v3.party_bank_accounts
 WHERE bank_name IS NULL AND branch_name IS NULL
   AND account_number IS NULL AND account_holder_kana IS NULL;

\echo '--- 振込先の欠け（銀行名・支店名・種別が空の口座）---'
SELECT count(*) FILTER (WHERE bank_name IS NULL)    AS 銀行名なし,
       count(*) FILTER (WHERE branch_name IS NULL)  AS 支店名なし,
       count(*) FILTER (WHERE account_type IS NULL) AS 種別なし,
       count(*) AS 口座件数
  FROM v3.party_bank_accounts;

\echo '--- 欠けた振込先（A-012 が上げた不整合）---'
SELECT severity AS 重大度, count(*) AS 件数
  FROM v3.data_quality_issues
 WHERE rule_code = 'PARTY_BANK_INCOMPLETE' AND status = 'open'
 GROUP BY severity ORDER BY severity;

\echo '--- 空白だけの値（A-014 のあと 0 であること）---'
SELECT
  (SELECT count(*) FROM v3.staff   WHERE btrim(email) = '' OR btrim(department) = ''
                                      OR btrim(phone) = '')                AS 担当者,
  (SELECT count(*) FROM v3.parties WHERE btrim(address) = '' OR btrim(phone) = ''
                                      OR btrim(email) = '')                AS 取引先,
  (SELECT count(*) FROM v3.party_bank_accounts
    WHERE btrim(bank_name) = '' OR btrim(branch_name) = '' OR btrim(account_type) = ''
       OR btrim(account_number) = '' OR btrim(account_holder_kana) = '')    AS 口座;

\echo '--- 口座表の権限（SELECT/INSERT/UPDATE。DELETE が無いこと） ---'
SELECT privilege_type FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime' AND table_name = 'party_bank_accounts'
 ORDER BY privilege_type;

\echo '--- やり取りの記録（A-015。表があり、権限は SELECT/INSERT だけ） ---'
SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) AS 権限
  FROM information_schema.role_table_grants
 WHERE grantee = 'legalbridge_v3_runtime' AND table_name = 'matter_communications';
