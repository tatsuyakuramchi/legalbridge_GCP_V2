#!/usr/bin/env bash
# 予備系の作業スクリプト。ops コンテナの中で走る（ホストに psql は要らない）。
#
#   ops sync              本番 v3 スキーマを写してローカル DB に入れる（平時に毎晩）
#   ops export-info       エクスポート方式（SYNC_MODE=export）の準備に要る値を出す
#   ops import-rows <dir> Studio から落とした CSV を取り込む（094_export_rows.sql の結果）
#   ops import-contacts <dir>
#                         連絡先と口座だけを本番の値にする（098_export_contacts.sql の結果）
#   ops restore <file>    手元の写し（/dumps/…）をローカル DB に入れ直す
#   ops fresh             本番データなしで開発用 DB を作る（模擬データ）
#   ops grants            ランタイムロールの権限を当て直す
#   ops upgrade           手元の DB を今のスキーマに合わせる（列を足したあと）
#   ops sql-prod <file> [名前=値 ...]
#                         読むだけの照会を本番へ流す（書き込みは口ごと閉じる）
#                         例: ops sql-prod /v3/diag/orphan-documents.sql
#   ops sql <file> [名前=値 ...]
#                         SQL を流す（infra/v3 の診断は /v3/095_… で指せる）。
#                         名前=値 を足すと照会の :'名前' に入る
#                         （例: ops sql /v3/diag/party-documents.sql q=取引先名）
#   ops push-export       ローカルの v3 の中身を、本番へ入れ直す SQL 1本にまとめる
#                         （本番が止まっていた間にローカルで作業した分を持ち帰る。
#                           流すのは Cloud Shell の psql。docs/v3-push-local-to-prod.md）
#   ops backup-begin      予備系で書き始める（本番が止まったとき。ここからの変更を記録する）
#   ops backup-status     予備系で書いた変更の数
#   ops backup-attach     停止中に移行 SQL で足した表にも記録の引き金を付ける（backup-export の前に）
#   ops backup-export     予備系で書いた変更を、本番へ持ち帰る SQL 1 本にまとめる
#                         （本番にも書き込みがあってよい。流すのは Cloud Shell の psql。
#                           docs/v3-backup-merge.md）
#   ops backup-close merged|discard
#                         予備系の書き込みを閉じる（持ち帰った後か、捨てるとき）
#   ops status            写しの一覧と、いま入っているデータの時点
#   ops netcheck [host port]
#                         同期に要る Google の口へ、コンテナから届くかを見る。
#                         host port を足すと、そこへの TCP 接続も試す
#                         （例: ops netcheck 34.146.158.194 3307）
#
# ローカル DB への接続は PGHOST / PGUSER / PGPASSWORD / PGDATABASE（compose が渡す）。
set -euo pipefail

# Windows で .env を書くと行末に CR が付くことがある。パスワードに紛れ込むと本番に
# つながらないので、ここで落とす。未設定の変数は空にしておく（set -u で落ちないように）。
strip_cr() {
  local n
  for n in "$@"; do eval "$n=\"\${$n-}\"; $n=\"\${$n%\$'\r'}\""; done
}
strip_cr SYNC_DB_PASSWORD SYNC_DB_USER SYNC_DB_HOST SYNC_DB_PORT \
         CLOUD_SQL_INSTANCE REMOTE_DB_NAME KEEP_DUMPS PGPASSWORD \
         SYNC_MODE EXPORT_BUCKET EXPORT_SUBDIR
# 世代数が空だと prune が全部消してしまう。既定を置く。
[ -n "$KEEP_DUMPS" ] || KEEP_DUMPS=14

DUMPS="${DUMPS:-/dumps}"
LOCAL_SQL="${LOCAL_SQL:-/local-sql}"
DATA="${DATA:-/data}"
STAMP="$DATA/SYNC_STAMP"
V3="${V3:-/v3}"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 予備系で書いた変更（backup-begin から）がまだ持ち帰られていないか。写しの入れ直しや
# 作り直しはローカルの v3 を消すので、持ち帰る前に流すと予備系で書いた分が失われる。
# 捨ててよいときは BACKUP_DISCARD=yes を付けて流す。
backup_session() {
  psql -Atq -c "SELECT id FROM backup.sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1" 2>/dev/null || true
}
assert_no_backup() {
  local sid; sid=$(backup_session)
  [ -z "$sid" ] && return 0
  [ "${BACKUP_DISCARD:-}" = "yes" ] && { log "予備系で書いた変更（記録 ${sid}）を捨てて進める（BACKUP_DISCARD=yes）"; return 0; }
  die "予備系で書いた変更（記録 ${sid}）がまだ持ち帰られていません。ローカルの v3 を入れ直すと失われます。
  先に ops backup-export で本番へ持ち帰り、ops backup-close merged で閉じてください。
  捨ててよいなら ops backup-close discard（または BACKUP_DISCARD=yes を付けて流す）。"
}

# NOTICE（存在しない表のスキップなど）は出さない。エラーだけ見えればよい。
export PGOPTIONS="-c client_min_messages=warning"
psql_local() { psql -v ON_ERROR_STOP=1 -q "$@"; }

# 003_grants.sql をローカルに当てる。写しは --no-privileges で取るので、
# 権限は本番と同じ SQL から作り直す（本番だけにあるロールへの GRANT を持ち込まない）。
apply_grants() {
  log "ランタイムロールの権限を当てる"
  psql_local -v confirm_v3_grants=GRANT_V3_RUNTIME -f "$V3/003_grants.sql" >/dev/null
}

write_stamp() {
  mkdir -p "$DATA"
  printf '%s\n' "$1" > "$STAMP"
  log "データの時点: $1"
}

# 写しのファイル名 v3_YYYYmmdd_HHMM.dump から時点を読む。
stamp_of() {
  local name; name=$(basename "$1")
  if [[ "$name" =~ v3_([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2}) ]]; then
    echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}"
  else
    date -r "$1" '+%Y-%m-%d %H:%M'
  fi
}

# 写しをローカル DB に入れ直す。形式は2つある。
#   *.dump    Proxy 経由の pg_dump（カスタム形式。スキーマ丸ごと）
#   *.sql.gz  Cloud SQL のエクスポート（平文 SQL。表だけなのでビューは作り直す）
# 入れ替えの前に、いまの v3 を写しておく。中身が無ければ何もしない。
backup_before_replace() {
  local rows
  rows=$(psql -Atq -c "SELECT count(*) FROM v3.matters" 2>/dev/null || echo 0)
  [ "${rows:-0}" -gt 0 ] 2>/dev/null || { log "いまの v3 は空。写しは取らない"; return 0; }
  local out="$DUMPS/before_import_$(date '+%Y%m%d_%H%M%S').dump"
  log "入れ替える前の写しを取る（案件 ${rows} 件）→ $out"
  pg_dump --no-owner --no-privileges -n v3 -Fc -f "$out"
  log "戻すときは: ops restore ${out}"
}

restore() {
  assert_no_backup
  local file="$1"
  [ -f "$file" ] || die "写しが見つかりません: $file"
  case "$file" in
    *.sql.gz) restore_sql "$file" ;;
    *)        restore_custom "$file" ;;
  esac
  apply_grants
  local rows
  rows=$(psql -Atq -c "SELECT count(*) FROM v3.matters" 2>/dev/null || echo '?')
  log "入れ替え完了（案件 ${rows} 件）"
  write_stamp "$(stamp_of "$file")"
}

restore_custom() {
  local file="$1"
  # grep -q は最初の一致で閉じるので pipefail に引っかかる。全部読ませる。
  pg_restore --list "$file" | grep "SCHEMA - v3" >/dev/null || die "v3 スキーマの写しではありません: $file"
  log "ローカル DB の v3 を入れ替える（$file）"
  # 入れ替えは1つの取引で行う。途中で落ちれば前の写しが残る。
  # DROP は接続中のアプリの表を消すが、アプリは次の問い合わせで新しい表を見る。
  {
    echo "BEGIN;"
    echo "DROP SCHEMA IF EXISTS v3 CASCADE;"
    pg_restore --no-owner --no-privileges -f - "$file"
    echo "COMMIT;"
  } | psql_local >/dev/null
}

