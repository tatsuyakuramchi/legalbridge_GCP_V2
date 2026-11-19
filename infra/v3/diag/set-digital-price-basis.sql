-- =====================================================================
-- 電子（出版）の条件明細で、算定の基礎が未設定のものを、まとめて設定する（お試しが既定）。
--
--   算定の基礎（conditions.price_basis）
--     receipts … 受領額（税抜）× 料率（再許諾先・配信事業者から受け取った額）
--     list     … 配信価格（税抜）× ダウンロード数 × 料率
--   条件書V5（出版）は、ここから第4条の電子の式と一覧の電子の欄を決める。未設定の条件を載せると
--   「算定の基礎が未設定です」と注意が出て、配信価格の式で出る。
--
--   対象：取得（IN）の利用許諾・電子出版（利用形態 pub_digital、または利用形態が空で範囲の媒体が電子）・
--         有効／予定の版・算定の基礎が未設定・印税相当額（in_lieu）でないもの。
--   変えないこと：もう基礎が入っている条件（上書きしない）、再許諾の電子（pub_sub_digital）、
--                 置き換えられた旧版・無効の条件、料率・期間などほかの列、実績・支払・文書。
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/set-digital-price-basis.sql basis=receipts
--       書き込む：docker compose run --rm ops sql /v3/diag/set-digital-price-basis.sql basis=receipts write=1
--     絞るとき（どちらも任意。両方付ければ両方に当たるものだけ）：
--       party=冒険支援     相手先の名前の一部
--       rate=15            料率（%）がこの値のものだけ
--     配信価格にするなら basis=list。何度流しても同じ（2 回目以降は 0 件）。
--   流したあと：該当する条件書V5（出版）の下書きを開き直す。
-- =====================================================================

\pset pager off
\if :{?basis}
\else
  \echo '設定する基礎を basis=receipts（受領額）か basis=list（配信価格 × ダウンロード数）で渡してください'
  \quit
\endif
\if :{?party}
\else
  \set party ''
\endif
\if :{?rate}
\else
  \set rate ''
\endif
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.basis', :'basis', false) AS 設定する基礎, set_config('fix.party', :'party', false) AS 相手先の絞り込み,
       set_config('fix.rate', :'rate', false) AS 料率の絞り込み, set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry     boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  v_basis text := lower(btrim(current_setting('fix.basis')));
  v_party text := btrim(current_setting('fix.party'));
  v_rate  text := btrim(replace(replace(current_setting('fix.rate'), '%', ''), '％', ''));
  v_ppm   bigint;
  label   text;
  ids     bigint[];
  n       int;
  parties text;
  sample  text;
BEGIN
  IF v_basis NOT IN ('receipts', 'list') THEN
    RAISE EXCEPTION 'basis は receipts（受領額）か list（配信価格 × ダウンロード数）です（渡された値：%）', v_basis;
  END IF;
  label := CASE v_basis WHEN 'receipts' THEN '受領額' ELSE '配信価格 × ダウンロード数' END;
  IF v_rate <> '' THEN
    IF v_rate !~ '^[0-9]+(\.[0-9]+)?$' THEN RAISE EXCEPTION 'rate は数字で渡してください（例：rate=15）'; END IF;
    v_ppm := round(v_rate::numeric * 10000);
  END IF;

  SELECT array_agg(c.id ORDER BY c.id) INTO ids
    FROM v3.conditions c
    JOIN v3.parties p ON p.id = c.counterparty_id
   WHERE c.kind = 'license' AND c.direction = 'in'
     AND c.status IN ('active', 'scheduled')
     AND c.price_basis IS NULL
     AND COALESCE(c.license_fee_basis, 'separate') <> 'in_lieu'
     AND (c.usage_type = 'pub_digital'
          OR (c.usage_type IS NULL AND EXISTS (
                SELECT 1 FROM v3.condition_scopes s
                 WHERE s.condition_id = c.id AND s.scope_type = 'media'
                   AND (s.code = 'digital' OR s.label LIKE '%電子%'))))
     AND (v_party = '' OR p.name ILIKE '%' || v_party || '%')
     AND (v_ppm IS NULL OR c.rate_ppm = v_ppm);
  n := COALESCE(array_length(ids, 1), 0);
  IF n = 0 THEN
    RAISE WARNING '設定するものはありません（当てはまる条件明細で、算定の基礎が未設定のものは 0 件）';
    RETURN;
  END IF;

  -- 相手先ごとの件数（料率つき）と、先頭の数件。
  SELECT string_agg(format('  %s：%s 本（料率 %s）', x.name, x.n, x.rates), E'\n' ORDER BY x.name) INTO parties
    FROM (SELECT p.name, count(*) AS n,
                 string_agg(DISTINCT trim(trailing '.' FROM trim(trailing '0' FROM (c.rate_ppm / 10000.0)::numeric(9,4)::text)) || '%', '・') AS rates
            FROM v3.conditions c JOIN v3.parties p ON p.id = c.counterparty_id
           WHERE c.id = ANY(ids) GROUP BY p.name) x;
  SELECT string_agg(format('  %s　%s', COALESCE(c.condition_no, '#' || c.id::text), left(c.name, 40)), E'\n' ORDER BY c.id) INTO sample
    FROM (SELECT * FROM v3.conditions WHERE id = ANY(ids) ORDER BY id LIMIT 8) c;

  UPDATE v3.conditions SET price_basis = v_basis, updated_at = now() WHERE id = ANY(ids);
  IF NOT dry THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    SELECT 'sql:set-digital-price-basis', 'condition.update', 'condition', id,
           jsonb_build_object('patch', jsonb_build_object('priceBasis', v_basis), 'mode', 'sql_bulk')
      FROM unnest(ids) AS id;
  END IF;

  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = format(
      E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）。\n算定の基礎を「%s」にする条件明細 %s 本\n%s\n先頭の数件：\n%s',
      label, n, parties, sample);
  END IF;
  RAISE WARNING E'書き込みました。算定の基礎を「%」にした条件明細 % 本\n%', label, n, parties;
END
$fix$;

\echo
\echo '残り：電子（出版）で、算定の基礎が未設定のままの条件明細（有効・予定）の数'
\echo '（お試しのときは、上で設定する分もここに数えます）'
SELECT count(*) AS 未設定の本数
  FROM v3.conditions c
 WHERE c.kind = 'license' AND c.direction = 'in' AND c.usage_type = 'pub_digital'
   AND c.status IN ('active', 'scheduled') AND c.price_basis IS NULL
   AND COALESCE(c.license_fee_basis, 'separate') <> 'in_lieu';
