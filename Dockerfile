# Agentis - single-container image.
#
# Build:    docker build -t agentis .
# Run:      docker run -it --rm -p 3737:3737 -v agentis_data:/data agentis
#
# The image installs all workspace deps (better-sqlite3 needs a build
# toolchain), prunes dev deps, then starts the API + serves the built web
# bundle from a single Node process via the bootstrap helper.

FROM node:20.18-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter "./packages/*" build || true \
 && pnpm --filter @agentis/web build \
 && pnpm --filter @agentis/api build || true

FROM base AS runtime
ENV NODE_ENV=production \
    AGENTIS_DATA_DIR=/data \
    AGENTIS_HTTP_HOST=0.0.0.0 \
    AGENTIS_HTTP_PORT=3737
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3737
CMD ["pnpm", "--filter", "@agentis/api", "start"]
