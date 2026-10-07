FROM oven/bun:1-alpine AS base
RUN apk add --no-cache ffmpeg nginx
WORKDIR /app

FROM base AS development
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM development AS ui
COPY tsconfig.json ./
COPY src/catalog/model.ts ./src/catalog/model.ts
COPY ui ./ui
RUN bun run build:ui

FROM base AS production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=ui /app/static ./static
COPY nginx.conf.template entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV FILES=/maps
ENV DATA=/data
ENV PORT=3000

EXPOSE 80

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["/bin/sh", "/app/entrypoint.sh"]
