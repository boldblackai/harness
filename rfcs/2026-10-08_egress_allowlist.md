# Opt-in Egress Allowlisting for Agent Containers

**Date:** 2026-10-08
**Status:** Proposed

## Goal

Let a harness invocation restrict outbound (egress) network traffic from the
agent container to an explicit allowlist of destinations — for example
"this session may only reach AWS Redshift and the Anthropic / OpenAI /
OpenRouter APIs" — without changing any behavior for existing users. The
feature is strictly opt-in: when no new flag is passed, harness builds the
exact same container argv it builds today.

## Motivation

Coding agents run third-party instructions and generated code. A sandboxed
session frequently holds production credentials (an env file with an
Anthropic key, a Redshift connection string, a `GH_TOKEN`). Today nothing
prevents a prompt-injected instruction or a malicious transitive dependency
from exfiltrating those credentials to an arbitrary host: the container runs
on the default bridge with unrestricted outbound access.

Host-side IP filtering (security groups, `DOCKER-USER` iptables rules) cannot
express the destinations we care about: `api.anthropic.com`,
`api.openai.com`, and `openrouter.ai` are CDN-fronted names whose IPs churn,
so any IP allowlist rots. The enforcement point must see **hostnames**, not
IPs — which means a forwarding proxy that receives the destination name from
the client (HTTP `CONNECT`) or resolves it itself (raw-TCP forwarding), and a
network topology in which the agent container has **no route to the outside
world except through that proxy**.

## Current behavior (source-anchored)

- `DockerRuntime.runArgs()` (`src/harness.ts` ~125) assembles a fixed argv:
  `run --rm -it --cap-drop=ALL --cap-add=NET_RAW --security-opt
  no-new-privileges --security-opt seccomp=<profile>` plus env / volume /
  port / workdir / image args. No `--network`, `--dns`, or proxy wiring
  exists anywhere in the CLI.
- The only network-adjacent hardening is capability dropping plus the
  `block-af-alg.json` seccomp profile (blocks `socket(AF_ALG)`); neither
  constrains egress.
- `AppleContainerRuntime.runArgs()` (~220) emits the same semantics in
  apple/container's flag dialect (no `--security-opt`; microVM isolation).
- No generic docker-arg passthrough exists: unknown flags produce a warning
  and are dropped.
- The AWS deploy path (`docs/deploying/aws.md`) runs the agent on ECS with
  `awsvpc` networking, where VPC security groups and VPC endpoints already
  provide CIDR/port-level egress control. That path is unaffected by this
  RFC; this RFC targets the local `harness` CLI on a workstation.

## Non-goals

- **TLS interception / decryption.** The proxy never MITMs; it filters by
  destination hostname only. Client TLS remains end-to-end.
- **Inbound filtering.** `--port` publishing semantics are unchanged.
- **Bandwidth / rate limits.**
- **IPv6.** Docker user-defined bridges are IPv4; the managed network is v4.
- **Replacing the AWS deploy path.** VPC-level controls remain the answer
  for cloud deployments.

## Design overview — two tiers, both opt-in

```text
Tier 1  --network <name>        Pass a pre-existing container network through
                                to the runtime. Brings your own topology
                                (e.g. a network wired to an existing corp
                                proxy). Tiny surface, lands first.

Tier 2  --egress <allowlist>    Harness-managed enforcement: per-run isolated
                                network + egress gateway container that only
                                forwards allowlisted destinations. This is
                                the feature the motivation asks for.
```

When neither flag is passed, harness emits the identical argv it emits today
— no networks are created, no extra containers start, no env vars are
injected. Compatibility with every existing configuration and wrapper script
is a hard requirement, verified by e2e tests that assert the unchanged argv.

## Tier 1 — `--network` passthrough

- New single-value string flag `--network <name>` (repeatable? no —
  single value, matching harness convention for string flags) and
  environment variable `HARNESS_NETWORK` (CLI flag wins; mirrors the
  `HARNESS_IMAGE_TAG` pattern for wrappers).
