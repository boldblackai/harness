# Documentation Website: Zensical + GitHub Pages

**Date:** 2025-05-24
**Status:** Implemented

## Goal

Add a public documentation website for Harness, built with [Zensical](https://github.com/zensical/zensical) (Python-based static site generator) and deployed to GitHub Pages via GitHub Actions.

## Motivation

Harness currently relies on `README.md` and `AGENTS.md` for documentation. A dedicated documentation site would provide:

- Better navigation and discoverability for users evaluating Harness
- A home for guides, deployment tutorials (`docs/deploying-to-fly.md`, `docs/deploying-to-k8s.md`), and RFCs
- Versioned documentation tied to releases
- A more professional landing experience for the project

## Technology

- **Zensical** — Python-based static site generator, installable via `pip install zensical`
  - Configuration via `zensical.toml`
  - Content sourced from a `docs/` directory with Markdown + front matter
  - Output to `site/` directory
  - Scaffolding via `zensical new .`
  - Build via `zensical build --clean`
- **GitHub Pages** — hosted at `https://capotej.github.io/harness/`
- **GitHub Actions** — automated build and deploy on push to `main`

## Proposed Directory Structure

```text
docs/
├── getting-started.md       # Quick start guide
├── agents/
│   ├── pi.md               # Pi adapter docs
│   ├── opencode.md         # OpenCode adapter docs
│   └── hermes.md           # Hermes adapter docs
├── deploying/
│   ├── fly.md              # (moved from docs/deploying-to-fly.md)
│   └── k8s.md              # (moved from docs/deploying-to-k8s.md)
├── configuration.md         # CLI flags, env vars, config files
├── persistence.md           # XDG persistence explained
└── security.md              # Cosign verification, seccomp, capabilities
zensical.toml               # Site configuration
.github/workflows/docs.yml  # CI/CD workflow
```

## GitHub Actions Workflow

```yaml
name: Deploy Docs
on:
  push:
    branches: [main]
    paths:
      - "docs/**"
      - "zensical.toml"
      - ".github/workflows/docs.yml"
      - "README.md"
permissions:
  pages: write
  id-token: write
concurrency:
  group: pages
  allow-cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install zensical
      - run: zensical build --clean
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## What Stays the Same

- `README.md` and `AGENTS.md` remain the primary in-repo references for agents and contributors
- `docs/deploying-to-fly.md` and `docs/deploying-to-k8s.md` stay in-repo (the website would import or link to them)
- All existing CI/CD workflows are unaffected
- No changes to CLI, Dockerfiles, or test infrastructure

## Resolved Decisions

- **Repository placement:** In-repo, under a `docs/` subdirectory
- **RFCs:** Omitted from the documentation site (remain in-repo only)
- **Versioning:** Track `main` only, no per-release versioning

## Implementation Checklist

- [ ] Create `zensical.toml` with site metadata and theme config
- [ ] Scaffold initial documentation pages in `docs/`
- [ ] Move/adapt existing `docs/deploying-to-*.md` content
- [ ] Add `.github/workflows/docs.yml` for automated deployment
- [ ] Configure GitHub Pages on the repository settings
- [ ] Verify local build with `zensical build --clean`
- [ ] Verify CI/CD workflow succeeds
- [ ] Update `README.md` with link to documentation site
