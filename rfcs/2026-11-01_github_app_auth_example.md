# Optional GitHub App authentication example

**Date:** 2026-11-01
**Status:** Proposed

## Goal

Offer long-running Hermes gateways a reusable alternative to a person's persisted GitHub token, based on Finchbot's GitHub App helper.

## Proposal

Add an optional helper, `gh` wrapper, policy example, tests, and setup guide under `examples/github-app-auth/` and `docs/github-app.md`. Leave default Harness authentication and the image unchanged. The first secret backend is AWS SSM through workload credentials; GitHub Enterprise and other secret backends are out of scope.

The helper reads the App ID, installation ID, and private key on demand, signs a short-lived JWT, and requests a repository/permission-restricted installation token. It caches only installation tokens in a private ephemeral directory, with locking and atomic replacement. Config paths isolate caches; policy and credential-source changes invalidate reuse. `gh` receives the token in its child environment, while Git receives it through its credential protocol for configured HTTPS repository paths.

## Scope and lifecycle

Configuration contains no embedded organization or repository IDs. Supported permissions are contents and pull requests, each read or write. Tokens must not silently broaden permissions. Diagnostics validate repository ID/name pairs without printing tokens. Setup records previous Git authentication and author settings; removal restores only keys the operator has not subsequently changed.

The App's installation scope and GitHub permissions enforce access. Local configuration is defense in depth, not an isolation boundary against the workload user or its subprocesses. No automatic mutation retries, multi-user token broker, or default startup hooks are introduced.

## Validation

Offline tests cover JWT signatures, SSM retrieval, token scope and expiry, private cache files, credential routing, diagnostic redaction, and reversible setup using real Git against temporary files. CI runs them with pinned test dependencies. A live deployment must verify a permitted repository read and any required write operation using its own App before production work.
