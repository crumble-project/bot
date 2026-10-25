# syntax=docker/dockerfile:1
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4
WORKDIR /app

# The lock file is created beside the data directory, so the volume holds both
# and a second container on the same volume fails to start.
ENV NODE_ENV=production \
    CRUMBLE_HOST=0.0.0.0 \
    CRUMBLE_PORT=7337 \
    CRUMBLE_DATA_DIR=/var/lib/crumble/data \
    CRUMBLE_SKILLS_DIR=/app/apps/server/skills \
    CRUMBLE_CLAUDE_COMMAND=/var/lib/crumble/claude-code/node_modules/.bin/claude \
    MSB_HOME=/var/lib/crumble/microsandbox

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY --from=deps /app/apps/web/node_modules apps/web/node_modules
COPY package.json tsconfig.base.json bunfig.toml ./
COPY apps/server/package.json apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/workspace-image/desktop apps/server/workspace-image/desktop
COPY apps/server/skills apps/server/skills
COPY apps/server/tools/assign-legacy-owner.ts apps/server/tools/assign-legacy-owner.ts
COPY apps/web apps/web

RUN mkdir -p /var/lib/crumble && chown bun:bun /var/lib/crumble
USER bun
VOLUME /var/lib/crumble
EXPOSE 7337

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.CRUMBLE_PORT ?? 7337) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "apps/server/src/app/server.ts"]
