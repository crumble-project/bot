# syntax=docker/dockerfile:1
ARG SKILLS_REF=main

# Override with `--build-context skills=<dir>` to bundle a local checkout.
FROM scratch AS skills
ARG SKILLS_REF
ADD https://github.com/crumble-project/skills.git#${SKILLS_REF} /

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
    CRUMBLE_SKILLS_DIR=/opt/crumble/skills \
    MSB_HOME=/var/lib/crumble/microsandbox

COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json ./
COPY src src
COPY --from=skills . /opt/crumble/skills

RUN mkdir -p /var/lib/crumble && chown bun:bun /var/lib/crumble
USER bun
VOLUME /var/lib/crumble
EXPOSE 7337

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.CRUMBLE_PORT ?? 7337) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "src/server.ts"]
