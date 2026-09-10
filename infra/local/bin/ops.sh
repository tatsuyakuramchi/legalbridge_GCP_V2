#!/usr/bin/env bash
# 予備系の作業スクリプト。ops コンテナの中で走る（ホストに psql は要らない）。
#
#   ops sync              本番 v3 スキーマを写してローカル DB に入れる（平時に毎晩）
#   ops export-info       エクスポート方式（SYNC_MODE=export）の準備に要る値を出す
#   ops import-rows <dir> Studio から落とした CSV を取り込む（094_export_rows.sql の結果）
#   ops restore <file>    手元の写し（/dumps/…）をローカル DB に入れ直す
#   ops fresh             本番データなしで開発用 DB を作る（模擬データ）
#   ops grants            ランタイムロールの権限を当て直す
#   ops upgrade           手元の DB を今のスキーマに合わせる（列を足したあと）
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
DATA="${DATA:-/data}"
STAMP="$DATA/SYNC_STAMP"
V3="${V3:-/v3}"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

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
restore() {
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
# 方式3：Cloud SQL Studio から落とした CSV を取り込む。
#   自動同期の経路が両方とも塞がれている環境向け。人が Studio で
#   094_export_rows.sql を流し、結果（tbl, data の2列）を CSV で落として置く。
#
#   表の構造は手元の定義（001 + 004）から作り、中身だけを CSV から入れる。
#   本番にしか無い列があれば取り込まずに止める（黙って落とさない）。
# ---------------------------------------------------------------------
import_rows() {
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
sync_proxy() {
  [ -n "${SYNC_DB_PASSWORD:-}" ] || die "SYNC_DB_PASSWORD が空です（.env）"
  mkdir -p "$DUMPS"

  # 写しを取りに行く先。既定はこのコンテナが上げる Proxy。
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
    trap 'kill $proxy 2>/dev/null || true' EXIT
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
  case "${SYNC_MODE:-proxy}" in
    proxy)  sync_proxy ;;
    export) sync_export ;;
    *) die "SYNC_MODE は proxy か export です: ${SYNC_MODE}" ;;
  esac
}

case "${1:-}" in
  netcheck) shift; netcheck "$@" ;;
  sync) sync ;;
  export-info) export_info ;;
  import-rows) shift; import_rows "${1:-}" ;;
  restore) [ -n "${2:-}" ] || die "使い方: ops restore /dumps/v3_YYYYmmdd_HHMM.dump"; restore "$2" ;;
  fresh) fresh ;;
  grants) apply_grants ;;
  upgrade) upgrade ;;
  status) status ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
