#!/usr/bin/env bash
# 本番の v3 を手作業で写す（Cloud Shell 用）。予備系（ローカル版）に入れるための写し。
#
#   自動同期（ops sync）は社内ネットワークが 3307 番を塞いでいるので使えない。
#   Cloud Shell は Google の中にいるので Cloud SQL に届く。ここで pg_dump を取り、
#   ブラウザで PC に落として ops restore で入れる。PC 側の通信はブラウザ（443）だけ。
#
#   写しの形は ops sync と同じ（-n v3 -Fc --no-owner --no-privileges、
#   名前は v3_YYYYmmdd_HHMM.dump）。ops restore・ops status・世代の整理がそのまま使える。
#
# 使い方（Cloud Shell、リポジトリの直下で）:
#   infra/gcp/backup-v3-dump.sh
#   → ~/v3_YYYYmmdd_HHMM.dump ができ、PC へのダウンロードが始まる
#
# 変えられるもの:
#   PGUSER=legalbridge_v3_backup   つなぐロール（既定。読み取り専用。パスワードは
#                                  infra/local/.env の SYNC_DB_PASSWORD と同じ）
#   PGUSER=postgres                管理ロールで取る場合
#   PGPASSWORD=...                 先に export してあれば聞かない
#   PORT=5432                      Proxy の待ち受け（start-sql-proxy.sh と同じ）
#   OUT_DIR=~                      写しを置く場所
#   PG_DUMP=docker|local           pg_dump の出どころ（既定 docker）
#     docker: postgres:17-alpine の pg_dump。予備系の pg_restore（17）と同じ版なので
#             取った写しが必ず読める。Cloud Shell の pg_dump は版が合わないことがある
#     local : Cloud Shell に入っている pg_dump
#   NO_DOWNLOAD=1                  ダウンロードを始めない（あとで cloudshell download）
#   KEEP_REMOTE=1                  落としたあとも Cloud Shell に写しを残す（既定は聞く）

set -euo pipefail

cd "$(dirname "$0")/../.."

PORT="${PORT:-5432}"
OUT_DIR="${OUT_DIR:-$HOME}"
PG_DUMP="${PG_DUMP:-docker}"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"

export PGHOST=127.0.0.1
export PGPORT="$PORT"
export PGDATABASE="${PGDATABASE:-legalbridge}"
export PGUSER="${PGUSER:-legalbridge_v3_backup}"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 1. Proxy。トークンは 1 時間で切れるので、毎回貼り直してから取る。
log "Cloud SQL Auth Proxy を貼り直す"
PORT="$PORT" infra/gcp/start-sql-proxy.sh >/dev/null \
  || die "Proxy を起動できませんでした（docs/v3-deploy-cloudshell.md の B を見る）"

# 2. パスワード。履歴に残さないように聞く。
if [ -z "${PGPASSWORD:-}" ]; then
  read -rsp "${PGUSER} のパスワード: " PGPASSWORD; echo
  export PGPASSWORD
fi

command -v psql >/dev/null || die "psql がありません"
psql -Atq -c "SELECT 1" >/dev/null 2>&1 \
  || die "${PGUSER} でつなげません（パスワード、または Proxy のログ /tmp/cloud-sql-proxy.log を見る）"

matters=$(psql -Atq -c "SELECT count(*) FROM v3.matters") \
  || die "v3.matters を読めません。v3 に表を足したあとなら sql/backup_role.sql の GRANT を流し直す"
server_major=$(psql -Atq -c "SHOW server_version_num")
server_major=$((server_major / 10000))

stamp="$(TZ=Asia/Tokyo date '+%Y%m%d_%H%M')"
name="v3_${stamp}.dump"
file="${OUT_DIR}/${name}"

# 3. 写す。形は ops sync と同じ。
log "本番の v3 を写す（案件 ${matters} 件、サーバ ${server_major} 系）→ ${file}"
dump_args=(-n v3 -Fc --no-owner --no-privileges)
case "$PG_DUMP" in
  docker)
    docker info >/dev/null 2>&1 || die "docker が使えません。PG_DUMP=local で Cloud Shell の pg_dump を使う"
    tool_major=$(docker run --rm "$PG_IMAGE" pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')
    [ "$tool_major" -ge "$server_major" ] \
      || die "${PG_IMAGE} の pg_dump（${tool_major}）がサーバ（${server_major}）より古い。予備系の postgres も上げる必要がある"
    # Cloud Shell のユーザで書かせる（root で書くと rm できなくなる）。
    docker run --rm --network host --user "$(id -u):$(id -g)" \
      -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
      -v "${OUT_DIR}:/out" "$PG_IMAGE" \
      pg_dump "${dump_args[@]}" -f "/out/${name}" \
      || { rm -f "$file"; die "写しを取れませんでした"; }
    ;;
  local)
    command -v pg_dump >/dev/null || die "pg_dump がありません。PG_DUMP=docker を使う"
    tool_major=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')
    [ "$tool_major" -ge "$server_major" ] \
      || die "pg_dump（${tool_major}）がサーバ（${server_major}）より古い。PG_DUMP=docker を使う"
    [ "$tool_major" -le 17 ] \
      || echo "注意: pg_dump ${tool_major} の写しは、予備系の pg_restore 17 で読めないことがある。PG_DUMP=docker を勧める" >&2
    pg_dump "${dump_args[@]}" -f "$file" || { rm -f "$file"; die "写しを取れませんでした"; }
    ;;
  *) die "PG_DUMP は docker か local です: ${PG_DUMP}" ;;
esac

# 4. 中身を確かめる（ops restore と同じ見方）。
[ -s "$file" ] || die "写しが空です: ${file}"
if [ "$PG_DUMP" = docker ]; then
  listing=$(docker run --rm -v "${OUT_DIR}:/out" "$PG_IMAGE" pg_restore --list "/out/${name}")
else
  listing=$(pg_restore --list "$file")
fi
grep "SCHEMA - v3" >/dev/null <<<"$listing" || die "v3 スキーマの写しになっていません: ${file}"
tables=$(grep -c " TABLE DATA v3 " <<<"$listing" || true)
log "写し完了（$(du -h "$file" | cut -f1)、表 ${tables} 個）"

cat <<EOF

────────────────────────────────────────
写し: ${file}
  案件 ${matters} 件／データの時点 ${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}（日本時間）

★ 口座情報・個人情報が入っている。チャットや issue に貼らない。

PC（PowerShell、infra\\local で）での入れ方:
  Move-Item "\$HOME\\Downloads\\${name}" dumps\\
  docker compose run --rm ops restore /dumps/${name}
  docker compose run --rm ops status
────────────────────────────────────────
EOF

# 5. PC へ落とす。cloudshell download はブラウザのダウンロードを開く。
if [ -z "${NO_DOWNLOAD:-}" ]; then
  if command -v cloudshell >/dev/null; then
    log "PC へのダウンロードを始める（ブラウザに確認が出たら許可する）"
    cloudshell download "$file" || echo "始められませんでした。右上「︙」→「ダウンロード」で ${file} を指定する" >&2
  else
    echo "Cloud Shell の外です。${file} を自分で PC に写してください。"
  fi
fi

# 6. Cloud Shell に本番の写しを置きっぱなしにしない。
if [ -z "${KEEP_REMOTE:-}" ]; then
  echo
  read -rp "PC に落とし終えたら Enter（Cloud Shell の写しを消す。残すなら n）: " ans
  if [ "${ans:-}" != "n" ]; then
    rm -f "$file"
    log "Cloud Shell の写しを消しました"
  else
    echo "残しました。不要になったら rm ${file}"
  fi
fi