- Value is forwarded verbatim as `docker run --network <name>` /
  `container run --network <name>`. No harness-side validation beyond
  non-empty; the runtime's own error surfaces if the network does not exist.
- `--network host` triggers a stderr warning that host networking removes
  network isolation (the run proceeds; opt-in means the user asked for it,
  mirroring the `--mount-entire-home` posture).
- Runtime support: docker supports `--network` natively; the apple/container
  CLI also accepts `--network` (per `rfcs/2026-06-20_container_runtime.md`),
  forwarded identically.

## Tier 2 — `--egress` managed allowlist

### Topology

Per run, harness creates an isolated network and an egress gateway; the
agent container joins only the isolated network:

```text
                    ┌────────────────────────────────────────────┐
                    │ host                                       │
                    │                                            │
 default bridge ────┤   ┌──────────────────────────┐             │
 (has external      │   │ egress gateway container │             │
  route) ───────────┼──▶│  squid (HTTP CONNECT,    │             │
                    │   │         dstdomain ACL)   │             │
                    │   └───────────┬──────────────┘             │
                    │               │ only attach point with     │
                    │  harness-egress-<runid>  (──internal ──)   │
                    │               │ no external routing        │
                    │   ┌───────────┴──────────────┐             │
                    │   │ agent container          │             │
                    │   │  HTTPS_PROXY=gateway:3128│             │
                    │   └──────────────────────────┘             │
                    └────────────────────────────────────────────┘
```

The fence is the **topology**, not the env vars: the managed network is
created with `--internal`, so docker itself guarantees the agent container
cannot route anywhere off-network. The only container holding a second
interface on a routable network is the gateway. Even an agent that ignores
`HTTP(S)_PROXY` entirely, or shells out to a raw-socket binary, can only
reach the gateway. No host iptables rules, no root beyond what docker group
membership already implies.

### Allowlist input syntax

`--egress` takes a comma-separated list of entries, or `@/path/to/file` with
one entry per line (`#` comments allowed):

```text
--egress "api.anthropic.com,api.openai.com,openrouter.ai,.amazonaws.com"
--egress @/etc/harness/egress-allowlist.txt
```

Entry grammar:

| Entry | Meaning |
|-------|---------|
| `host` | exact hostname, HTTPS (port 443) via CONNECT |
| `host:port` | non-443 port — **rejected in v1**; reserved for the deferred raw-TCP extension (see below) |
| `.domain` or `*.domain` | suffix match: any host under `domain` — e.g. `.amazonaws.com` covers `redshift-data.<region>.amazonaws.com` |
| `host.docker.internal[:port]` | **host-local** destination (see below): direct connection, never proxied |

- Port defaults to 443 (HTTP(S) via squid CONNECT).
- Non-443 port entries are rejected in v1 with an error pointing at the
  deferred raw-TCP extension (direct database drivers — see below) —
  **except host-local entries**, which connect directly (below).
- `host.docker.internal[:port]` entries are host-local: served by a
  direct connection (added to `NO_PROXY`), never through the gateway.
  In v1 the `:port` part is advisory (the whole host is reachable) —
  port-level enforcement against host services belongs to the deferred
  raw-TCP extension.
- An empty allowlist — `--egress none`, or a `@file` whose entries are
  all comments — is valid and selects **airgap mode** (below).
- `host` may also be an IP literal.

### How each destination class is enforced

**HTTP(S) — CONNECT through squid.** Harness injects
`HTTPS_PROXY=http://<gateway-ip>:3128` (and `HTTP_PROXY`,
`NO_PROXY=localhost,127.0.0.1,host.docker.internal`) into the agent
container. Harness also sets `NODE_USE_ENV_PROXY=1` when the gateway is
active: Node's built-in `fetch`/`http` ignore proxy env vars without it
(fetch since Node 24.0, `http.request` since 24.5 — the base image ships
Node 24), so Node-based agents (pi, opencode) would otherwise silently
bypass the proxy. It is inert for non-Node agents (hermes is Python). Squid receives the
destination hostname unresolved in the `CONNECT` line, checks it against the
generated `dstdomain` ACL, and forwards allowlisted names only —
re-resolving per connection, so CDN churn is handled. Denied destinations
fail closed with a proxy error.

