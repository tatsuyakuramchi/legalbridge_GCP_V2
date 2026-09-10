#!/usr/bin/env bash
# 予備系の作業スクリプト。ops コンテナの中で走る（ホストに psql は要らない）。
#
#   ops sync              本番 v3 スキーマを写してローカル DB に入れる（平時に毎晩）
#   ops restore <file>    手元の写し（/dumps/…）をローカル DB に入れ直す
#   ops fresh             本番データなしで開発用 DB を作る（模擬データ）
#   ops grants            ランタイムロールの権限を当て直す
#   ops status            写しの一覧と、いま入っているデータの時点
#
# ローカル DB への接続は PGHOST / PGUSER / PGPASSWORD / PGDATABASE（compose が渡す）。
set -euo pipefail

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
  [ -n "${CLOUD_SQL_INSTANCE:-}" ] || die "CLOUD_SQL_INSTANCE が空です（.env）"
  [ -n "${SYNC_DB_PASSWORD:-}" ] || die "SYNC_DB_PASSWORD が空です（.env）"
  [ -f /keys/sa.json ] || die "/keys/sa.json（Cloud SQL Client 権限のサービスアカウント鍵）がありません"
  mkdir -p "$DUMPS"

  log "Cloud SQL Auth Proxy を上げる"
  cloud-sql-proxy --credentials-file=/keys/sa.json --port 5433 "$CLOUD_SQL_INSTANCE" \
    > /tmp/proxy.log 2>&1 &
  local proxy=$!
  trap 'kill $proxy 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p 5433 -q && break
    sleep 1
  done
  pg_isready -h 127.0.0.1 -p 5433 -q || { cat /tmp/proxy.log >&2; die "Proxy がつながりません"; }

  local file="$DUMPS/v3_$(date '+%Y%m%d_%H%M').dump"
  log "本番の v3 スキーマを写す → $file"
  # 所有者と権限は持ち込まない（本番だけにあるロールで復元が止まるのを避ける）。
  PGPASSWORD="$SYNC_DB_PASSWORD" pg_dump -h 127.0.0.1 -p 5433 -U "$SYNC_DB_USER" -d "$REMOTE_DB_NAME" \
    -n v3 -Fc --no-owner --no-privileges -f "$file"
  kill $proxy 2>/dev/null || true
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

case "${1:-}" in
  sync) sync ;;
  restore) [ -n "${2:-}" ] || die "使い方: ops restore /dumps/v3_YYYYmmdd_HHMM.dump"; restore "$2" ;;
  fresh) fresh ;;
  grants) apply_grants ;;
  status) status ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
