# Guest images for workspaces. Debian (glibc), which cua-driver needs.
#   base:    every bot with a workspace (coding jobs)
#   desktop: base plus the bot desktop for desktop jobs: Xvnc, Openbox, tint2, Chromium, cua-driver
FROM debian:trixie-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/
COPY --from=oven/bun:1.4.4-debian /usr/local/bin/bun /usr/local/bin/
RUN ln -s bun /usr/local/bin/bunx
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl git make openssh-client python3 python3-venv ripgrep \
  && rm -rf /var/lib/apt/lists/*
# gh reads GH_TOKEN, the bot GitHub App's credential; Debian's package lags the API.
ARG TARGETARCH
ARG GH_VERSION=2.103.3
ARG GH_SHA256_AMD64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_SHA256_ARM64=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
RUN set -eu; \
  case "$TARGETARCH" in arm64) sum=$GH_SHA256_ARM64 ;; amd64) sum=$GH_SHA256_AMD64 ;; *) echo "unsupported $TARGETARCH"; exit 1 ;; esac; \
  dir="gh_${GH_VERSION}_linux_${TARGETARCH}"; \
  curl -fsSLo "/tmp/$dir.tar.gz" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$dir.tar.gz"; \
  echo "$sum  /tmp/$dir.tar.gz" | sha256sum -c -; \
  tar -xzf "/tmp/$dir.tar.gz" -C /tmp; \
  install -m 755 "/tmp/$dir/bin/gh" /usr/local/bin/gh; \
  rm -rf "/tmp/$dir" "/tmp/$dir.tar.gz"
ENV GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1
WORKDIR /workspace

FROM base AS desktop
ARG TARGETARCH
ARG CUA_DRIVER_VERSION=0.38.0
ARG CUA_DRIVER_SHA256_ARM64=80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d
ARG CUA_DRIVER_SHA256_X86_64=31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server openbox tint2 chromium xdotool imagemagick fonts-dejavu-core fonts-noto-color-emoji \
    socat procps dbus-x11 at-spi2-core x11-utils zenity libnss3-tools \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in arm64) arch=arm64; sum=$CUA_DRIVER_SHA256_ARM64 ;; amd64) arch=x86_64; sum=$CUA_DRIVER_SHA256_X86_64 ;; *) echo "unsupported $TARGETARCH"; exit 1 ;; esac; \
  file="cua-driver-rs-${CUA_DRIVER_VERSION}-linux-${arch}-binary.tar.gz"; \
  curl -fsSLo "/tmp/$file" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/$file"; \
  echo "$sum  /tmp/$file" | sha256sum -c -; \
  tar -xzf "/tmp/$file" -C /usr/local/bin cua-driver; \
  rm "/tmp/$file"; \
  CUA_DRIVER_RS_TELEMETRY_ENABLED=0 cua-driver telemetry disable
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1
# Every window maximized and undecorated: the job sees content, not window chrome.
RUN mkdir -p /opt/crumble \
  && sed 's|<applications>|<applications><application class="*"><decor>no</decor><maximized>yes</maximized></application>|' \
    /etc/xdg/openbox/rc.xml > /opt/crumble/openbox-rc.xml
COPY desktop/desktop-start.sh desktop/browser.sh /opt/crumble/
RUN chmod 755 /opt/crumble/*.sh
# Chromium would offer to save the logins desktop jobs fill into its profile on /workspace, where coding jobs can read it.
COPY desktop/chromium-policy.json /etc/chromium/policies/managed/crumble.json