# 表単位の書き出しには関数が入らない（トリガーの定義だけが入る）ので、
# 手元のスキーマ定義から関数を先に作る。増えても直す場所は 001/004 のまま。
install_functions() {
  local f
  for f in "$V3/001_schema.sql" "$V3/004_amend.sql"; do
    awk '/^CREATE OR REPLACE FUNCTION v3\./{on=1}
         on{print}
         on && /^\$[a-zA-Z_]*\$;[[:space:]]*$/{on=0}' "$f"
  done
}

restore_sql() {
  local file="$1"
  gunzip -c "$file" | grep "CREATE TABLE v3\." >/dev/null \
    || die "v3 の表が入っていません: $file"
  log "ローカル DB の v3 を入れ替える（$file）"
  # 取り除くもの:
  #   OWNER TO / GRANT / REVOKE / SET SESSION AUTHORIZATION
  #     本番にしかないロールを指すので、そのままでは復元が止まる。
  #     権限はこのあと 003_grants.sql で当て直すので捨ててよい。
  #   CREATE SCHEMA
  #     こちらで作るので二重定義にしない。
  {
    echo "BEGIN;"
    echo "DROP SCHEMA IF EXISTS v3 CASCADE;"
    echo "CREATE SCHEMA v3;"
    install_functions
    gunzip -c "$file" | sed -E '/^ALTER .* OWNER TO /d; /^(GRANT|REVOKE|SET SESSION AUTHORIZATION|CREATE SCHEMA) /d'
    echo "COMMIT;"
  } | psql_local >/dev/null
  # エクスポートは表だけなので、ビューは手元の定義から作る。
  log "ビューを作り直す"
  psql_local -f "$V3/002_views.sql" >/dev/null
}

# ---------------------------------------------------------------------
# Google の API を叩くための下ごしらえ（方式2で使う）。
#   通信は 443 番だけ。社内ネットワークが 3307 番を塞いでいても通る。
# ---------------------------------------------------------------------
GCP_PROJECT_ID() { echo "${CLOUD_SQL_INSTANCE%%:*}"; }
INSTANCE_ID()    { echo "${CLOUD_SQL_INSTANCE##*:}"; }

# adc.json（人のログイン）から使い捨ての access token を作る。
# サービスアカウントの鍵は組織ポリシーで作れないので、こちらだけを見る。
access_token() {
  local f=/keys/adc.json
  [ -f "$f" ] || die "keys/adc.json がありません。docker compose run --rm login を先に。"
  local tok
  tok=$(curl -s --max-time 30 -X POST https://oauth2.googleapis.com/token \
        -d client_id="$(jq -r .client_id "$f")" \
        -d client_secret="$(jq -r .client_secret "$f")" \
        -d refresh_token="$(jq -r .refresh_token "$f")" \
        -d grant_type=refresh_token | jq -r '.access_token // empty')
  [ -n "$tok" ] || die "ログインが切れています。docker compose run --rm login をやり直してください。"
  echo "$tok"
}

# API を叩く。第1引数が HTTP メソッド、第2が URL、第3があれば本文（JSON）。
# 応答は標準出力へ。HTTP が 400 以上ならエラー本文を出して止める。
api() {
  local method="$1" url="$2" body="${3:-}"
  local out code
  # 引数は配列で渡す。JSON の本文には空白が入るので、展開したままでは分割される。
  local args=(-s -w '\n%{http_code}' --max-time 120 -X "$method" "$url"
              -H "Authorization: Bearer $TOKEN"
              -H "x-goog-user-project: $(GCP_PROJECT_ID)")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  out=$(curl "${args[@]}")
  code=$(echo "$out" | tail -n1)
  out=$(echo "$out" | sed '$d')
  if [ "$code" -ge 400 ]; then
    echo "$out" | jq -r '.error.message // .' >&2
    die "API が $code を返しました（$method $url）"
  fi
  echo "$out"
}

# 写す対象の表。手元のスキーマ定義から作るので、表が増えても直す場所は1つで済む。
v3_tables_json() {
  grep -ohE 'CREATE TABLE (IF NOT EXISTS )?v3\.[a-z_]+' "$V3/001_schema.sql" "$V3/004_amend.sql" \
    | sed -E 's/.*(v3\.[a-z_]+)/\1/' | sort -u | jq -R . | jq -s .
}

# ---------------------------------------------------------------------
# 方式2：Cloud SQL のエクスポートで Cloud Storage に出し、そこから落とす。
#   443 番しか使わない。3307 番が塞がれている環境はこちら。
# ---------------------------------------------------------------------
sync_export() {
  [ -n "${CLOUD_SQL_INSTANCE:-}" ] || die "CLOUD_SQL_INSTANCE が空です（.env）"
  [ -n "${EXPORT_BUCKET:-}" ] || die "EXPORT_BUCKET が空です（.env）。ops export-info を見てください。"
  mkdir -p "$DUMPS"

  local project instance name object uri tables
  project=$(GCP_PROJECT_ID); instance=$(INSTANCE_ID)
  TOKEN=$(access_token)

  name="v3_$(date '+%Y%m%d_%H%M').sql.gz"
  object="${EXPORT_SUBDIR:+${EXPORT_SUBDIR}/}$name"
  uri="gs://$EXPORT_BUCKET/$object"
  tables=$(v3_tables_json)
  log "本番の v3 を書き出す（$(echo "$tables" | jq 'length') 表 → $uri）"

  local body op
  body=$(jq -n --arg uri "$uri" --arg db "$REMOTE_DB_NAME" --argjson tables "$tables" \
    '{exportContext:{kind:"sql#exportContext",fileType:"SQL",uri:$uri,
                     databases:[$db],sqlExportOptions:{tables:$tables}}}')
  op=$(api POST "https://sqladmin.googleapis.com/v1/projects/$project/instances/$instance/export" "$body" \
       | jq -r '.name // empty')
  [ -n "$op" ] || die "書き出しを始められませんでした"

  # 書き出しはインスタンス側で走る。終わるまで待つ（最大30分）。
  local status="" i
  for i in $(seq 1 180); do
    sleep 10
    status=$(api GET "https://sqladmin.googleapis.com/v1/projects/$project/operations/$op" \
             | jq -r '.status // empty')
    if [ "$status" = "DONE" ]; then break; fi
    if [ $((i % 6)) -eq 0 ]; then log "書き出し中（$((i / 6)) 分経過）"; fi
  done
  [ "$status" = "DONE" ] || die "書き出しが30分で終わりませんでした"

  local err
  err=$(api GET "https://sqladmin.googleapis.com/v1/projects/$project/operations/$op" \
        | jq -r '.error.errors[0].message // empty')
  [ -z "$err" ] || die "書き出しが失敗しました: $err"

  local file="$DUMPS/$name"
  log "Cloud Storage から落とす"
  local enc; enc=$(jq -rn --arg o "$object" '$o|@uri')
  if ! curl -sS --fail --max-time 1800 -o "$file" \
       -H "Authorization: Bearer $TOKEN" \
       -H "x-goog-user-project: $project" \
       "https://storage.googleapis.com/storage/v1/b/$EXPORT_BUCKET/o/$enc?alt=media"; then
    rm -f "$file"
    die "落とせませんでした（バケットの読み取り権限を確かめてください）"
  fi
  log "落とし終わり（$(du -h "$file" | cut -f1)）"

  # 置きっぱなしにしない。手元に落ちた時点でバケットからは消す。
  # ここで失敗しても写しは手元にあるので、止めずに知らせるだけにする。
  if curl -sS --fail -X DELETE \
       -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $project" \
       "https://storage.googleapis.com/storage/v1/b/$EXPORT_BUCKET/o/$enc" >/dev/null 2>&1; then
    log "バケットの書き出しファイルを消した"
  else
    log "バケットのファイルを消せませんでした（残っています。手で消してください）"
  fi

  restore "$file"
  prune
}

