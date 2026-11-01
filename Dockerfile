FROM debian:stable-slim@sha256:13e0a2e78aa0554ad5ff66e4e260c6dbcdff807eb1f39d43b9fb0288aae88b04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG GH_VERSION="2.103.2"
ARG TARGETARCH

# hadolint ignore=DL3008
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        fd-find \
        git \
        gnupg \
        jq \
        openssh-client \
        ripgrep \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash harness

# Download, verify checksum, and install gh
RUN set -eux && \
    GH_ARCH="linux_${TARGETARCH:-amd64}" && \
    cd /tmp && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${GH_ARCH}.tar.gz" \
        -o gh.tar.gz && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
        -o gh_checksums.txt && \
    grep "gh_${GH_VERSION}_${GH_ARCH}.tar.gz" gh_checksums.txt > gh.checksum && \
    mv gh.tar.gz "gh_${GH_VERSION}_${GH_ARCH}.tar.gz" && \
    sha256sum -c gh.checksum && \
    tar -xzf "gh_${GH_VERSION}_${GH_ARCH}.tar.gz" && \
    mv "gh_${GH_VERSION}_${GH_ARCH}/bin/gh" /usr/local/bin/ && \
    chmod +x /usr/local/bin/gh && \
    rm -rf gh*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PNPM_CONFIG_MINIMUM_RELEASE_AGE=10080
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH

# corepack's registry.npmjs.org fetches (package metadata + the @pnpm/exe
# binary) intermittently fail at the CDN edge (503 after a ~120s hang).
# corepack has no built-in retry, so a single blip fails the whole build.
RUN set -eux; \
    corepack enable; \
    attempt=1; \
    until corepack prepare pnpm@12.15.0 --activate; do \
        if [ "$attempt" -ge 5 ]; then echo "corepack prepare failed after $attempt attempts" >&2; exit 1; fi; \
        echo "corepack prepare attempt $attempt failed; retrying in 15s"; \
        attempt=$((attempt+1)); sleep 15; \
    done; \
    attempt=1; \
    until pnpm install -g @earendil-works/pi-coding-agent@1.4.0; do \
        if [ "$attempt" -ge 5 ]; then echo "pnpm install failed after $attempt attempts" >&2; exit 1; fi; \
        echo "pnpm install attempt $attempt failed; retrying in 15s"; \
        attempt=$((attempt+1)); sleep 15; \
    done; \
    pnpm store prune && \
    rm -rf ~/.cache/pnpm ~/.npm && \
    mkdir -p /etc/harness/pi-defaults && \
    chown -R harness:harness /usr/local/share/pnpm

COPY pi/models.json /etc/harness/pi-defaults/models.json

# Install mise (polyglot version manager)
# Checksums from: https://github.com/jdx/mise/releases/download/v2026.10.19/SHASUMS256.txt
ENV MISE_VERSION=2026.10.19
ENV MISE_AMD64_SHA256=3162760f40b6b5f706c60641e4ef5ee7322bc6c54f72fc26a7111b337aa18d9d
ENV MISE_ARM64_SHA256=4a4ca53b28e5433c527f4f73fac1f98f992a17cf32ca136a58e2e375f790f627
RUN set -eux && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "${ARCH}" in \
        amd64) MISE_ARCH=x64; EXPECTED="${MISE_AMD64_SHA256}" ;; \
        arm64) MISE_ARCH=arm64; EXPECTED="${MISE_ARM64_SHA256}" ;; \
        *) echo "unsupported arch: ${ARCH}"; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}" \
        -o /usr/local/bin/mise && \
    echo "${EXPECTED}  /usr/local/bin/mise" | sha256sum --check --strict && \
    chmod +x /usr/local/bin/mise

COPY setup-env.sh /etc/harness/setup-env.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Install tini (PID 1 zombie reaper + signal forwarder)
# Checksums from: https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-{amd64,arm64}.sha256sum
ENV TINI_VERSION=v0.19.0
ENV TINI_AMD64_SHA256=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee
ENV TINI_ARM64_SHA256=eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9
RUN set -eux && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "${ARCH}" in \
        amd64) TINI_ARCH=amd64; EXPECTED="${TINI_AMD64_SHA256}" ;; \
        arm64) TINI_ARCH=arm64; EXPECTED="${TINI_ARM64_SHA256}" ;; \
        *) echo "unsupported arch: ${ARCH}"; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-${TINI_ARCH}" \
        -o /tini && \
    echo "${EXPECTED}  /tini" | sha256sum --check --strict && \
    chmod +x /tini

RUN mkdir -p /home/harness/.local/share/npm /home/harness/.local/state /home/harness/.config && \
    chown -R harness:harness /home/harness/.local /home/harness/.config

# Let npm install -g work for the harness user (avoid root-owned /usr/lib/node_modules)
# Using /home/harness/.local/share/npm so it can be persisted alongside mise via volume mounts
ENV NPM_CONFIG_PREFIX=/home/harness/.local/share/npm
ENV PATH=/home/harness/.local/share/npm/bin:$PATH

USER harness
WORKDIR /app
ENTRYPOINT ["/tini", "--", "/entrypoint.sh"]
