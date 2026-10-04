FROM node:24-bookworm-slim AS builder
WORKDIR /workspace
ENV CI=true
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# The editor packager verifies the recorded gitlink and clean submodule state.
COPY .git ./.git
COPY .gitmodules ./
COPY vendor/drawio ./vendor/drawio
RUN pnpm install --frozen-lockfile && pnpm build \
    && pnpm --filter @drawio-cloud/server deploy --legacy --prod /server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data HOST=127.0.0.1 PORT=3000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends nginx ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
COPY --from=builder /server/package.json ./server/package.json
COPY --from=builder /server/node_modules ./server/node_modules
COPY --from=builder /workspace/apps/server/dist ./server/dist
COPY --from=builder /workspace/apps/web/dist ./web
COPY --from=builder /workspace/build/editor ./editor
COPY deploy/nginx.conf.template deploy/start.mjs deploy/healthcheck.mjs ./deploy/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "/app/deploy/healthcheck.mjs"]
CMD ["node", "/app/deploy/start.mjs"]