**AWS services via the `aws` CLI / SDKs — plain HTTPS CONNECT.** The AWS
CLI (botocore) honors `HTTPS_PROXY`, and every API call — including the
Redshift Data API (`aws redshift-data ...`, served at
`redshift-data.<region>.amazonaws.com:443`) — is an HTTPS request whose
hostname travels unresolved in the CONNECT line. A `.amazonaws.com` suffix
entry (or a narrower regional prefix) covers it. No client-side DNS and no
special path are required.

**Host-local destinations (`host.docker.internal`) — direct connection.**
The host is inside the trust boundary (it is where harness itself runs and
where workspace mounts, env files, and local services like LM Studio on
`:1234` come from), so host-local entries do not go through the gateway at
all: harness adds `host.docker.internal` to `NO_PROXY` and the agent
connects directly over the isolated network. Reachability uses the
platform's existing mechanism — automatic on Docker Desktop, Linux via
`--add-host host.docker.internal:host-gateway` (docker 20.10+), Apple
container via the documented `container system dns` setup harness already
checks. Implementation must verify the host-gateway route survives on an
`--internal` network per platform; if Docker Desktop blocks it there, the
fallback is a host-loopback forward on a minimal gateway (the deferred
socat machinery), not a design change.

**Raw TCP (direct database drivers) — deferred extension, not in v1.**
Direct-driver Redshift (psql / psycopg2 / redshift_connector on port 5439)
is NOT plain HTTP: it is a PostgreSQL-wire-protocol session — TLS-secured
in protocol (`sslmode=require`, TLS 1.2+) but invisible to an HTTP proxy —
and these clients ignore proxy env vars. v1 of Tier 2 rejects non-443
allowlist entries with a clear error. The pre-designed split-horizon
machinery is retained under "Deferred: raw-TCP forwarding" below and lands
only behind a confirmed direct-driver use case.

**DNS.** v1 does not intercept DNS. Proxied HTTPS needs no client-side
resolution — the hostname rides the CONNECT line to the gateway, which
resolves and re-resolves it per connection. Un-proxied connection attempts
to any destination fail at the network boundary. Which names the container
looks up via docker's embedded DNS is not filtered; that leaks lookups, not
traffic. Acceptable; noted.

### Airgap mode (`--egress none`)

An empty allowlist is the degenerate — and cheapest — case: with no
internet destinations there is nothing to filter, so **no gateway container
is created at all**. Harness creates only the `--internal` network and
attaches the agent container to it. The result is a true airgap: no route
off-host in either direction except the host itself, which remains
reachable as above.

```bash
harness --local --egress none        # agent + LM Studio on :1234, nothing else
```

This pairs naturally with local mode (no `-e`): the agent talks to
`host.docker.internal:1234` and nothing else exists to talk to. Note the
distinction from `docker run --network none`: the `none` network removes
all interfaces including the host route, which would break local-LLM usage
too — the airgap still needs the internal network's host gateway.

### Gateway image

New in-repo image `Dockerfile.egress-proxy` (Debian stable-slim + squid;
config generated per run from the allowlist and mounted in, not baked in —
the deferred raw-TCP extension would add dnsmasq + socat), tagged
`egress-proxy-<version>`, built / signed / SLSA-attested
by the existing `docker.yml` pipeline alongside the agent variants, subject
to the repo's digest-pinning and 7-day-cooldown dependency rules. The
gateway runs with `--cap-drop=ALL --security-opt no-new-privileges` and the
same seccomp profile; it needs no special capabilities.

Per-repo rule fallthrough: all installed packages are apt-pinned by the
existing Dockerfile conventions.

### Run lifecycle

1. Allocate a free subnet from a dedicated private pool, skipping
   subnets already in use (checked via `docker network inspect`; pool
   overridable with `HARNESS_EGRESS_SUBNET`; the shipped default is a
   documentation-reserved range, defined once in code).
