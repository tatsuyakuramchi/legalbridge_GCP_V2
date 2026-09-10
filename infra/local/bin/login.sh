#!/usr/bin/env bash
# 同期に使う認証情報を、コンテナの中で取る。
#
# Windows の gcloud が接続エラーで落ちる環境向け。ブラウザを開く役だけを PC に任せ、
# 引き換え（トークンの取得）はコンテナが行う。PC 側は Google への接続をしない。
#
#   docker compose run --rm login
#
# 手順は画面に出る:
#   1. 表示された長いコマンドを PC の PowerShell に貼って実行する
#   2. ブラウザが開くのでログインして許可する
#   3. PC の画面に出た長い URL をここに貼って Enter
set -euo pipefail

PROJECT="${CLOUDSDK_CORE_PROJECT:?プロジェクトが未設定です}"
OUT=/keys/adc.json

echo "== 同期用の認証情報を取ります（プロジェクト: $PROJECT）"
echo "   PC 側では gcloud がブラウザを開くだけで、Google への通信はこのコンテナが行います。"
echo

gcloud auth application-default login --no-browser --project "$PROJECT"

SRC="${CLOUDSDK_CONFIG:-/root/.config/gcloud}/application_default_credentials.json"
[ -f "$SRC" ] || { echo "認証情報が作られませんでした: $SRC" >&2; exit 1; }

cp "$SRC" "$OUT"
chmod 600 "$OUT"
echo
echo "認証情報を $OUT に置きました。次は同期です:"
echo "  docker compose run --rm ops sync"
