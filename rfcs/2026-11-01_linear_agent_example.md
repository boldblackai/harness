# Optional Linear agent deployment example

**Date:** 2026-11-01
**Status:** Proposed

## Goal

Make the reusable parts of Finchbot's Linear integration available to Harness users without baking organization-specific behavior into the image or adding a new CLI mode.

## Proposal

Ship an opt-in Hermes directory plugin and a standalone AWS webhook/queue template under `examples/linear/`, with a deployment guide. Linear agent-session webhooks enter an HMAC-verifying receiver, then SQS FIFO. The gateway polls outbound and records work in a durable local SQLite inbox. Replies use Linear Agent Activities; public GitHub PR links become session external URLs.

The plugin owns its in-memory client-credentials token cache and does not depend on Finchbot's MCP authentication patch. Configuration supplies the workspace, app, operator IDs, and credentials. There are no embedded team, channel, repository, or user IDs. Issue-management tools and workspace-specific permissions remain the operator's responsibility.

## Delivery behavior

Persist before acknowledging the queue, deduplicate semantic event IDs, serialize work per session, and never automatically replay a run that started before a restart. Authorized Stop signals use Hermes's control path; issue content cannot invoke gateway commands. Standalone status requests use recorded progress independently of model work. Interim findings are durable user-facing updates; heartbeat activities are ephemeral.

## Boundaries and tradeoffs

The reference transport uses AWS Lambda and SQS, while the gateway remains outbound-only. A different queue transport can be added later. One consumer owns the local inbox; active-active gateways and multi-workspace OAuth installations are out of scope. Local state requires a filesystem compatible with SQLite WAL and backups.

The plugin targets Hermes v0.22.2 and uses its internal session-task tracking and final-response metadata. Keep it optional, test against new Hermes releases, and consider moving the platform implementation into Hermes upstream once its API is stable. The Harness contribution is the deployable example and documentation, not a fork of Hermes core.

## Validation

Offline tests cover authentication boundaries, duplicates, crash recovery, and status delivery while work is blocked. CI runs them without credentials. Template rendering and documentation builds are checked locally. A live deployment still needs a disposable-issue acceptance check for acknowledgement timing, follow-ups, status, Stop, and restart behavior before production use.