2. `docker network create --internal harness-egress-<runid> <subnet>`.
   Skipped-if-empty: when the allowlist has no internet entries (airgap
   mode), no gateway is started. Otherwise the gateway attaches to this
   network (static IP `.2`) **and** the default bridge (the external leg).
3. Agent container: `--network harness-egress-<runid>` plus the proxy env
   injection (no `--dns` in v1 — see DNS note above). `--env-file` values still flow in; because
   harness appends its `-e` args after `--env-file`, harness's proxy vars
   take precedence over any same-key values in a user env file (last wins in
   docker) — deliberate: the fence hint must not be silently overridable,
   and the real fence (routing) is not env-controllable anyway.
4. Gateway runs `--rm -d`; when the agent container exits, harness stops
   the gateway and best-effort removes the network (brief retry while the
   gateway detaches). Stale networks from crashed runs are swept
   opportunistically at the next `--egress` invocation (remove
   `harness-egress-*` networks with no attached containers).

### Flag interactions

- `--egress` and `--network` together: hard error (the managed network is
  the point).
- `--egress` under the apple/container runtime: hard error initially —
  whether apple/container supports `--internal` networks and multi-network
  attach is unverified; fail closed with a clear message until verified.
  Tier 1 `--network` works under both runtimes.
- `--egress` with `--ephemeral` / `-p` / piped stdin: supported and useful
  (one-shot locked-down runs).
- `--port` publishing is unaffected (publish works on bridge networks).

### What the agent sees

`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` env vars pointing at the gateway
(airgap mode: only `NO_PROXY`, nothing to proxy). (With the deferred
raw-TCP extension, also split-horizon DNS answers.) This is a convenience,
not the
security boundary — the boundary is `--internal` routing. The RFC's contract
statement for docs: **egress allowlisting is enforced by network topology;
env vars are hints that reduce surprise, not controls.**

## Backward compatibility

- No flags → byte-identical argv, no networks, no gateway, no env injection.
  Existing wrappers, scripts, and the ECS deploy path are untouched.
- New flags are additive; the unknown-flag warning list grows by two.
- The e2e suite gains a "default argv unchanged" regression test that fails
  if any egress code path leaks into the default path.

## Testing

- **Unit/e2e (shim-based, no docker):** argv construction per tier; env
  injection ordering vs `--env-file`; flag validation (bad entry grammar,
  `--egress`+`--network`, `--egress`+apple runtime, `--network host`
  warning); unchanged-argv regression for the flagless path.
- **Integration smoke (real docker, `scripts/smoke-test.sh`):** new
  scenario — run with `--egress` against a local "destination" (published
  port on a helper container on the default bridge, allowlisted): agent
  reaches it; a non-allowlisted destination (another helper container)
  times out / proxy-denies. (The deferred raw-TCP extension adds its own
  scenario if it lands.)
- CI: no new workflows; smoke suite runs where it does today.

## Documentation updates

- `README.md`: new "Egress control" section (both tiers, threat model,
  topology diagram, what is and is not guaranteed).
- `AGENTS.md`: flag reference, gateway image row in the image table,
  `docker.yml` note.
- `USAGE` help text: `--network`, `--egress`, `HARNESS_NETWORK`,
  `HARNESS_EGRESS_SUBNET`.

## Open decisions

Walked one-by-one with the PR; rulings pinned in the table below.

- **D1 — Scope.** Land both tiers phased (Tier 1 first), or Tier 1 only?
  *Recommendation:* both, phased — Tier 1 alone does not deliver the
  motivation (hostname-level enforcement).
- **D2 — Flag surface.** `--network` / `--egress` names, `@file` form,
  entry grammar as specified. *Recommendation:* as specified.
- **D3 — Gateway implementation.** In-repo squid+dnsmasq+socat image vs.
  envoy-based vs. purpose-built proxy. *Recommendation:* in-repo
  multi-service image — battle-tested components, no new language runtime,
  fits the existing build/sign/attest pipeline.