# 方式2の準備に要る値を出す。バケットに書けるのはインスタンスの持つ
# サービスアカウントなので、その宛先をここで調べて示す。
export_info() {
  [ -n "${CLOUD_SQL_INSTANCE:-}" ] || die "CLOUD_SQL_INSTANCE が空です（.env）"
  local project instance sa
  project=$(GCP_PROJECT_ID); instance=$(INSTANCE_ID)
  TOKEN=$(access_token)
  sa=$(api GET "https://sqladmin.googleapis.com/v1/projects/$project/instances/$instance" \
       | jq -r '.serviceAccountEmailAddress // empty')
  [ -n "$sa" ] || die "インスタンスの情報を取れませんでした"

  cat <<INFO

エクスポート方式（SYNC_MODE=export）の準備

 1. Cloud Storage でバケットを1つ作る
      場所      asia-northeast1（インスタンスと同じ）
      アクセス  「公開アクセスの防止」を有効。均一なアクセス制御
      ライフサイクル  1日で削除（消し忘れの保険。同期のたびに消してはいる）

 2. そのバケットに、このインスタンスのサービスアカウントを追加する
      プリンシパル  $sa
      ロール        Storage オブジェクト管理者

 3. .env に次の2行を書く
      SYNC_MODE=export
      EXPORT_BUCKET=<作ったバケット名>

 4. 同期する
      docker compose run --rm ops sync

INFO
}

# 手元の DB を今のスキーマに合わせる。
#
#   git pull で列が増えたとき、入っているデータはそのままで構造だけ追いつかせる。
#   これをやらないと、アプリが新しい列を読もうとして「サーバ内部でエラー」になる。
#   004 は何度流しても同じ結果になるように書いてある。
upgrade() {
  log "後追いの変更を当てる（004_amend.sql）"
  psql_local -f "$V3/004_amend.sql" >/dev/null
  log "ビューを作り直す"
  psql_local -f "$V3/002_views.sql" >/dev/null
  apply_grants
  local rows
  rows=$(psql -Atq -c "SELECT count(*) FROM v3.matters" 2>/dev/null || echo '?')
  log "完了（案件 ${rows} 件。データはそのまま）"
}

