# Production image for the Restate agent endpoint (@restate-agents/example).
#
# Build from the repository root (the build context must be the repo root so
# the workspace manifests and lockfile are visible):
#
#   docker build -f docker/Dockerfile -t restate-agent .
#
# Run (the endpoint listens on $PORT, default 9080; register it with
# restate-server via `restate deployments register http://<host>:9080`):
#
#   docker run --rm -p 9080:9080 -e OPENAI_API_KEY=... restate-agent
#
# Runtime environment:
#   OPENAI_API_KEY        required for model calls (checked at call time)
#   SANDBOX_PROVIDER      "local" (default) or "modal"
#   MODAL_TOKEN_ID/SECRET credentials for the modal sandbox provider
#   RESTATE_ADMIN_URL     admin API for dynamic tool discovery (default
#                         http://localhost:9070) and RESTATE_ADMIN_TOKEN
#   PORT                  listen port (default 9080)

# syntax=docker/dockerfile:1

# Track the latest Node 22 (the package's engines floor). Pin a digest here if
# you need bit-for-bit reproducible builds.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
# The repo has no packageManager field, so pin pnpm explicitly and keep it in
# lockstep with the version developers use locally. pnpm reads npm-style env
# config; a fixed store path lets the cache mounts below target it.
ARG PNPM_VERSION=11.9.0
ENV npm_config_store_dir=/pnpm/store
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app

FROM base AS build
# Manifests first: the dependency layer only rebuilds when the lockfile or a
# package.json changes, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/libs/example/package.json packages/libs/example/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/libs/example/tsconfig.json packages/libs/example/
COPY packages/libs/example/src packages/libs/example/src
RUN pnpm --filter @restate-agents/example build

# Assemble a self-contained production tree (dist + prod-only node_modules,
# no workspace symlinks). --legacy is required because this workspace does not
# use injected dependencies (pnpm v10+ default for `deploy`).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @restate-agents/example deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# tini reaps orphaned children: the local sandbox provider spawns shell
# commands, and node as PID 1 does not adopt their orphans.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # dist ships source maps; make production stack traces point at TS sources
    NODE_OPTIONS=--enable-source-maps \
    PORT=9080

WORKDIR /app
# Left root-owned on purpose: the unprivileged runtime user can read but not
# modify the application.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist

USER node
EXPOSE 9080

# The endpoint speaks h2c, so probe it with node's http2 client; any HTTP
# response (even 404) proves the server is accepting streams. Orchestrators
# with their own probes (k8s) ignore this; it serves docker/compose users.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const c=require('node:http2').connect('http://127.0.0.1:'+(process.env.PORT||9080));const r=c.request({':path':'/health'});r.on('response',(h)=>process.exit(h[':status']<500?0:1));r.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000).unref()"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/app.js"]
