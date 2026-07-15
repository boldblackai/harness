# 1Password CLI secret injection

**Date:** 2026-07-15
**Status:** Proposed

## Goal

Let agents running inside harness containers resolve secrets — `GH_TOKEN`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and any other credential — from a
[1Password](https://1password.com) vault at runtime, via the 1Password CLI
(`op`), instead of reading them from plaintext `.env` files on disk.

Concretely: a user should be able to put a **secret reference**
(`op://vault/item/field`) in their env file and have harness resolve it to the
real value before — or inside — the container starts, so the plaintext secret
never sits in a committed or gitignored file.

## Motivation

Today, cloud-mode secrets enter the container through `--env-file` /
`-e <file>`:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-***" > .env
echo "GH_TOKEN=ghp_***"            >> .env
npx @boldblackai/harness -a hermes -e .env -p "add tests"
```

That `.env` is a plaintext file on the host filesystem. The risks:

- **Accidental commit.** A misconfigured `.gitignore` (or a new secret added
  without thinking) leaks the key into git history. `GH_TOKEN` and provider API
  keys are high-value, immediately-abusable credentials.
- **Supply-chain exfiltration.** Agents and their tooling run arbitrary code —
  package `postinstall` scripts, MCP servers, shell commands. Anything with read
  access to the workspace can `cat .env`. Recent npm campaigns (Shai-Hulud, the
  `qix` maintainer compromise) explicitly targeted developer tokens and cloud
  keys.
- **No auditability / rotation story.** A leaked plaintext key is silently
  compromised until someone notices. A vault-backed secret has a clear rotation
  point and access logging.

1Password's CLI turns a secret reference (`op://Private/GitHub/token`) into the
plaintext value on demand. Storing the **reference** in the env file (instead of
the value) means the file on disk is useless to an attacker — they'd need vault
access. This RFC proposes wiring that resolution into harness.

## Background: how `op` authenticates in a container

The 1Password CLI has three authentication modes, but only two work inside a
container. This distinction drives the whole design.

| Mode | How it works | Works in a container? |
| --- | --- | --- |
| **Desktop app integration** | `op` talks to the running 1Password desktop app over a local IPC socket (`op` app integration). Biometric unlock. | **No.** The IPC socket does not cross the container boundary. This is the mode a developer gets from `op signin` with the app installed, and it is unavailable to any process inside `docker run`. |
| **Service account** | A long-lived token (`OP_SERVICE_ACCOUNT_TOKEN`) identifies a 1Password service account scoped to specific vault(s). `op` resolves references directly against 1Password's servers over HTTPS. | **Yes.** One env var. No extra infrastructure. The recommended mode for CI, automation, and containers. |
| **1Password Connect** | A self-hosted API server (two containers: `connect-api` + `connect-sync`) that syncs vaults from 1Password cloud. The CLI authenticates to Connect with `OP_CONNECT_HOST` + `OP_CONNECT_TOKEN`. | **Yes.** Requires running the Connect server (typically on the host or in CI) and exposing its port. Better for teams that want fine-grained token scoping and rotation without touching the desktop app. |

The desktop-app-integration socket is a hard non-starter for harness: harness's
whole value is running things **inside** a container, and that socket is
host-only. So the question is not "can the container reach the host vault" — it
cannot, not that way — but "which container-compatible auth mode do we standardize
on."

This is a documented 1Password limitation, not a harness one. See the
[devcontainer + 1Password guide][devcontainer-op] and the
[1Password Connect getting-started][op-connect] for the same conclusion.

[devcontainer-op]: https://www.nodejs-security.com/blog/mitigate-supply-chain-security-with-devcontainers-and-1password-for-nodejs-local-development
[op-connect]: https://developer.1password.com/docs/connect/get-started/

## Design options

There are two structurally different places the `op://` reference can be
resolved: on the **host** (harness resolves it before spawning the container) or
**inside the container** (the entrypoint or agent resolves it). They have
opposite trade-offs.

### Option A — Host-side resolution (recommended for the default path)

harness resolves `op://` references in the env file **on the host** at launch
time, using the host's `op` CLI (which, running on the host, *can* use desktop
app integration, a service account, or Connect — whatever the developer has set
up). It writes the resolved values to a **temporary** env file, passes that into
the container via the existing `--env-file` path, and deletes the temp file once
the container is started.

