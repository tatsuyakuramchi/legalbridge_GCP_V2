FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/legalbridge/package.json apps/legalbridge/package.json
RUN npm ci

COPY apps/legalbridge apps/legalbridge
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache chromium font-noto-cjk
ENV NODE_ENV=production
ENV PORT=8080
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json ./
COPY apps/legalbridge/package.json apps/legalbridge/package.json
RUN npm ci --omit=dev

COPY --from=build /app/apps/legalbridge/dist apps/legalbridge/dist
USER node
EXPOSE 8080
CMD ["npm", "run", "start", "-w", "@legalbridge/app"]