# ---------------------------------------------------------------------
# ローカルの v3 の中身で本番を入れ直す SQL を作る（本番へは流さない）。
#
#   本番が止まっている間、ローカルを正として作業した分を持ち帰るためのもの。
#   本番は写しを取った時点から変わっていないこと（確かめる SQL を先頭に入れる）が前提。
#
#   できるファイル（/dumps/push/v3_push_YYYYmmdd_HHMM.sql）は 1 トランザクションで:
#     1. 本番が写しの時点から変わっていないか（audit_events）を確かめ、変わっていれば止める
#     2. 列の並びがローカルと本番で同じかを確かめ、違えば止める（004 の当て忘れ）
#     3. 外部キーを一時的に「最後に確かめる」にし、利用者の引き金を止める
#        （Cloud SQL には superuser が無く、ローカルの取り込みと同じ止め方はできない）
#     4. v3 の全部の表を空にして、ローカルの中身を入れる（番号の採番表・連番も）
#     5. ローカルにしか無い PDF の保存先（/local-files/）を消す（本番では本文から作り直す）
#     6. 外部キーを確かめて元に戻し、表ごとの行数がローカルと同じかを数える
#     7. 入れ直した記録を audit_events に残す
#   途中で 1 つでも失敗すれば何も変わらない。
#
#   中身は口座番号・名義・連絡先を含む本番の写し。置き場所と消し忘れに気をつける。
# ---------------------------------------------------------------------
push_export() {
  local dir="$DUMPS/push" ts out body
  ts=$(date +%Y%m%d_%H%M)
  mkdir -p "$dir"
  out="$dir/v3_push_${ts}.sql"
  body="$dir/.body_${ts}.sql"

  # 写しの時点：取り込み（import-rows）の行が持つ xmin の、操作記録の最後の時刻。
  # 取り込みは全部の表を 1 トランザクションで入れるので、全表で最も多い xmin がそれ。
  local import_xid import_tables since
  read -r import_xid import_tables < <(psql -Atq -F ' ' -c "
    SELECT x.xid, count(*) FROM pg_tables t
      CROSS JOIN LATERAL xmltable('/table/row'
        PASSING query_to_xml(format('SELECT xmin::text AS xid, count(*) AS n FROM v3.%I GROUP BY 1', t.tablename), false, false, '')
        COLUMNS xid text PATH 'xid', n bigint PATH 'n') AS x
     WHERE t.schemaname = 'v3' GROUP BY x.xid ORDER BY sum(x.n) DESC LIMIT 1")
  if [ -n "${PUSH_SINCE:-}" ]; then
    since="$PUSH_SINCE"
  else
    [ "${import_tables:-0}" -ge 10 ] || die "取り込み（import-rows）の時点が分かりません。PUSH_SINCE='2026-09-09 21:13:53+09' のように指定してください"
    since=$(psql -Atq -c "SELECT to_char(max(occurred_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF') FROM v3.audit_events WHERE xmin::text = '$import_xid'")
  fi
  [ -n "$since" ] || die "写しの時点が決まりません"
  log "写しの時点: $since（これより後に本番で操作があれば、流したときに止まる）"

  log "ローカルの中身を書き出す（pg_dump --data-only）"
  # \restrict / \unrestrict は新しい pg_dump が付ける psql の命令。Cloud Shell の
  # SET transaction_timeout は PostgreSQL 17 の pg_dump が付ける設定。本番（Cloud SQL）が 16 以前だと
  # 「unrecognized configuration parameter」で止まるので外す（無くても動きは同じ）。
  # psql が古いと知らない命令で止まるので落とす。
  # 循環する外部キーの警告が出るが、流す側で外部キーを最後に確かめるので問題ない。
  pg_dump --data-only --schema=v3 --no-owner --no-privileges 2>"$body.err" \
    | grep -v -E '^\\(restrict|unrestrict) ' \
    | grep -v -E '^SET transaction_timeout ' > "$body"
  if grep -v -E 'circular foreign-key|^pg_dump: (detail|hint):' "$body.err" | grep -q .; then
    cat "$body.err" >&2; rm -f "$body" "$body.err"; die "pg_dump が失敗しました"
  fi
  rm -f "$body.err"

  local cols counts tables
  cols=$(psql -Atq -c "
    SELECT string_agg(format('(%L,%L,%s)', c.table_name, c.column_name, c.ordinal_position), E',\n' ORDER BY c.table_name, c.ordinal_position)
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'v3' AND t.table_type = 'BASE TABLE'")
  counts=$(psql -Atq -c "
    SELECT string_agg(format('(%L,%s)', t.tablename, x.n), E',\n' ORDER BY t.tablename)
      FROM pg_tables t
      CROSS JOIN LATERAL xmltable('/table/row'
        PASSING query_to_xml(format('SELECT count(*) AS n FROM v3.%I', t.tablename), false, false, '')
        COLUMNS n bigint PATH 'n') AS x
     WHERE t.schemaname = 'v3'")
  tables=$(psql -Atq -c "SELECT string_agg(format('v3.%I', tablename), ', ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'v3'")
  local local_files
  local_files=$(psql -Atq -c "SELECT count(*) FROM v3.documents WHERE storage_url LIKE '%/local-files/%'")

  {
    cat <<EOF
-- =====================================================================
-- 本番 v3 をローカルの中身で入れ直す（ops push-export が ${ts} に作成）
--
--   写しの時点: ${since}
--   流すのは Cloud Shell の psql（postgres ロール）。Studio では流せない。
--     psql -v ON_ERROR_STOP=1 -v confirm_push=REPLACE_V3_WITH_LOCAL -f $(basename "$out")
--   手順: docs/v3-push-local-to-prod.md
--
--   口座番号・名義・連絡先を含む。流し終えたら Cloud Shell とローカルの両方から消す。
-- =====================================================================
\\set ON_ERROR_STOP on
\\pset pager off

\\if :{?confirm_push}
\\else
  \\echo 'Run with: -v confirm_push=REPLACE_V3_WITH_LOCAL'
  \\quit
\\endif
SELECT :'confirm_push' = 'REPLACE_V3_WITH_LOCAL' AS confirmed \\gset
\\if :confirmed
\\else
  \\echo '確認の値が違います。何も変えていません。'
  \\quit
\\endif

-- 1. 本番が写しの時点から変わっていないか
DO \$guard\$
DECLARE n bigint;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'legalbridge ではないデータベースにつながっています: %', current_database();
  END IF;
  SELECT count(*) INTO n FROM v3.audit_events
   WHERE occurred_at > TIMESTAMPTZ '${since}' AND action <> 'job.daily';
  IF n > 0 THEN
    RAISE EXCEPTION '本番に写しの時点（${since}）より後の操作が % 件あります。入れ直すと消えるので止めます', n;
  END IF;
END
\$guard\$;

-- 2. 列の並びが同じか（本番に 004_amend を当て忘れていないか）
CREATE TEMP TABLE push_local_columns (table_name text, column_name text, ordinal int);
INSERT INTO push_local_columns VALUES
${cols};
DO \$cols\$
DECLARE diff text;
BEGIN
  SELECT string_agg(format('%s.%s（%s）', table_name, column_name, side), '、' ORDER BY table_name, column_name)
    INTO diff
    FROM (
      SELECT l.table_name, l.column_name, 'ローカルだけ' AS side
        FROM push_local_columns l
       WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                          WHERE c.table_schema = 'v3' AND c.table_name = l.table_name AND c.column_name = l.column_name)
      UNION ALL
      SELECT c.table_name, c.column_name, '本番だけ'
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'v3' AND t.table_type = 'BASE TABLE'
         AND NOT EXISTS (SELECT 1 FROM push_local_columns l
                          WHERE l.table_name = c.table_name AND l.column_name = c.column_name)
    ) d;
  IF diff IS NOT NULL THEN
    RAISE EXCEPTION '列がローカルと本番で違います（先に 004_amend を当てる）: %', diff;
  END IF;
END
\$cols\$;

CREATE TEMP TABLE push_expected (table_name text, n bigint);
INSERT INTO push_expected VALUES
${counts};

BEGIN;
SET LOCAL lock_timeout = '15s';

-- 3. 外部キーを「最後に確かめる」に。戻すために名前を控える。
CREATE TEMP TABLE push_fk ON COMMIT DROP AS
SELECT format('%I.%I', n.nspname, c.relname) AS rel, con.conname
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype = 'f' AND n.nspname = 'v3' AND NOT con.condeferrable;
DO \$defer\$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM push_fk LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', r.rel, r.conname);
  END LOOP;
END
\$defer\$;
SET CONSTRAINTS ALL DEFERRED;

-- 利用者の引き金（条件の系列番号など）を止める。入れる値はローカルで決まっている。
CREATE TEMP TABLE push_triggers ON COMMIT DROP AS
SELECT DISTINCT format('%I.%I', n.nspname, c.relname) AS rel
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'v3' AND NOT tg.tgisinternal;
DO \$trg\$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM push_triggers LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', r.rel);
  END LOOP;
END
\$trg\$;

-- 4. 空にして入れる
TRUNCATE ${tables};

EOF
    cat "$body"
    cat <<EOF

-- 5. ローカルにしか無い PDF の保存先を消す（本番では文書の本文から作り直す）。${local_files} 件
UPDATE v3.documents SET storage_url = NULL WHERE storage_url LIKE '%/local-files/%';

-- 6. 外部キーを確かめて戻す。引き金も戻す。
SET CONSTRAINTS ALL IMMEDIATE;
DO \$restore\$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM push_fk LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', r.rel, r.conname);
  END LOOP;
  FOR r IN SELECT * FROM push_triggers LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', r.rel);
  END LOOP;
END
\$restore\$;

-- 行数がローカルと同じか
DO \$count\$
DECLARE r record; got bigint; bad text := '';
BEGIN
  FOR r IN SELECT * FROM push_expected LOOP
    EXECUTE format('SELECT count(*) FROM v3.%I', r.table_name) INTO got;
    IF got <> r.n THEN bad := bad || format('%s: ローカル %s / 本番 %s、', r.table_name, r.n, got); END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION '行数が合いません: %', bad; END IF;
END
\$count\$;

-- 7. 入れ直した記録
INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
VALUES ('ops@push', 'ops.push_from_local', 'system', 0,
        jsonb_build_object('since', '${since}', 'exportedAt', '${ts}',
                           'tables', (SELECT count(*) FROM push_expected),
                           'rows', (SELECT sum(n) FROM push_expected)));

COMMIT;

\\echo ''
\\echo '=== 入れ直した結果（表ごとの行数） ==='
SELECT e.table_name AS 表, e.n AS 行数 FROM push_expected e ORDER BY e.table_name;
EOF
  } > "$out"
  rm -f "$body"
  chmod 600 "$out"

  local size; size=$(du -h "$out" | cut -f1)
  log "できました: $out（$size）"
  log "表 $(echo "$counts" | wc -l) 本・PDF の保存先を消す文書 ${local_files} 件"
  log "中身は口座番号・名義・連絡先を含む。Cloud Shell へ上げて流したら、両方から消すこと"
}

# ---------------------------------------------------------------------
# 方式3：Cloud SQL Studio から落とした CSV を取り込む。
#   自動同期の経路が両方とも塞がれている環境向け。人が Studio で
#   094_export_rows.sql を流し、結果（tbl, data の2列）を CSV で落として置く。
#
#   表の構造は手元の定義（001 + 004）から作り、中身だけを CSV から入れる。
#   本番にしか無い列があれば取り込まずに止める（黙って落とさない）。
# ---------------------------------------------------------------------
import_rows() {
  assert_no_backup
  local dir="${1:-}"
  [ -n "$dir" ] || die "使い方: ops import-rows /dumps/rows"
  [ -d "$dir" ] || die "フォルダがありません: $dir"
  local all=()
  local f
  for f in "$dir"/*.csv "$dir"/*.CSV; do [ -f "$f" ] && all+=("$f"); done
  [ "${#all[@]}" -gt 0 ] || die "$dir に CSV がありません"

  # 094 の結果は見出しが tbl,data の2列。それ以外の CSV が混ざっていると、
  # 文字コードや列数の違いで分かりにくい形で落ちる。先に名指しで止める。
  local files=() others=()
  for f in "${all[@]}"; do
    # 見出しの1行だけを読む。パイプで繋ぐと、後ろが先に閉じたときに
    # 前が SIGPIPE で落ち、pipefail と set -e で何も出さずに終わる。
    local head1=""
    IFS= read -r head1 < "$f" || true
    head1=${head1#$'\xef\xbb\xbf'}   # BOM
    head1=${head1%$'\r'}              # CRLF
    head1=${head1//\"/}                # 引用符
    head1=${head1// /}                 # 空白
    if [ "${head1,,}" = "tbl,data" ]; then files+=("$f"); else others+=("$(basename "$f")"); fi
  done
  if [ "${#others[@]}" -gt 0 ]; then
    echo "094_export_rows.sql の結果ではない CSV が混ざっています（${#others[@]} 個）:" >&2
    printf '  %s\n' "${others[@]:0:10}" >&2
    [ "${#others[@]}" -gt 10 ] && echo "  … ほか $(( ${#others[@]} - 10 )) 個" >&2
    die "$dir には取り出した CSV だけを置いてください"
  fi
  log "${#files[@]} 個の CSV を取り込む"

  # 入れ替える前に、いまの中身を写しておく。
  #
  # import-rows は v3 を丸ごと作り直すので、手元で作った案件も文書も消える。
  # README には書いてあるが、消えてから気づくと戻せない（実際に案件を1件
  # 失った）。戻せる形を必ず残してから消す。戻すのは ops restore。
  backup_before_replace

  log "v3 を手元の定義から作り直す"
  psql_local -c "DROP SCHEMA IF EXISTS v3 CASCADE;" >/dev/null
  psql_local -f "$V3/001_schema.sql" >/dev/null
  psql_local -f "$V3/004_amend.sql" >/dev/null

  log "行を入れる"
  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE staging (tbl text, data jsonb);"
    for f in "${files[@]}"; do
      # Studio の CSV は見出し付きの2列。位置で読むので列名は問わない。
      printf '\\copy staging FROM %s WITH (FORMAT csv, HEADER true)\n' "'$f'"
    done
    cat <<'SQL'
-- 取り込む前に、落ちるものが無いかを確かめる。
DO $guard$
DECLARE bad text; n bigint;
BEGIN
  SELECT count(*) INTO n FROM staging;
  IF n = 0 THEN RAISE EXCEPTION 'CSV に行がありません'; END IF;
  RAISE NOTICE '  読み込んだ行 %', n;

  SELECT string_agg(DISTINCT s.tbl, ', ') INTO bad
    FROM staging s
    LEFT JOIN pg_tables t ON t.schemaname = 'v3' AND t.tablename = s.tbl
   WHERE t.tablename IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v3 に無い表が入っています: %', bad;
  END IF;

  -- 本番にあって手元の定義に無い列。黙って捨てると気づけないので止める。
  SELECT string_agg(DISTINCT s.tbl || '.' || s.k, ', ') INTO bad
    FROM (SELECT DISTINCT tbl, jsonb_object_keys(data) AS k FROM staging) s
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'v3' AND c.table_name = s.tbl AND c.column_name = s.k
   WHERE c.column_name IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '手元の定義に無い列があります（001/004 が古い）: %', bad;
  END IF;

  -- 同じ行が二度入っていないか。
  --
  -- 取り出しはページに分けて落とすので、前に落とした CSV が残っているところへ
  -- 新しいページを足すと、同じ行が重なる。そのまま入れると
  -- 「duplicate key value violates unique constraint」で落ちるが、どの CSV が
  -- 余計なのかは分からない。先に、重なった表と件数を名指しで出して止める。
  SELECT string_agg(d.tbl || ' ' || d.n || ' 件', '、' ORDER BY d.n DESC) INTO bad
    FROM (SELECT tbl, count(*) - count(DISTINCT data->>'id') AS n
            FROM staging WHERE data ? 'id'
           GROUP BY tbl HAVING count(*) <> count(DISTINCT data->>'id')) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION E'同じ行が二度入っています: %\n'
      '  取り出したページが重なっています。別の日に落とした CSV が\n'
      '  dumps/rows に残っていませんか。フォルダを空にして、094 の「1.」で\n'
      '  出たページ数のぶんを落とし直してください。', bad;
  END IF;
END
$guard$;

-- 入れる。外部キーの向きは表をまたいで循環するので、順番では解けない。
-- いったん引き金を止めて入れ、あとで参照が揃っているかを数える。
DO $load$
DECLARE r record;
BEGIN
  -- スキーマ定義は既定の行を入れる表がある（自社プロファイルなど）。
  -- 本番の中身で置き換えるので、先に空にする。
  EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('v3.%I', tablename), ', ') || ' CASCADE'
             FROM pg_tables WHERE schemaname = 'v3');

  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'v3' LOOP
    EXECUTE format('ALTER TABLE v3.%I DISABLE TRIGGER ALL', r.tablename);
  END LOOP;

  FOR r IN SELECT DISTINCT tbl FROM staging ORDER BY 1 LOOP
    EXECUTE format(
      'INSERT INTO v3.%I SELECT (jsonb_populate_record(NULL::v3.%I, s.data)).* FROM staging s WHERE s.tbl = %L',
      r.tbl, r.tbl, r.tbl);
  END LOOP;

  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'v3' LOOP
    EXECUTE format('ALTER TABLE v3.%I ENABLE TRIGGER ALL', r.tablename);
  END LOOP;
END
$load$;

-- 参照の欠け。ページを落とし損ねていると、ここで分かる。
DO $fk$
DECLARE r record; n bigint; bad text := '';
BEGIN
  FOR r IN
    SELECT cl.relname AS src, fcl.relname AS tgt, con.conname,
           (SELECT string_agg('s.' || quote_ident(a.attname), ', ' ORDER BY x.ord)
              FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS src_cols,
           (SELECT string_agg('t.' || quote_ident(a.attname), ', ' ORDER BY x.ord)
              FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS tgt_cols
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_class fcl ON fcl.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE con.contype = 'f' AND ns.nspname = 'v3'
  LOOP
    -- 参照側がすべて非 NULL の行だけが検査の対象（MATCH SIMPLE）。
    EXECUTE format(
      'SELECT count(*) FROM v3.%I s WHERE ROW(%s) IS NOT NULL'
      || ' AND NOT EXISTS (SELECT 1 FROM v3.%I t WHERE ROW(%s) = ROW(%s))',
      r.src, r.src_cols, r.tgt, r.tgt_cols, r.src_cols) INTO n;
    IF n > 0 THEN
      bad := bad || format(E'\n  %s → %s が %s 件（%s）', r.src, r.tgt, n, r.conname);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION E'参照先の無い行があります。落とし損ねたページがありませんか:%', bad;
  END IF;
END
$fk$;

-- 連番を実際の最大値の次に合わせる。ここを忘れると採番が既存とぶつかる。
DO $seq$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence('v3.' || quote_ident(c.relname), a.attname) AS seq
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'v3' AND c.relkind = 'r'
  LOOP
    IF r.seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(%I) FROM v3.%I), 0) + 1, false)',
                     r.seq, r.col, r.tbl);
    END IF;
  END LOOP;
END
$seq$;
COMMIT;
SQL
  } | psql_local >/dev/null

  log "ビューを作り直す"
  psql_local -f "$V3/002_views.sql" >/dev/null
  apply_grants

  local rows
  rows=$(psql -Atq -c "SELECT count(*) FROM v3.matters" 2>/dev/null || echo '?')
  log "取り込み完了（案件 ${rows} 件）"
  # 落としたファイルの新しいほうを、データの時点とみなす。
  local newest
  newest=$(ls -1t "${files[@]}" | head -1)
  write_stamp "$(date -r "$newest" '+%Y-%m-%d %H:%M') 取り出し"
}

# ---------------------------------------------------------------------
# 方式1：Cloud SQL Auth Proxy で直につなぐ（既定）。3307 番が通る環境向け。
# ---------------------------------------------------------------------
# ---------------------------------------------------------------------
# 連絡先と口座だけを本番の値で上書きする（098_export_contacts.sql の結果）。
#
# import-rows は全部入れ替える（TRUNCATE してから入れる）。連絡先と口座だけを
# 新しくしたいときにそれを使うと、手元で作った案件も文書も消える。こちらは
# 取引先コードで突き合わせて、住所・電話・メール・連絡先・口座だけを直す。
# 取引先そのものは作らない（手元に無いコードは飛ばして、最後に数を出す）。
# ---------------------------------------------------------------------
import_contacts() {
  assert_no_backup
  local dir="${1:-}"
  [ -n "$dir" ] || die "使い方: ops import-contacts /dumps/contacts"
  [ -d "$dir" ] || die "フォルダがありません: $dir"
  local files=() others=() f
  for f in "$dir"/*.csv "$dir"/*.CSV; do
    [ -f "$f" ] || continue
    local head1=""
    IFS= read -r head1 < "$f" || true
    head1=${head1#$'\xef\xbb\xbf'}
    head1=${head1%$'\r'}
    head1=${head1//\"/}
    head1=${head1// /}
    if [ "${head1,,}" = "tbl,data" ]; then files+=("$f"); else others+=("$(basename "$f")"); fi
  done
  if [ "${#others[@]}" -gt 0 ]; then
    echo "098_export_contacts.sql の結果ではない CSV が混ざっています（${#others[@]} 個）:" >&2
    printf '  %s\n' "${others[@]:0:10}" >&2
    die "$dir には取り出した CSV だけを置いてください"
  fi
  [ "${#files[@]}" -gt 0 ] || die "$dir に CSV がありません"
  log "${#files[@]} 個の CSV を読む"

  {
    echo "BEGIN;"
    echo "CREATE TEMP TABLE staging (tbl text, data jsonb);"
    for f in "${files[@]}"; do
      printf '\\copy staging FROM %s WITH (FORMAT csv, HEADER true)\n' "'$f'"
    done
    cat <<'SQL'
DO $guard$
DECLARE bad text; n bigint;
BEGIN
  SELECT count(*) INTO n FROM staging;
  IF n = 0 THEN RAISE EXCEPTION 'CSV に行がありません'; END IF;
  RAISE NOTICE '  読み込んだ行 %', n;

  -- この道で入れてよい表は3つだけ。ほかが混ざっていたら、取り違えなので止める。
  SELECT string_agg(DISTINCT tbl, ', ') INTO bad FROM staging
   WHERE tbl NOT IN ('parties', 'party_contacts', 'party_bank_accounts');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'この道で入れられない表が入っています: %（全部入れ替えるなら import-rows）', bad;
  END IF;

  SELECT count(*) INTO n FROM staging WHERE COALESCE(data->>'party_code', '') = '';
  IF n > 0 THEN RAISE EXCEPTION '取引先コードの無い行が % 件あります', n; END IF;
END
$guard$;

-- 突き合わせは取引先コード。id は本番と手元でずれうるので見ない。
CREATE TEMP VIEW src AS
  SELECT s.tbl, s.data, p.id AS party_id
    FROM staging s
    LEFT JOIN v3.parties p ON p.party_code = s.data->>'party_code';

DO $load$
DECLARE missing bigint; touched bigint;
BEGIN
  SELECT count(*) INTO missing FROM src WHERE party_id IS NULL;

  UPDATE v3.parties p
     SET address = src.data->>'address',
         phone   = src.data->>'phone',
         email   = src.data->>'email',
         updated_at = now()
    FROM src
   WHERE src.tbl = 'parties' AND src.party_id = p.id;
  GET DIAGNOSTICS touched = ROW_COUNT;
  RAISE NOTICE '  取引先の住所・電話・メール %', touched;

  INSERT INTO v3.party_contacts (party_id, role, name, email, phone, department)
  SELECT src.party_id, src.data->>'role', src.data->>'name', src.data->>'email',
         src.data->>'phone', src.data->>'department'
    FROM src
   WHERE src.tbl = 'party_contacts' AND src.party_id IS NOT NULL
  ON CONFLICT (party_id, role) DO UPDATE
     SET name = EXCLUDED.name, email = EXCLUDED.email,
         phone = EXCLUDED.phone, department = EXCLUDED.department;
  GET DIAGNOSTICS touched = ROW_COUNT;
  RAISE NOTICE '  連絡先 %', touched;

  INSERT INTO v3.party_bank_accounts
    (party_id, bank_name, branch_name, account_type, account_number, account_holder_kana)
  SELECT src.party_id, src.data->>'bank_name', src.data->>'branch_name',
         src.data->>'account_type', src.data->>'account_number',
         src.data->>'account_holder_kana'
    FROM src
   WHERE src.tbl = 'party_bank_accounts' AND src.party_id IS NOT NULL
  ON CONFLICT (party_id) DO UPDATE
     SET bank_name = EXCLUDED.bank_name, branch_name = EXCLUDED.branch_name,
         account_type = EXCLUDED.account_type, account_number = EXCLUDED.account_number,
         account_holder_kana = EXCLUDED.account_holder_kana, updated_at = now();
  GET DIAGNOSTICS touched = ROW_COUNT;
  RAISE NOTICE '  口座 %', touched;

  IF missing > 0 THEN
    RAISE NOTICE '  手元に無い取引先コードだったので飛ばした行 %', missing;
  END IF;
END
$load$;
COMMIT;
SQL
  } | psql_local -f - || die "取り込みに失敗した"

  apply_grants
  log "入った。件数はこのあとの確認で見られる"
  psql_local -c "SELECT
      (SELECT count(*) FROM v3.parties WHERE phone   IS NOT NULL) AS 電話あり,
      (SELECT count(*) FROM v3.parties WHERE email   IS NOT NULL) AS メールあり,
      (SELECT count(*) FROM v3.parties WHERE address IS NOT NULL) AS 住所あり,
      (SELECT count(*) FROM v3.party_contacts)      AS 連絡先,
      (SELECT count(*) FROM v3.party_bank_accounts) AS 口座;"
}

# 本番へつなぐ口を開ける。開いた先は REMOTE_HOST / REMOTE_PORT に入る。
# 写しを取るとき（sync）と、読むだけの照会を流すとき（sql-prod）の両方で使う。
open_remote() {
  [ -n "${SYNC_DB_PASSWORD:-}" ] || die "SYNC_DB_PASSWORD が空です（.env）"

  # つなぎに行く先。既定はこのコンテナが上げる Proxy。
  # 社内ネットワークが 3307 番を塞いでいる場合は、Proxy を PC 側で動かして
  # SYNC_DB_HOST=host.docker.internal を .env に書く（README「Proxy を PC 側で動かす」）。
  local host="${SYNC_DB_HOST:-127.0.0.1}" port="${SYNC_DB_PORT:-5433}"
  local proxy=""

  if [ -n "${SYNC_DB_HOST:-}" ]; then
    log "PC 側の Proxy を使う（$host:$port）"
    pg_isready -h "$host" -p "$port" -q || die "$host:$port につながりません。PC 側で Proxy が動いていますか"
  else
    [ -n "${CLOUD_SQL_INSTANCE:-}" ] || die "CLOUD_SQL_INSTANCE が空です（.env）"
    # 認証情報は 2 通り。サービスアカウントの鍵（sa.json）か、gcloud でログインした
    # 人の認証情報（adc.json = application_default_credentials.json の写し）。
    # 組織ポリシーで鍵が作れないときは後者を使う。
    local cred
    if [ -f /keys/sa.json ]; then cred=/keys/sa.json
    elif [ -f /keys/adc.json ]; then cred=/keys/adc.json
    else die "keys/sa.json も keys/adc.json もありません（README の「事前準備」）"; fi
    local project="${CLOUD_SQL_INSTANCE%%:*}"

    log "Cloud SQL Auth Proxy を上げる（$cred）"
    # 人の認証情報のときは Admin API の課金・割当先の指定が要る（--quota-project）。
    cloud-sql-proxy --credentials-file="$cred" --quota-project "$project" \
      --port "$port" "$CLOUD_SQL_INSTANCE" > /tmp/proxy.log 2>&1 &
    proxy=$!
    # 途中で落ちても Proxy を残さない。trap は関数を抜けたあとに走るので、
    # 関数の中だけの変数ではなく REMOTE_PROXY を見る。
    REMOTE_PROXY="$proxy"
    trap 'kill ${REMOTE_PROXY:-0} 2>/dev/null || true' EXIT
    for _ in $(seq 1 30); do
      pg_isready -h "$host" -p "$port" -q && break
      sleep 1
    done
    if ! pg_isready -h "$host" -p "$port" -q; then
      echo "--- proxy log ---" >&2; tail -n 5 /tmp/proxy.log >&2
      if grep -q "connection refused\|i/o timeout" /tmp/proxy.log; then
        echo >&2
        echo "Cloud SQL の 3307 番へ届いていません。社内ネットワークがこの番号を" >&2
        echo "塞いでいる可能性があります。ログの IP を使って確かめてください:" >&2
        echo "  docker compose run --rm ops netcheck <ログに出た IP> 3307" >&2
        echo "PC からは通るなら、Proxy を PC 側で動かせます（README を見てください）。" >&2
      fi
      die "Proxy がつながりません"
    fi
  fi
  REMOTE_HOST="$host"; REMOTE_PORT="$port"; REMOTE_PROXY="$proxy"
}

# 開けた口を閉じる。PC 側の Proxy を使っているときは何もしない。
close_remote() {
  [ -n "${REMOTE_PROXY:-}" ] && kill "$REMOTE_PROXY" 2>/dev/null || true
  REMOTE_PROXY=""
  trap - EXIT
}

sync_proxy() {
  mkdir -p "$DUMPS"
  open_remote
  local host="$REMOTE_HOST" port="$REMOTE_PORT" proxy="$REMOTE_PROXY"

  local file="$DUMPS/v3_$(date '+%Y%m%d_%H%M').dump"
  log "本番の v3 スキーマを写す → $file"
  # 所有者と権限は持ち込まない（本番だけにあるロールで復元が止まるのを避ける）。
  if ! PGPASSWORD="$SYNC_DB_PASSWORD" pg_dump -h "$host" -p "$port" -U "$SYNC_DB_USER" -d "$REMOTE_DB_NAME" \
      -n v3 -Fc --no-owner --no-privileges -f "$file"; then
    rm -f "$file"
    if [ -n "$proxy" ]; then echo "--- proxy log ---" >&2; tail -n 20 /tmp/proxy.log >&2; fi
    die "写しを取れませんでした（上のログを見る。認証切れなら README の「同期が失敗するとき」）"
  fi
  [ -n "$proxy" ] && kill $proxy 2>/dev/null || true
  trap - EXIT
  log "写し完了（$(du -h "$file" | cut -f1)）"

  restore "$file"
  prune
}

# 古い写しを消す。KEEP_DUMPS 世代だけ残す。
prune() {
  # 名前に時点が入っているので名前で並べる（更新日時は写した日ではない）。
  ls -1 "$DUMPS"/v3_* 2>/dev/null | sort -r | tail -n +"$((KEEP_DUMPS + 1))" | while read -r old; do
    log "古い写しを消す: $old"; rm -f "$old"
  done
}

# 本番データなしの開発用。V1 相当の模擬 public を置き、本番と同じ手順（スキーマ→移行→後追い変更）で作る。
fresh() {
  assert_no_backup
  log "開発用 DB を作り直す（本番データは使わない）"
  psql_local -c "DROP SCHEMA IF EXISTS v3 CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null
  psql_local -f "$V3/testdata/mock_public.sql" >/dev/null
  # 003（権限）は 004 で足した表も対象にするので、004 の後に当てる。
  for f in 001_schema 002_views 010_migrate_master 020_migrate_core 030_migrate_matters 040_migrate_documents 004_amend; do
    psql_local -f "$V3/$f.sql" >/dev/null
  done
  apply_grants
  write_stamp "開発用の模擬データ"
  log "完了。READ_ONLY=false にすると書き込みも試せる"
}

status() {
  echo "写し（$DUMPS）:"
  ls -lh "$DUMPS"/v3_* 2>/dev/null | awk '{print "  " $9 "  " $5}' || echo "  なし"
  echo "いま入っているデータの時点: $(cat "$STAMP" 2>/dev/null || echo '不明（まだ入れていない）')"
  psql -Atq -c "SELECT '案件 ' || count(*) || ' 件' FROM v3.matters" 2>/dev/null || echo "v3 スキーマがまだありません"
}

# 同期は Google の2つの口を使う。コンテナから届くかをここで切り分ける
# （Windows の gcloud が塞がれていても、コンテナは通ることがある。逆もある）。
netcheck() {
  local ng=0
  for host in oauth2.googleapis.com sqladmin.googleapis.com; do
    printf '%-34s ' "$host:443"
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$host/" 2>/dev/null) || code=""
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      echo "OK (HTTP $code)"
    else
      echo "つながりません"
      ng=1
    fi
  done

  # 追加の TCP 確認。Cloud SQL の実体は 3307 番を使う。443 が通っても
  # ここが塞がれていると Proxy は使えないので、番号ごとに分けて見る。
  if [ -n "${1:-}" ] && [ -n "${2:-}" ]; then
    printf '%-34s ' "$1:$2"
    if nc -z -w 10 "$1" "$2" 2>/dev/null; then
      echo "OK (つながる)"
    else
      echo "つながりません"
      ng=1
    fi
  fi

  if [ "$ng" = 1 ]; then
    echo
    echo "塞がれている口があります。README の「gcloud も Proxy も通らないとき」を見てください。"
    return 1
  fi
  echo
  echo "確かめた口はすべて通っています。"
}

# 写しの取り方は2通り。3307 番が通るかで決まる（既定は proxy）。
sync() {
  assert_no_backup
  case "${SYNC_MODE:-proxy}" in
    proxy)  sync_proxy ;;
    export) sync_export ;;
    *) die "SYNC_MODE は proxy か export です: ${SYNC_MODE}" ;;
  esac
}

# 読むだけの照会を本番へ流す。
#
#   棚卸しの照会は本番でも同じものを流したい。Cloud SQL Studio は \set も
#   \echo も効かないので、そのたびに手で書き換えることになっていた。
#
#   書き込みは口ごと閉じる（default_transaction_read_only）。照会に UPDATE が
#   紛れ込んでいても本番では実行されない。つなぐのも写しを取る役（読み取り
#   専用のロール）なので、二重に守られる。
sql_prod() {
  local file="${1:-}"; shift || true
  [ -n "$file" ] || die "使い方: ops sql-prod /v3/diag/orphan-documents.sql [名前=値 ...]"
  local vars=()
  local pair
  for pair in "$@"; do
    case "$pair" in
      *=*) vars+=(-v "$pair") ;;
      *) die "変数は 名前=値 の形で渡す（例: q=取引先名）" ;;
    esac
  done
  open_remote
  log "本番へ読み取り専用でつなぐ（$SYNC_DB_USER@$REMOTE_HOST:$REMOTE_PORT/$REMOTE_DB_NAME）"
  local rc=0
  PGPASSWORD="$SYNC_DB_PASSWORD" \
  PGOPTIONS="-c default_transaction_read_only=on -c client_min_messages=warning" \
    psql -h "$REMOTE_HOST" -p "$REMOTE_PORT" -U "$SYNC_DB_USER" -d "$REMOTE_DB_NAME" \
         -v ON_ERROR_STOP=1 "${vars[@]+"${vars[@]}"}" -f "$file" || rc=$?
  close_remote
  [ "$rc" -eq 0 ] || die "照会が止まりました（上のエラーを見る）"
}

# ---------------------------------------------------------------------
# 予備系で書く → 本番へ持ち帰る（docs/v3-backup-merge.md）。
#
#   push-export は「本番が写しの時点から変わっていない」ときだけ使える（丸ごと入れ直す）。
#   こちらは本番にも書き込みがあってよい。予備系で書いた変更を行ごとに記録しておき、
#   本番では行ごとに 3 方向（写し・ローカル・本番のいま）で比べて入れる。
#
#   backup-begin   記録を始める。v3 の表に記録の引き金を付け、id を予備系の帯（10 億〜）へ
#                  進める。文書番号などはアプリの番号帯（NUMBER_BAND=backup、9000 番台）
#   backup-export  記録を行ごとにまとめ、本番で流す SQL 1 本にする（/dumps/merge/）
#   backup-close   記録を閉じる（引き金を外す）。持ち帰った後（merged）か、捨てるとき（discard）
# ---------------------------------------------------------------------
backup_begin() {
  psql -Atq -c "SELECT 1 FROM v3.matters LIMIT 1" >/dev/null 2>&1 || die "v3 スキーマがありません。先に写しを入れてください"
  [ -f "$LOCAL_SQL/backup_begin.sql" ] || die "$LOCAL_SQL/backup_begin.sql がありません（docker compose の ops に ./sql を入れる）"
  local stamp; stamp=$(cat "$STAMP" 2>/dev/null || echo "")
  log "予備系で書き始める（写しの時点: ${stamp:-不明}）"
  psql_local -v data_stamp="$stamp" -v started_by="${LOCAL_USER_EMAIL:-ops}" -f "$LOCAL_SQL/backup_begin.sql"
  log "ここから先のローカルの変更を記録します。書き込むには .env を READ_ONLY=false にして docker compose up -d app"
  log "本番が戻ったら ops backup-export で持ち帰る SQL を作る"
}

# 記録を行ごとにまとめる（同じ行を何度直しても、写しの値と最後の値の 1 組にする）。
#   足して消した行は持ち帰らない。直して元に戻した行も持ち帰らない。
backup_net_sql() {
  cat <<SQL
WITH c AS (SELECT * FROM backup.changes WHERE session_id = $1),
g AS (
  SELECT table_name, pk,
         (array_agg(old ORDER BY seq))[1]      AS old,
         (array_agg(new ORDER BY seq DESC))[1] AS new,
         (array_agg(op ORDER BY seq))[1]       AS first_op,
         (array_agg(op ORDER BY seq DESC))[1]  AS last_op,
         max(seq) AS last_seq, max(at) AS last_at
    FROM c GROUP BY table_name, pk),
n AS (
  SELECT table_name, pk, old, new, last_seq, last_at,
         CASE WHEN first_op = 'I' AND last_op = 'D' THEN NULL
              WHEN first_op = 'I' THEN 'I'
              WHEN last_op = 'D' THEN 'D'
              ELSE 'U' END AS op
    FROM g)
SELECT row_number() OVER (ORDER BY last_seq) AS no, table_name, op, pk,
       CASE WHEN op IN ('U', 'D') THEN old END AS old,
       CASE WHEN op IN ('I', 'U') THEN new END AS new,
       CASE WHEN op = 'U' THEN (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(new) k
                                 WHERE (old -> k) IS DISTINCT FROM (new -> k)) END AS cols,
       last_at
  FROM n
 WHERE op IS NOT NULL AND NOT (op = 'U' AND old = new)
SQL
}

# 停止中に表を足す移行 SQL（172 など）を流したあとに。引き金の無い表に付け、いまの行を記録する。
backup_attach() {
  [ -f "$LOCAL_SQL/backup_attach.sql" ] || die "$LOCAL_SQL/backup_attach.sql がありません"
  local sid; sid=$(backup_session)
  [ -n "$sid" ] || die "予備系の書き込みは始まっていません"
  psql -v ON_ERROR_STOP=1 -f "$LOCAL_SQL/backup_attach.sql"
}

backup_status() {
  local sid; sid=$(backup_session)
  if [ -z "$sid" ]; then
    echo "予備系の書き込みは始まっていません（ops backup-begin で始める）。"
    psql -Atq -c "SELECT '最後の記録: ' || id || '（' || to_char(started_at, 'YYYY-MM-DD HH24:MI') || ' 〜 ' || to_char(closed_at, 'YYYY-MM-DD HH24:MI') || '、' || COALESCE(note, '') || '）' FROM backup.sessions ORDER BY id DESC LIMIT 1" 2>/dev/null || true
    return 0
  fi
  psql_local -c "SELECT id AS 記録, to_char(started_at, 'YYYY-MM-DD HH24:MI') AS 始めた, data_stamp AS 写しの時点,
                        to_char(exported_at, 'YYYY-MM-DD HH24:MI') AS 最後に書き出した,
                        (SELECT count(*) FROM backup.changes WHERE session_id = s.id) AS 記録した変更
                   FROM backup.sessions s WHERE id = $sid"
  echo "持ち帰る行（表ごと。同じ行の変更は 1 つにまとめた数）:"
  psql_local -c "SELECT table_name AS 表,
                        count(*) FILTER (WHERE op = 'I') AS 足した,
                        count(*) FILTER (WHERE op = 'U') AS 直した,
                        count(*) FILTER (WHERE op = 'D') AS 消した
                   FROM ($(backup_net_sql "$sid")) x GROUP BY table_name ORDER BY table_name"
}

backup_export() {
  local sid; sid=$(backup_session)
  [ -n "$sid" ] || die "予備系の書き込みが始まっていません（持ち帰るものがありません）"
  [ -f "$LOCAL_SQL/merge_apply.sql" ] || die "$LOCAL_SQL/merge_apply.sql がありません"
  local dir="$DUMPS/merge" ts out n
  ts=$(date +%Y%m%d_%H%M)
  mkdir -p "$dir"
  out="$dir/v3_merge_${ts}.sql"
  n=$(psql -Atq -c "SELECT count(*) FROM ($(backup_net_sql "$sid")) x")
  [ "${n:-0}" -gt 0 ] || die "持ち帰る変更がありません"
  local stamp; stamp=$(psql -Atq -c "SELECT COALESCE(data_stamp, '') FROM backup.sessions WHERE id = $sid")

  log "予備系の変更をまとめる（記録 ${sid}、${n} 行）"
  {
    cat <<EOF
-- =====================================================================
-- 予備系で書いた変更を本番へ持ち帰る（ops backup-export が ${ts} に作成）
--
--   記録: ${sid}（写しの時点: ${stamp:-不明}）、持ち帰る行: ${n}
--   流すのは Cloud Shell の psql（postgres ロール）。Studio では流せない。手順: docs/v3-backup-merge.md
--
--   まず試す（何も変えない）:
--     psql -f $(basename "$out")
--   ぶつかりが無ければ確定する:
--     psql -v merge_mode=apply -f $(basename "$out")
--   ぶつかった行は番号で選んで流し直す（本番を正 / ローカルを正）:
--     psql -v merge_skip=12,57 -v merge_force=33 -f $(basename "$out")
--
--   口座番号・名義・連絡先を含むことがある。流し終えたら Cloud Shell とローカルの両方から消す。
-- =====================================================================
\\set ON_ERROR_STOP on
\\set QUIET on
\\pset pager off
\\if :{?merge_mode}
\\else
  \\set merge_mode check
\\endif
\\if :{?merge_skip}
\\else
  \\set merge_skip ''
\\endif
\\if :{?merge_force}
\\else
  \\set merge_force ''
\\endif
\\if :{?merge_db}
\\else
  \\set merge_db legalbridge
\\endif
\\set merge_session '${sid}'
\\set merge_exported_at '${ts}'
SELECT :'merge_mode' IN ('check', 'apply') AS merge_mode_ok \\gset
\\if :merge_mode_ok
\\else
  \\echo 'merge_mode は check か apply です。何も変えていません。'
  \\quit
\\endif
\\echo '持ち帰り: ' :merge_mode '（記録 ${sid}、${n} 行）'

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TEMP TABLE merge_changes (
  no int PRIMARY KEY, table_name text NOT NULL, op text NOT NULL, pk jsonb NOT NULL,
  old jsonb, new jsonb, cols text[], last_at timestamptz
) ON COMMIT DROP;
COPY merge_changes FROM stdin;
EOF
    psql -Atq -c "COPY ($(backup_net_sql "$sid")) TO STDOUT"
    echo '\.'
    cat <<'EOF'

CREATE TEMP TABLE merge_local_columns (table_name text, column_name text) ON COMMIT DROP;
COPY merge_local_columns FROM stdin;
EOF
    psql -Atq -c "COPY (SELECT c.table_name, c.column_name FROM information_schema.columns c
                         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                        WHERE c.table_schema = 'v3' AND t.table_type = 'BASE TABLE'
                        ORDER BY 1, 2) TO STDOUT"
    echo '\.'
    echo
    cat "$LOCAL_SQL/merge_apply.sql"
  } > "$out"
  chmod 600 "$out"
  psql -Atq -c "UPDATE backup.sessions SET exported_at = now() WHERE id = $sid" >/dev/null

  local size; size=$(du -h "$out" | cut -f1)
  log "できました: $out（$size）"
  backup_status
  log "Cloud Shell へ上げ、まず merge_mode を付けずに（試すだけ）流す。手順: docs/v3-backup-merge.md"
  log "書き出した後も予備系に書いたら、もう一度 backup-export する（同じ記録をまとめ直す。入れ済みの行は「本番でもう同じ」になる）"
}

backup_close() {
  local how="${1:-}" sid
  case "$how" in
    merged)  ;;
    discard) ;;
    *) die "使い方: ops backup-close merged（本番へ持ち帰った後）| discard（持ち帰らずに捨てる）" ;;
  esac
  sid=$(backup_session)
  [ -n "$sid" ] || die "予備系の書き込みは始まっていません"
  log "記録 ${sid} を閉じる（${how}）。v3 の表から記録の引き金を外す"
  psql_local <<SQL
BEGIN;
DO \$drop\$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_trigger tg
             JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'v3' AND tg.tgname = 'zz_backup_capture' LOOP
    EXECUTE format('DROP TRIGGER zz_backup_capture ON v3.%I', r.relname);
  END LOOP;
END
\$drop\$;
UPDATE backup.sessions SET closed_at = now(), note = '${how}' WHERE id = ${sid};
COMMIT;
SQL
  if [ "$how" = "merged" ]; then
    log "閉じました。次に写しを入れ直すと、本番（持ち帰った分を含む）の中身になります"
  else
    log "閉じました（捨てた）。予備系で書いた分は持ち帰りません。写しを入れ直すと消えます"
  fi
}

case "${1:-}" in
  netcheck) shift; netcheck "$@" ;;
  sync) sync ;;
  export-info) export_info ;;
  import-rows) shift; import_rows "${1:-}" ;;
  import-contacts) shift; import_contacts "${1:-}" ;;
  restore) [ -n "${2:-}" ] || die "使い方: ops restore /dumps/v3_YYYYmmdd_HHMM.dump"; restore "$2" ;;
  fresh) fresh ;;
  grants) apply_grants ;;
  upgrade) upgrade ;;
  sql-prod) shift; sql_prod "$@" ;;
  sql) [ -n "${2:-}" ] || die "使い方: ops sql /v3/095_diagnose_condition.sql [名前=値 ...]"
       # 3つ目以降は SQL に渡す変数（名前=値）。照会の中で :'名前' と書いた
       # ところに入る。ファイルは読み取り専用で入っているので、探す語を
       # 変えるたびに PC 側のファイルを書き換えなくて済むようにする。
       sql_file="$2"; shift 2
       sql_vars=()
       for pair in "$@"; do
         case "$pair" in
           *=*) sql_vars+=(-v "$pair") ;;
           *) die "変数は 名前=値 の形で渡す（例: q=取引先名）" ;;
         esac
       done
       psql -v ON_ERROR_STOP=1 "${sql_vars[@]+"${sql_vars[@]}"}" -f "$sql_file" ;;
  push-export) push_export ;;
  backup-begin) backup_begin ;;
  backup-status) backup_status ;;
  backup-attach) backup_attach ;;
  backup-export) backup_export ;;
  backup-close) shift; backup_close "${1:-}" ;;
  status) status ;;
  *) sed -n '2,32p' "$0"; exit 2 ;;
esac
