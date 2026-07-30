# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable \
    && pnpm install --frozen-lockfile --no-optional

COPY tsconfig.json ./
COPY src ./src
COPY openapi ./openapi
COPY migrations ./migrations

RUN pnpm build

FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable \
    && pnpm install --prod --frozen-lockfile --no-optional

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    sqlite3 \
    coreutils \
    diffutils \
    file \
    findutils \
    grep \
    jq \
    ripgrep \
    sed \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system \
    --home /var/lib/sandboxd \
    --shell /usr/sbin/nologin \
    sandboxd \
  && install -d \
    -o sandboxd \
    -g sandboxd \
    -m 0750 \
    /var/lib/sandboxd

WORKDIR /opt/seasonal-sandboxd

COPY --from=production-dependencies \
  --chown=sandboxd:sandboxd \
  /app/node_modules \
  ./node_modules

COPY --from=build \
  --chown=sandboxd:sandboxd \
  /app/dist \
  ./dist

COPY --from=build \
  --chown=sandboxd:sandboxd \
  /app/openapi \
  ./openapi

COPY --from=build \
  --chown=sandboxd:sandboxd \
  /app/migrations \
  ./migrations

COPY --chown=sandboxd:sandboxd package.json ./

USER sandboxd

ENV NODE_ENV=production
ENV SEASONAL_SANDBOXD_CONFIG=/etc/seasonal-sandboxd/config.yaml

EXPOSE 9090

CMD ["node", "dist/src/index.js"]
