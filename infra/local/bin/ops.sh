#!/usr/bin/env bash
# 予備系の作業スクリプト。ops コンテナの中で走る（ホストに psql は要らない）。
#
#   ops sync              本番 v3 スキーマを写してローカル DB に入れる（平時に毎晩）
#   ops restore <file>    手元の写し（/dumps/…）をローカル DB に入れ直す
#   ops fresh             本番データなしで開発用 DB を作る（模擬データ）
#   ops grants            ランタイムロールの権限を当て直す
#   ops status            写しの一覧と、いま入っているデータの時点
#   ops netcheck [host port]
#                         同期に要る Google の口へ、コンテナから届くかを見る。
#                         host port を足すと、そこへの TCP 接続も試す
#                         （例: ops netcheck 34.146.158.194 3307）
#
# ローカル DB への接続は PGHOST / PGUSER / PGPASSWORD / PGDATABASE（compose が渡す）。
set -euo pipefail

# Windows で .env を書くと行末に CR が付くことがある。パスワードに紛れ込むと本番に
# つながらないので、ここで落とす。
for v in SYNC_DB_PASSWORD SYNC_DB_USER CLOUD_SQL_INSTANCE REMOTE_DB_NAME KEEP_DUMPS PGPASSWORD; do
  eval "$v=\${$v%\$'\r'}"
done

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

restore() {
  local file="$1"
  [ -f "$file" ] || die "写しが見つかりません: $file"
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
  apply_grants
  local rows
  rows=$(psql -Atq -c "SELECT count(*) FROM v3.matters" 2>/dev/null || echo '?')
  log "入れ替え完了（案件 ${rows} 件）"
  write_stamp "$(stamp_of "$file")"
}

sync() {
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
    [ -n "$proxy" ] && { echo "--- proxy log ---" >&2; tail -n 20 /tmp/proxy.log >&2; }
    die "写しを取れませんでした（上のログを見る。認証切れなら README の「同期が失敗するとき」）"
  fi
  [ -n "$proxy" ] && kill $proxy 2>/dev/null || true
  trap - EXIT
  log "写し完了（$(du -h "$file" | cut -f1)）"

  restore "$file"

  # 古い写しを消す。KEEP_DUMPS 世代だけ残す。
  # 名前に時点が入っているので名前で並べる（更新日時は写した日ではない）。
  ls -1 "$DUMPS"/v3_*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP_DUMPS + 1))" | while read -r old; do
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
  ls -lh "$DUMPS"/v3_*.dump 2>/dev/null | awk '{print "  " $9 "  " $5}' || echo "  なし"
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

case "${1:-}" in
  netcheck) shift; netcheck "$@" ;;
  sync) sync ;;
  restore) [ -n "${2:-}" ] || die "使い方: ops restore /dumps/v3_YYYYmmdd_HHMM.dump"; restore "$2" ;;
  fresh) fresh ;;
  grants) apply_grants ;;
  status) status ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
