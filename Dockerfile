FROM debian:stable-slim@sha256:8f0c555de6a2f9c2bda1b170b67479d11f7f5e3b66bb4a7a1d8843361c9dd3ff

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG GH_VERSION="2.92.0"
ARG MISE_VERSION="2026.4.23"
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
        ripgrep \
        sudo \
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
    && useradd -m -s /bin/bash harness \
    && echo 'harness ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg' > /etc/sudoers.d/harness \
    && chmod 0440 /etc/sudoers.d/harness

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
ENV PNPM_MINIMUM_RELEASE_AGE=10080
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.2.2 --activate && \
    pnpm install -g @mariozechner/pi-coding-agent@0.73.1 && \
    pnpm store prune && \
    rm -rf ~/.cache/pnpm ~/.npm && \
    mkdir -p /etc/harness/pi-defaults && \
    chown -R harness:harness /usr/local/share/pnpm

COPY pi/models.json /etc/harness/pi-defaults/models.json

# Install mise (polyglot version manager)
# Checksums from: https://github.com/jdx/mise/releases/download/v2026.4.23/SHASUMS256.txt
ENV MISE_VERSION=2026.4.23
ENV MISE_AMD64_SHA256=4a650daf1c6db2bb9c32a4d4f6d2389051906f85792d97b04ad10b9f6e212372
ENV MISE_ARM64_SHA256=4d2a02012c87e02fba74c72dabf7ff8c64fbcc2d70b848f63f75b257592fcd44
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

USER harness
WORKDIR /app
ENTRYPOINT ["/tini", "--", "/entrypoint.sh"]
