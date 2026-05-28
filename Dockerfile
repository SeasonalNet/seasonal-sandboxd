FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

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
  && useradd --system --home /var/lib/sandboxd --shell /usr/sbin/nologin sandboxd \
  && install -d -o sandboxd -g sandboxd -m 0750 /var/lib/sandboxd
WORKDIR /opt/seasonal-sandboxd
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi ./openapi
COPY --from=build /app/migrations ./migrations
USER sandboxd
ENV NODE_ENV=production
ENV SEASONAL_SANDBOXD_CONFIG=/etc/seasonal-sandboxd/config.yaml
EXPOSE 9090
CMD ["node", "dist/src/index.js"]
