# Deploying hermes as a fly.io "claw"

You can deploy `hermes` as a long-running "claw" on [fly.io](https://fly.io), reachable over a messaging gateway. These instructions assume Telegram; adapt for other [messaging gateways](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).

Install and authenticate `flyctl`:

```bash
brew install flyctl
fly auth login
```

Create `fly.toml`:

```toml
app = "my-hermes-agent-claw"
primary_region = "iad"

[env]
  TZ = "America/New_York"
  # Signal the entrypoint to skip local defaults and auto-detect providers from API keys.
  HARNESS_CLOUD_MODE = "1"
  # Persist the faster-whisper model cache across restarts.
  # Without this, the model re-downloads (~142 MB) on every deploy.
  HF_HOME = "/home/harness/.hermes/.cache/huggingface"

[build]
  image = "ghcr.io/boldblackai/harness:hermes-1.8.6"

[processes]
  app = "hermes gateway"

# Persistence volumes — mirror what the `harness` CLI bind-mounts on an
# interactive run, so claw state survives restarts: hermes config/sessions,
# XDG config (jj/git config the agent writes), and mise tools & trust
# settings. Each path needs its own fly volume.
[[mounts]]
  source = "my_hermes_agent_claw_data"
  destination = "/home/harness/.hermes"
  initial_size = "1gb"

[[mounts]]
  source = "my_hermes_agent_claw_config"
  destination = "/home/harness/.config"
  initial_size = "1gb"

[[mounts]]
  source = "my_hermes_agent_claw_mise_data"
  destination = "/home/harness/.local/share/mise"
  initial_size = "1gb"

[[mounts]]
  source = "my_hermes_agent_claw_mise_state"
  destination = "/home/harness/.local/state/mise"
  initial_size = "1gb"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

[[restart]]
  policy = "always"
  max_retries = 3
```

Create the app, volume, and secrets, then deploy:

```bash
fly apps create my-hermes-agent-claw
fly volumes create my_hermes_agent_claw_data      --region iad --size 1 --app my-hermes-agent-claw
fly volumes create my_hermes_agent_claw_config      --region iad --size 1 --app my-hermes-agent-claw
fly volumes create my_hermes_agent_claw_mise_data   --region iad --size 1 --app my-hermes-agent-claw
fly volumes create my_hermes_agent_claw_mise_state  --region iad --size 1 --app my-hermes-agent-claw
fly secrets set OPENROUTER_API_KEY=<your-key> --app my-hermes-agent-claw
# https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram#option-b-manual-configuration
fly secrets set TELEGRAM_BOT_TOKEN=<your-token> --app my-hermes-agent-claw
fly secrets set TELEGRAM_ALLOWED_USERS=<your-user-ids> --app my-hermes-agent-claw
fly deploy --app my-hermes-agent-claw
```

Message the bot via Telegram, or wire it up to a scheduled workflow — see the [daily briefing bot guide](https://hermes-agent.nousresearch.com/docs/guides/daily-briefing-bot) for an example.

## GitHub authentication (`gh` CLI)

To use `gh` (or `git push` / `git pull` over HTTPS) from inside the claw, authenticate once — the session persists in `~/.config` (a mounted volume), so it survives restarts. See [GitHub authentication](../github.md) for creating a PAT.

Fly secrets are the cleanest way to get a token into the running machine without it touching any shell history, so use a throwaway secret: set it, log in, then drop it.

```bash
# 1. Temporarily expose the PAT to the running machine (triggers a redeploy)
 fly secrets set GH_PAT=<your-github-pat> --app my-hermes-agent-claw

# 2. Log `gh` in on the running machine. Credentials land in ~/.config/gh
#    (on the persisted volume), so they survive restarts.
fly ssh console --app my-hermes-agent-claw \
  -C 'sh -c "echo $GH_PAT | gh auth login --with-token && gh auth status"'

# 3. Drop the PAT — the persisted gh session is all that's needed.
fly secrets unset GH_PAT --app my-hermes-agent-claw
```

> Prefer a quick interactive login? `fly ssh console --app my-hermes-agent-claw` opens a shell on the running machine; run `echo "<your-pat>" | gh auth login --with-token` there.

## Customizing the claw — *don't* extend the image

When you want to give the claw extra capabilities (tool wrappers around your APIs, an opinionated initial system prompt, custom `gh`-style scripts), the temptation is to write a `Dockerfile` that does `FROM ghcr.io/boldblackai/harness:hermes-1.8.6` and bakes everything in. **Don't.** Two problems:

1. The fly volume mounts on top of `/home/harness/.hermes`, which silently hides anything you `COPY` into that path on first boot.
2. Hermes treats `config.yaml` as mutable state — TUI tweaks, model switches, and persona toggles are persisted via `save_config()`. A derived image fights that ownership.

The supported pattern is to use the upstream image **unmodified** and inject your customizations via fly's [`[[files]]`](https://fly.io/docs/reference/configuration/#the-files-section) section. Files at non-volume paths get refreshed on every deploy; files seeded into `/etc/harness/hermes-defaults/openrouter/` get copied into the volume on first boot only (via `entrypoint-hermes.sh`'s `cp -rn`) so hermes' subsequent runtime config edits stick across restarts.

Example — add a `crm` API wrapper script and an initial system prompt without building a new image:

```toml
# fly.toml — append to the example above

# Tool wrappers — written to a non-volume path. Refreshed on every deploy.
# fly [[files]] preserves the local file's exec bit, so your scripts run
# as-is from the agent's sandbox.
[[files]]
  guest_path = "/etc/myclaw/bin/crm"
  local_path = "bin/crm"

# Initial config + persona. Upstream's hermes entrypoint copies these into
# the volume on first boot only — after that, hermes owns its config.
[[files]]
  guest_path = "/etc/harness/hermes-defaults/openrouter/system-prompt.md"
  local_path = "config/system-prompt.md"
```

To force a refresh of `config.yaml` or `system-prompt.md` from your repo after the first boot, SSH in and delete the volume's copy before redeploying:

```bash
fly ssh console --app my-hermes-agent-claw \
  -C 'rm /home/harness/.hermes/system-prompt.md'
fly deploy --app my-hermes-agent-claw
```

The benefits over a derived image:

- **Faster deploys** — no rebuild, just pull the upstream image and apply files. Seconds instead of minutes.
- **Trivial upstream upgrades** — bump one tag in `fly.toml`.
- **No fight with hermes** over `config.yaml` ownership.
- **One fewer artifact** to maintain, sign, and verify.
