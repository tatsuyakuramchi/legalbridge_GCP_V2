-- =====================================================================
-- 本番 V3 の表の作りを、いまのコードにそろえる（追加開発分をまとめて当てる）
--
--   ローカル（予備系）の中身で本番を入れ直す（docs/v3-push-local-to-prod.md）前に、本番の表・列・
--   ビュー・権限をローカルと同じ形にする。止まっていた間に足した開発分も含む。
--   どの番号まで本番に当たっているか分からなくてもよい：ここに並べたのは、何度流しても同じ結果になる
--   作り（表・列・制約・索引・引き金・ビュー・権限）だけ。
--
--   流すもの（この順）
--     1. 004_amend.sql            後追いの変更の積み重ね
--     2. 番号付きの作りの変更     004 に入っていない表・列・制約・引き金
--                                 （172・189・191〜196・199・201・205・208〜210）
--     3. 004_amend.sql            もう一度（2 を前提にした変更があっても当たるように）
--     4. 002_views.sql            ビューの作り直し
--     5. 003_grants.sql           実行ロールの権限（新しい表にも付ける）
--
--   流さないもの
--     - 004 に同じ変更が入っている番号（156〜183 の列・制約など）… 1 と 3 で当たる。番号のほうは
--       古い定義で制約を作り直すことがあり（例：200 は 205 より狭い種別の制約）、今のデータで止まる
--     - ひな形・文例などの中身の登録（206・207・211〜214・217〜219 など）
--       … 入れ直しでローカルの中身ごと入る
--     - 中身の移し替え・一度きりの直し（190・215・216 など）… 同上
--     - 片付け（202 表の軽量化・203 V2 の退避）… 作りの差には効かない。必要なら別に流す
--
--   実行（Cloud Shell。リポジトリの最上位で、本番につないだ psql）
--     psql -v ON_ERROR_STOP=1 -f infra/v3/catchup_schema.sql
--   途中で止まったら、止まったファイルと出力を見て相談する（それより前に当てた分は残る。どれも流し直してよい）。
--
--   最後に、v3 の表と列の数を出す。入れ直しの SQL（ops push-export）が流す前に、ローカルと列が
--   同じかを確かめ、違えば表.列を挙げて止まる（そのときは何も変わらない）。
-- =====================================================================
\set ON_ERROR_STOP on
\pset pager off

\echo '== 1. 004_amend =='
\ir 004_amend.sql

\echo '== 2. 番号付きの作りの変更 =='
\ir 172_multi_party.sql
\ir 189_order_agreements.sql
\ir 191_agreement_direction_none.sql
\ir 192_event_source_payment.sql
\ir 193_work_editions.sql
\ir 194_work_editions_oem.sql
\ir 195_work_editions_grant.sql
\ir 196_work_source_title.sql
\ir 199_condition_archived.sql
\ir 201_lookup_indexes.sql
\ir 205_agreement_hybrid.sql
\ir 208_agreement_versions.sql
\ir 209_agreement_repaper.sql
\ir 210_event_stores.sql

\echo '== 3. 004_amend（もう一度） =='
\ir 004_amend.sql

\echo '== 4. 002_views =='
\ir 002_views.sql

\echo '== 5. 003_grants =='
\set confirm_v3_grants GRANT_V3_RUNTIME
\ir 003_grants.sql

\echo '== できあがり：v3 の表と列の数（ローカルの ops sql で同じものを数えて突き合わせられる） =='
SELECT count(DISTINCT c.table_name) AS 表, count(*) AS 列
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
 WHERE c.table_schema = 'v3' AND t.table_type = 'BASE TABLE';