- **D4 — Raw TCP path.** Steered in PR review (2026-10-08): Redshift is
  accessed through the `aws` CLI (Redshift Data API = HTTPS on 443;
  botocore honors `HTTPS_PROXY`), so v1 is **CONNECT-only** and the
  split-horizon machinery is deferred behind a confirmed direct-driver
  need. Access-pattern confirmation pending from the requester.
- **D5 — Apple runtime stance for `--egress`.** Fail closed until verified
  vs. block the whole feature on apple support. *Recommendation:* fail
  closed with a clear error; document the gap (same posture as the
  `--security-opt` note).
- **D6 — Airgap mode + host-local entries** (raised in PR review
  2026-10-08: "allowlist: none" for local-LLM usage). Empty allowlist
  selects no-gateway airgap; `host.docker.internal[:port]` entries connect
  directly with advisory ports in v1. Alternatives: block on empty
  allowlists entirely, or enforce host ports via the gateway in v1 (costs
  the deferred machinery now). *Recommendation:* as specified — the host
  is inside the trust boundary and the airgap itself is the enforcement.

### Decision log

| # | Decision | Ruling | Pinned |
|---|----------|--------|--------|
| D1 | Scope: phased both tiers | | |
| D2 | Flag surface as specified | | |
| D3 | Gateway: in-repo squid+dnsmasq+socat | | |
| D4 | Raw TCP: v1 CONNECT-only; split-horizon deferred | Steered in PR review 2026-10-08 (aws-CLI access is HTTPS; direct-driver need unconfirmed) | 2026-10-08 |
| D6 | Airgap mode + host-local entries, advisory ports | | |
| D5 | Apple runtime: fail closed for `--egress` | | |

## Implementation checklist

Tier 1:

- [ ] `--network` flag + `HARNESS_NETWORK` env in `MINIMIST_OPTS` and
      consumption; forward in both `runArgs()` implementations
- [ ] `--network host` warning
- [ ] USAGE / README / AGENTS.md updates
- [ ] e2e: flag forwarding both runtimes, host warning, unchanged-default-argv
      regression
- [ ] RFC status → Implemented (Tier 1)

Tier 2:

- [ ] `Dockerfile.egress-proxy` (squid + dnsmasq + socat, apt-pinned) +
      `Makefile image-egress-proxy` + `docker.yml` build/sign/attest
- [ ] `--egress` flag: entry grammar parsing, `@file` form, validation
      errors, mutual exclusion with `--network`, apple-runtime fail-closed
- [ ] Subnet allocation + `docker network create --internal` + stale-network
      sweep
- [ ] Gateway lifecycle (start `--rm -d`, config mount, stop + network rm on
      exit)
- [ ] Agent container wiring: proxy env injection (after `--env-file`),
      static gateway IP
- [ ] squid ACL generation from the allowlist (HTTPS/CONNECT, 443 only;
      non-443 entries rejected with a clear error)
- [ ] Airgap mode: empty allowlist ⇒ internal network, no gateway, host
      reachable; e2e argv test + smoke scenario (local-LLM shape: helper on
      host-reachable port answers, internet helper unreachable)
- [ ] Host-local entry class: `NO_PROXY` injection, `--add-host
      host-gateway` on Linux, advisory-port semantics + error copy
- [ ] Verify host-gateway route survives `--internal` per platform (Docker
      Desktop, Linux engine); document fallback if not
- [ ] e2e argv tests + integration smoke scenario (allowlisted pass,
      non-allowlisted fail, raw-TCP forward)
- [ ] USAGE / README ("Egress control" section) / AGENTS.md updates
- [ ] RFC status → Implemented (Tier 2)

Deferred extension — raw-TCP forwarding (design retained, not scheduled;
requires a confirmed direct-driver use case and a re-lock of this RFC):

- [ ] dnsmasq split-horizon DNS + socat re-resolving forwards on the
      gateway for `host:port` entries
- [ ] Un-reject non-443 allowlist entries; `--dns <gateway-ip>` wiring
- [ ] e2e + integration smoke scenario for the raw-TCP path
