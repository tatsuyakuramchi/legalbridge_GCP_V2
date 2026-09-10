# 同期・復元の作業用。psql / pg_dump / pg_restore と Cloud SQL Auth Proxy を1つに入れる。
# Proxy はビルド済みの公式イメージから実行ファイルだけを写す。
# curl・jq は API を叩く経路（SYNC_MODE=export）と疎通の確認に使う。
FROM gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.15.0 AS proxy
FROM postgres:17-alpine
COPY --from=proxy /cloud-sql-proxy /usr/local/bin/cloud-sql-proxy
RUN apk add --no-cache bash curl jq netcat-openbsd
