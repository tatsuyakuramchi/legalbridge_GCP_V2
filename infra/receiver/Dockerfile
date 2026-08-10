# lb-v2-receiver — 外部 Webhook / Slack 受信専用の公開リレー（依存ゼロ・runbook 2-4）
FROM node:22-slim
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production
USER node
CMD ["node", "server.mjs"]