```bash
# User's committed/env file — contains references, never plaintext
cat > .env.secrets <<'EOF'
GH_TOKEN=op://Private/GitHub/token
ANTHROPIC_API_KEY=op://Private/Anthropic/api-key
OPENROUTER_API_KEY=op://Private/OpenRouter/api-key
EOF

# harness resolves each op:// value host-side, passes plaintext only into the
# (already-isolated) container, and scrubs the temp file after start.
npx @boldblackai/harness -a hermes -e .env.secrets -p "add tests"
```

The resolution step (host, before `docker run`):

```bash
# Pseudocode for the host-side resolver
tmpfile="$(mktemp)"
chmod 600 "$tmpfile"
while IFS='=' read -r key val; do
  case "$val" in
    op://*) val="$(op read "$val")" ;;
  esac
  printf '%s=%s\n' "$key" "$val" >> "$tmpfile"
done < "$env_file"
```

The temp file is passed as `--env-file "$tmpfile"` and removed right after the
container process is launched (matching the devcontainer `postStartCommand`
cleanup pattern).

**Pros:**

- The container image, entrypoints, and the `RunInput` plumbing are **unchanged**
  — resolution is a host-side preprocessing step on the env file. This keeps the
  change small and runtime-agnostic (works identically under `docker` and
  `apple/container`).
- The container never holds a 1Password credential. An agent that escapes to read
  its own environment sees resolved secrets (same as today) but finds no vault
  token to pivot with.
- The developer's existing host `op` setup (desktop app, service account, or
  Connect) works as-is — harness doesn't prescribe the auth mode.

**Cons:**

- Requires `op` installed on the **host**. harness currently assumes only the
  container runtime and (optionally) cosign on the host; this adds a host
  dependency. Mitigation: `op` is only required when an env file actually
  contains `op://` references; a plain `.env` still works with no `op` installed.
- The resolved plaintext exists briefly in a host temp file. `mktemp` + `chmod
  600` + immediate post-start `rm` bounds the exposure to the container's
  lifetime, but it is not zero-disk.

### Option B — In-container resolution (service-account / Connect)

Install `op` in the base image. Pass `OP_SERVICE_ACCOUNT_TOKEN` (or
`OP_CONNECT_HOST` + `OP_CONNECT_TOKEN`) into the container. The entrypoint runs
`op inject` on a secret-references template to materialize the real env file, or
the agent calls `op run` to launch its subprocess with references resolved
in-process.

**Pros:**

- No host `op` dependency. Everything happens inside the container, consistent
  with harness's "host is thin, container is self-contained" model.
- The resolved plaintext never touches the host disk at all.

**Cons:**

- A long-lived 1Password **token** now lives inside the container environment. A
  compromised agent can exfiltrate the token and, depending on the service
  account's vault scope, read/rotate other vault items — a broader blast radius
  than a single leaked API key. This is the central security trade-off: a vault
  token is "root-equivalent" to the vaults it can access, the same class of risk
  the create-bclaw deployer-policy work exists to eliminate.
- Adds `op` to the base image (every variant), increasing image size and the
  attack surface of the shipped image.
- Requires the user to provision and scope a 1Password service account, which is
  more setup than "have the desktop app unlocked."

## Recommendation

**Option A (host-side resolution) as the default and primary path**, with Option
B documented as an alternative for teams that already run a 1Password Connect
server or prefer token-based container auth.

Rationale:

- It is the smallest change to harness: a preprocessing pass over the env file,
  no image or entrypoint changes, no new in-container credential. The existing
  `--env-file` → `--env-file` (docker) / `--env-file` (apple) flow is untouched.
- It keeps the vault token off the container's attack surface. The resolved
  individual secret is no more exposed than it is today; the *vault access
  credential* never enters the container at all.
- It degrades gracefully: no `op://` references in the file → no `op` needed on
  the host → behaves exactly like today. There is no forced migration.

