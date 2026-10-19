# Guest image for coding workspaces. Debian (glibc), so Linux desktop tools such as cua-driver can run in it later.
FROM node:24-trixie-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl git make openssh-client python3 python3-venv ripgrep \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
