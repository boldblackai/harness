---
name: analyze-image
description: Analyze the harness Docker image size — layer-by-layer breakdown, base image contribution, and efficiency/waste report via dive. Use this skill whenever the user wants to understand image size, compare image sizes across tags, find what's taking up space, analyze layers, check image efficiency, or investigate waste in the Docker image. Triggers on phrases like "analyze the image", "how big is the image", "what's taking up space", "compare image sizes", "image size breakdown", "optimize the image", or any question about Docker image size or layer composition.
---

# Analyze Image Size

Produces a three-part breakdown of the harness Docker image:

1. All available tags and their sizes
2. Per-layer contribution (from `docker history`)
3. Efficiency and waste report (from `dive --ci`)

## Step 1: Determine target image

Default to `ghcr.io/boldblackai/harness:latest` unless the user specifies a different tag.

## Step 2: List all harness image tags

```bash
docker images ghcr.io/boldblackai/harness --format "table {{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
```

## Step 3: Per-layer breakdown

```bash
docker history <image> --no-trunc --format "table {{.Size}}\t{{.CreatedBy}}"
```

Most layers will be `0B` (metadata). Focus the summary on layers with non-zero size. Translate the raw `CREATED BY` commands into human-readable descriptions:

| Raw command fragment | Human label |
|---|---|
| `apt-get install` / NodeSource setup | "System packages + Node.js" |
| `corepack` / `pnpm install -g` | "pnpm + agent packages" |
| `COPY` / `chmod` / `mkdir` | "Config files / entrypoint" |
| Base layer (no command) | "Base OS (`debian:stable-slim`)" |

## Step 4: Base image size

Read `Dockerfile` to find the `FROM` line and extract the base image reference (including the pinned digest). Pull it if needed and inspect its uncompressed size:

```bash
docker pull <base-image-with-digest> 2>/dev/null
docker inspect <base-image-with-digest> --format '{{.Size}}' | awk '{printf "%.0f MB\n", $1/1024/1024}'
```

## Step 5: Dive efficiency analysis

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive:latest --ci <image>
```

This outputs:

- Overall efficiency percentage
- Total wasted bytes
- A ranked list of inefficient files (files duplicated across layers)

## Step 6: Report

Present the results as a unified report:

```text
## Image size analysis: <image>

### Tags
<table of tag / size / created>

### Layer breakdown
| Size   | Layer                        |
|--------|------------------------------|
| 100 MB | Base OS (debian:stable-slim) |
| 249 MB | System packages + Node.js    |
| 429 MB | pnpm + agent packages        |
| ~1 MB  | Config files / entrypoint    |

Base image accounts for X MB of the Y MB total.

### Efficiency (dive)
- Efficiency: XX%
- Wasted: XX MB

Top waste sources:
| Wasted | File | Likely cause |
|--------|------|--------------|
...
```

For the waste sources, explain *why* the duplication happens (e.g., "base image ships libssl X, apt-get install upgrades it to Y — both copies persist in the overlay filesystem").

Conclude with a one-paragraph interpretation: is the image well-optimized? What, if anything, is actionable?
