# V3 の外向きの口（server.mjs を参照）。依存パッケージなし。
FROM node:20-slim
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production
USER node
CMD ["node", "server.mjs"]
