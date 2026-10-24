# syntax=docker/dockerfile:1
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4
WORKDIR /app

# The lock file is created beside the data directory, so the volume holds both
# and a second container on the same volume fails to start.
ENV NODE_ENV=production \
    CRUMBLE_HOST=0.0.0.0 \
    CRUMBLE_PORT=7337 \
    CRUMBLE_DATA_DIR=/var/lib/crumble/data \
    CRUMBLE_SKILLS_DIR=/app/skills \
    CRUMBLE_CLAUDE_COMMAND=/var/lib/crumble/claude-code/node_modules/.bin/claude \
    MSB_HOME=/var/lib/crumble/microsandbox

COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json bunfig.toml ./
COPY src src
COPY workspace-image/desktop workspace-image/desktop
COPY web web
COPY skills skills
COPY tools/assign-legacy-owner.ts tools/assign-legacy-owner.ts

RUN mkdir -p /var/lib/crumble && chown bun:bun /var/lib/crumble
USER bun
VOLUME /var/lib/crumble
EXPOSE 7337

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.CRUMBLE_PORT ?? 7337) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "src/server.ts"]
