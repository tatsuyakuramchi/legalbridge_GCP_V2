#!/usr/bin/env bash
# 同期に使う認証情報を、コンテナの中で取る。
#
# Windows の gcloud が接続エラーで落ちる環境向け。ブラウザを開く役だけを PC に任せ、
# トークンの引き換えはコンテナが行う。PC 側は Google へ接続しない。
#
#   docker compose run --rm login
set -euo pipefail

PROJECT="${CLOUDSDK_CORE_PROJECT:?プロジェクトが未設定です}"
OUT=/keys/adc.json

cat <<'GUIDE'
=====================================================================
 同期用の認証情報を取ります。手順は次のとおりです。

  1. このあと画面に
       gcloud auth application-default login --remote-bootstrap="https://..."
     という長いコマンドが出ます。

  2. PowerShell を「もう1つ」開いて、そのコマンドを丸ごと貼って実行します。
     ★ URL だけをブラウザに貼らないでください。
       この URL は gcloud が受け取る前提の形なので、ブラウザに直接入れると
       「Missing required parameter: redirect_uri」と言われます。

  3. ブラウザが開くのでログインして許可します。
     PowerShell に、今度は
       https://localhost:8085/?state=...&code=...
     という長い URL が出ます。

  4. その URL をコピーして、この画面の「Enter the output of the above command:」
     に貼って Enter を押します。

  この間、PC 側の gcloud は Google へ接続しません（ブラウザを開くだけ）。
  やり直したいときは Ctrl+C で抜けて、もう一度 docker compose run --rm login。
=====================================================================
GUIDE
echo

gcloud auth application-default login --no-browser --project "$PROJECT"

SRC="${CLOUDSDK_CONFIG:-/root/.config/gcloud}/application_default_credentials.json"
[ -f "$SRC" ] || { echo "認証情報が作られませんでした: $SRC" >&2; exit 1; }

cp "$SRC" "$OUT"
chmod 600 "$OUT"
echo
echo "認証情報を keys/adc.json に置きました。次は同期です:"
echo "  docker compose run --rm ops sync"