Option B remains valuable for headless CI hosts where there is no desktop app and
the user prefers not to install `op` on the runner; it can be a follow-up if
demand materializes.

## Technical details (Option A)

### Detection

Before spawning, harness scans the resolved env file for lines matching
`<KEY>=op://...`. If none are found, the file is passed through unchanged (no
`op` invocation, no host dependency). If any are found:

1. Verify `op` is on the host `PATH`; if not, error with a clear message
   ("env file contains `op://` references but the 1Password CLI (`op`) was not
   found on the host — install it or remove the references").
2. Resolve each `op://` reference via `op read "op://..."`.
3. Write resolved values to a `mktemp` file (`chmod 600`).
4. Substitute that temp file for the user's file in the `envFileArgs` passed to
   the runtime's `runArgs()`.
5. Delete the temp file once the container has started (the env is already
   materialized in the container's process environment at that point).

### Where it hooks in

The resolution belongs in the env-file loading path that already feeds
`envFileArgs` / `envArgs` (see `RunInput` in `src/harness.ts`). It runs after the
env file is read and before the runtime argv is built — so both `DockerRuntime`
and `AppleContainerRuntime` benefit with no per-runtime change, exactly like the
existing env-file handling.

### Lifecycle of the temp file

```text
mktemp + chmod 600
  → resolve op:// lines
  → pass --env-file <tmpfile> to container runtime
  → container process starts (env materialized in-container)
  → rm -f <tmpfile>
```

The window during which plaintext exists on the host is bounded by container
startup (typically sub-second). The temp file is scoped to the harness process
(`$TMPDIR`), never the workspace, so it is not inside the bind-mounted directory
the agent can read.

### `gh auth` interaction

harness's `setup-env.sh` seeds a gitconfig credential helper that calls
`gh auth git-credential`, so HTTPS git operations authenticate via the token `gh`
stores after `gh auth login`. With this RFC, a user can instead source `GH_TOKEN`
from the vault:

```bash
GH_TOKEN=op://Private/GitHub/token
```

Resolved host-side, `GH_TOKEN` lands in the container env as usual; both `gh`
(which reads `GH_TOKEN`) and the credential helper continue to work. No change to
`setup-env.sh` or the entrypoints is required.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| **Option A — host-side resolution** (this RFC, default) | **Chosen** — smallest harness change; no new in-container credential; degrades gracefully when `op` is absent. |
| **Option B — in-container resolution** (service account / Connect) | Documented as an alternative. Broader blast radius (a vault token in-container), larger image. Follow-up if headless-CI demand materializes. |
| **Mount the host 1Password socket into the container** | Rejected — the desktop app integration socket does not function across the container boundary; 1Password does not support this mode in containers. |
| **Status quo (plaintext `.env`)** | Rejected — the credential-exfil and accidental-commit risks are the motivation for this RFC. |

## Migration notes

- **No breaking change.** Env files without `op://` references behave exactly as
  before; no `op` is required on the host unless a reference is present.
- **Opt-in per env file.** A user adopts by replacing a plaintext value with an
  `op://` reference and having `op` installed and authenticated on the host.
- **Documentation** (`README.md`, `docs/agents/*.md`) should add a "Secrets from
  1Password" section showing the `op://` reference syntax and the one-time host
  `op` setup.
- **Image and entrypoints are unchanged** under Option A; no image rebuild is
  required to adopt.

## Implementation checklist

- [ ] Host-side `op://` resolver in the env-file loading path (`src/harness.ts`),
  gated on the presence of references (no-op when absent).
- [ ] `mktemp` + `chmod 600` temp-file handling with post-start cleanup.
- [ ] Clear error when references are present but `op` is missing from the host
  `PATH`.
- [ ] Unit/e2e test: env file with and without `op://` references (mock `op read`
  in the e2e docker shim).
- [ ] Docs: "Secrets from 1Password" section in `README.md` and the per-agent
  docs under `docs/agents/`.
- [ ] Decide whether to also support Option B (service-account in-container) in
  the same change or as a follow-up.
