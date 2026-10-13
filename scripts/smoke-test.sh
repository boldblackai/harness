#!/usr/bin/env bash
# Smoke tests for harness adapters.
#
# Verifies that each adapter can handle realistic agent workflows:
#   1. sentinel_edit  — modify an existing file while preserving an
#                       unguessable token it could only know by reading
#   2. multi_file     — read multiple files and combine their content
#
# Usage: smoke-test.sh <agent> [model]
#
# Environment:
#   HARNESS_REGISTRY    e.g. localhost:5000/harness
#   HARNESS_IMAGE_TAG   e.g. test
#   OPENROUTER_API_KEY  (via --env-file)
#
# Exit code: 0 if all scenarios pass, 1 if any fail.

set -uo pipefail

AGENT="${1:?usage: smoke-test.sh <agent> [model]}"
ENV_FILE="${ENV_FILE:-/tmp/harness.env}"
TIMEOUT="${TIMEOUT:-120}"

# Per-adapter model selection.
#
# Model: zai/glm-5.3-flash via the Z.AI provider. The provider-qualified
# form (zai/...) is what harness -m passes through; pi accepts both the
# qualified and bare forms, hermes and opencode want the qualified one
# (opencode's enabled-provider resolution and hermes's provider detection
# both key off the prefix). The env file must carry ZAI_API_KEY.
MODEL="${2:-zai/glm-5.3-flash}"

NODE_BIN="${NODE_BIN:-node}"
HARNESS_BIN="$(pwd)/bin/harness.js"

# timeout(1) is GNU coreutils: always on Linux, absent on a stock macOS
# (coreutils installs it as gtimeout). Resolve whichever exists; without
# one, runs are unguarded by a wall clock.
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
if [ -z "$TIMEOUT_BIN" ]; then
  echo "note: timeout(1) not found (macOS: brew install coreutils); running without time limits" >&2
fi

# Preflight: the resolved images must exist locally before burning scenarios on
# them. HARNESS_IMAGE_TAG composes per-agent tags ("latest" -> "hermes-latest"),
# so a host with only the pi image tagged "latest" fails all hermes scenarios
# with an opaque docker error. Fail fast with the exact build command instead.
if [ -n "${HARNESS_IMAGE_TAG:-}" ]; then
  case "$AGENT" in
    pi)     PREFIX="" ;;
    *)      PREFIX="${AGENT}-" ;;
  esac
  REGISTRY="${HARNESS_REGISTRY:-ghcr.io/boldblackai/harness}"
  # mirrors getImage() in src/harness.ts
  MISSING="$REGISTRY:${PREFIX}${HARNESS_IMAGE_TAG}"
  # the egress scenario also runs the gateway image
  if [ "${SMOKE_EGRESS:-0}" = "1" ]; then
    MISSING="$MISSING $REGISTRY:egress-proxy-${HARNESS_IMAGE_TAG}"
  fi
  if command -v docker >/dev/null 2>&1; then
    for img in $MISSING; do
      if ! docker image inspect "$img" >/dev/null 2>&1; then
        echo "error: image $img not found locally" >&2
        echo "  build it first, e.g.:" >&2
        echo "    make image-${AGENT} image-egress-proxy" >&2
        echo "  (or tag an existing image: docker tag <existing-ref> $img)" >&2
        exit 1
      fi
    done
  fi
fi

# The scenarios assert docker-shaped behavior (entrypoint seeding, published
# images); on macOS auto-detect would pick apple/container, where the pi
# entrypoint seed currently fails. Force docker unless the caller overrides.
export HARNESS_CONTAINER_RUNTIME="${HARNESS_CONTAINER_RUNTIME:-docker}"

mkdir -p integration-output
OUTPUT_DIR="$(pwd)/integration-output"
PASS=0
FAIL=0

# --- helpers ------------------------------------------------------------------

run_harness() {
  local workspace="$1"
  local prompt="$2"
  local outfile="$3"
  local rc

  (
    cd "$workspace" || exit 1
    # </dev/null: force non-interactive runs. The script's own stdin is the
    # caller's TTY; without this redirect node/docker try to allocate a raw
    # terminal, which fails under GNU timeout's process-group isolation
    # ("unable to set IO streams as raw terminal: interrupted system call")
    # and hangs until the wall clock fires.
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "$TIMEOUT" "$NODE_BIN" "$HARNESS_BIN" \
        --agent "$AGENT" \
        -m "$MODEL" \
        -p "$prompt" \
        -e "$ENV_FILE" \
        ${HARNESS_EXTRA_ARGS:+$HARNESS_EXTRA_ARGS} \
        < /dev/null \
        > "$outfile" 2>&1
    else
      "$NODE_BIN" "$HARNESS_BIN" \
        --agent "$AGENT" \
        -m "$MODEL" \
        -p "$prompt" \
        -e "$ENV_FILE" \
        ${HARNESS_EXTRA_ARGS:+$HARNESS_EXTRA_ARGS} \
        < /dev/null \
        > "$outfile" 2>&1
    fi
  )
  rc=$?

  # The container runs as a different UID; files it creates are not
  # readable by the host user. Relax permissions after the run so the
  # assertion grep calls can read agent-created files.
  # || true: chmod may fail on container-created files we don't own;
  # that's OK — the assertions will still try, and we must not let it
  # mask the real agent exit code.
  chmod -R a+r "$workspace" 2>/dev/null || true

  return "$rc"
}

make_workspace() {
  local ws
  ws="$(mktemp -d)"
  chmod 0777 "$ws"
  echo "$ws"
}

random_token() {
  head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

check_pass() {
  echo "  ✓ PASS: $1"
  PASS=$((PASS + 1))
}

check_fail() {
  echo "  ✗ FAIL: $1"
  FAIL=$((FAIL + 1))
}

show_output() {
  echo "    --- output ---"
  tail -20 "$SCENARIO_OUT" 2>/dev/null | sed 's/^/    /'
}

# --- scenario 1: sentinel edit ------------------------------------------------
# Seeds config.py with a VERSION field AND a random SECRET_KEY the agent
# cannot know without reading the file. Asks the agent to change VERSION
# in-place. After the run we assert:
#   - "2.0.0" is present  (in-place edit succeeded)
#   - the token is present (agent read the file, did not blind-overwrite)
#
# This proves read, write, and surgical edit in a single agent loop.

scenario_sentinel_edit() {
  echo "  [sentinel_edit] edit a file while preserving an unguessable token"
  local token
  token="$(random_token)"

  SCENARIO_WS="$(make_workspace)"
  printf 'VERSION = "1.0.0"\nSECRET_KEY = "%s"\n' "$token" > "$SCENARIO_WS/config.py"
  chmod 0666 "$SCENARIO_WS/config.py"
  SCENARIO_OUT="$OUTPUT_DIR/${AGENT}-sentinel-edit.txt"
  SCENARIO_EXIT=0

  run_harness "$SCENARIO_WS" \
    'In config.py, change the VERSION value from "1.0.0" to "2.0.0". Keep everything else in the file unchanged.' \
    "$SCENARIO_OUT" || SCENARIO_EXIT=$?

  if [ "$SCENARIO_EXIT" -ne 0 ]; then
    if [ "$SCENARIO_EXIT" -eq 124 ]; then
      check_fail "sentinel_edit — timed out after ${TIMEOUT}s"
    else
      check_fail "sentinel_edit — exit code $SCENARIO_EXIT"
    fi
    show_output
    return
  fi

  if [ ! -f "$SCENARIO_WS/config.py" ]; then
    check_fail "sentinel_edit — config.py no longer exists"
    show_output
    return
  fi

  local has_version=0 has_token=0
  grep -qF '2.0.0' "$SCENARIO_WS/config.py" && has_version=1
  grep -qF "$token" "$SCENARIO_WS/config.py" && has_token=1

  if [ "$has_version" -eq 1 ] && [ "$has_token" -eq 1 ]; then
    check_pass "sentinel_edit — VERSION changed to 2.0.0 and SECRET_KEY preserved"
  else
    check_fail "sentinel_edit — VERSION=$has_version token=$has_token (expected both 1)"
    show_output
  fi
}

# --- scenario 2: multi-file ---------------------------------------------------
# Seeds two files with distinct sentinels, asks the agent to combine them.
# Tests workspace navigation and multi-file awareness.

scenario_multi_file() {
  echo "  [multi_file] read multiple files and combine their content"
  local token_a token_b
  token_a="ALPHA-$(random_token)"
  token_b="BETA-$(random_token)"

  SCENARIO_WS="$(make_workspace)"
  printf '%s\n' "$token_a" > "$SCENARIO_WS/alpha.txt"
  printf '%s\n' "$token_b" > "$SCENARIO_WS/beta.txt"
  chmod 0666 "$SCENARIO_WS/alpha.txt" "$SCENARIO_WS/beta.txt"
  # Pre-create combined.txt so hermes's write_file preserves its mode
  # (0666) via chmod --reference. Without this, hermes creates new files
  # with mktemp's default 0600, which the host CI user cannot read.
  touch "$SCENARIO_WS/combined.txt"
  chmod 0666 "$SCENARIO_WS/combined.txt"
  SCENARIO_OUT="$OUTPUT_DIR/${AGENT}-multi-file.txt"
  SCENARIO_EXIT=0

  run_harness "$SCENARIO_WS" \
    "Read the files alpha.txt and beta.txt using the read_file tool. Then create a file called combined.txt whose contents are the exact text from alpha.txt followed by the exact text from beta.txt." \
    "$SCENARIO_OUT" || SCENARIO_EXIT=$?

  if [ "$SCENARIO_EXIT" -ne 0 ]; then
    if [ "$SCENARIO_EXIT" -eq 124 ]; then
      check_fail "multi_file — timed out after ${TIMEOUT}s"
    else
      check_fail "multi_file — exit code $SCENARIO_EXIT"
    fi
    show_output
    return
  fi

  if [ ! -f "$SCENARIO_WS/combined.txt" ]; then
    check_fail "multi_file — combined.txt was not created"
    show_output
    return
  fi

  local has_a=0 has_b=0
  grep -qF "$token_a" "$SCENARIO_WS/combined.txt" && has_a=1
  grep -qF "$token_b" "$SCENARIO_WS/combined.txt" && has_b=1

  if [ "$has_a" -eq 1 ] && [ "$has_b" -eq 1 ]; then
    check_pass "multi_file — combined.txt contains both tokens"
  else
    check_fail "multi_file — combined.txt missing tokens (alpha=$has_a, beta=$has_b)"
    show_output
  fi
}

# --- scenario 3 (opt-in): egress allowlist enforcement -------------------------
# Gated behind SMOKE_EGRESS=1 (needs real docker; two extra agent runs).
#
# Seeds probe.mjs (a Node fetch one-shot; the base image ships Node 24 and
# harness injects NODE_USE_ENV_PROXY=1 with --egress, so fetch honors the
# squid gateway) and runs the agent twice under
# --egress "api.z.ai,example.com" (api.z.ai keeps the model API reachable
# so the agent can process the prompt at all):
#   positive: probe https://example.com  -> "OK 200" (allowlisted, proxied)
#   negative: probe https://iana.org     -> "ERR ..." (proxy-denied)

scenario_egress() {
  echo "  [egress] allowlisted destination reachable, non-allowlisted denied"
  local allowlist="api.z.ai,example.com"

  # One shared probe script; the target URL is argv[2].
  local probe_ok_ws probe_deny_ws probe_ok_out probe_deny_out ok_result deny_result
  probe_ok_ws="$(make_workspace)"
  seed_probe "$probe_ok_ws"
  probe_ok_out="$OUTPUT_DIR/${AGENT}-egress-allow.txt"

  HARNESS_EXTRA_ARGS="--egress $allowlist" run_harness "$probe_ok_ws" \
    'Run this shell command from the workspace root and let it finish: node probe.mjs https://example.com > result.txt 2>&1' \
    "$probe_ok_out"
  ok_result="$(cat "$probe_ok_ws/result.txt" 2>/dev/null | tail -1)"

  probe_deny_ws="$(make_workspace)"
  seed_probe "$probe_deny_ws"
  probe_deny_out="$OUTPUT_DIR/${AGENT}-egress-deny.txt"

  # The negative run's agent exit code can legitimately be non-zero (the
  # command it ran failed, as intended) — only the probe output matters.
  HARNESS_EXTRA_ARGS="--egress $allowlist" run_harness "$probe_deny_ws" \
    'Run this shell command from the workspace root and let it finish: node probe.mjs https://iana.org > result.txt 2>&1' \
    "$probe_deny_out" || true
  deny_result="$(cat "$probe_deny_ws/result.txt" 2>/dev/null | tail -1)"

  if [ -z "$ok_result" ] || [ -z "$deny_result" ]; then
    check_fail "egress — probe result.txt missing (allow='${ok_result:-<none>}' deny='${deny_result:-<none>}')"
    echo "    --- allow probe run output (tail) ---"
    tail -30 "$probe_ok_out" 2>/dev/null | sed 's/^/    /'
    echo "    --- deny probe run output (tail) ---"
    tail -30 "$probe_deny_out" 2>/dev/null | sed 's/^/    /'
    echo "    --- live egress state (should be empty after cleanup) ---"
    docker network ls --format '{{.Name}}' 2>/dev/null | grep harness-egress | sed 's/^/    network: /'
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep harness-egress | sed 's/^/    container: /'
    return
  fi

  if printf '%s' "$ok_result" | grep -q '^OK '; then
    check_pass "egress — allowlisted example.com reachable ($ok_result)"
  else
    check_fail "egress — allowlisted example.com NOT reachable (got '$ok_result')"
  fi

  if printf '%s' "$deny_result" | grep -q '^ERR '; then
    check_pass "egress — non-allowlisted iana.org denied ($deny_result)"
  else
    check_fail "egress — non-allowlisted iana.org NOT denied (got '$deny_result')"
  fi
}

# Seed a probe workspace: probe.mjs (Node fetch one-shot) + pre-created
# result.txt (0666 so container-written output stays host-readable).
seed_probe() {
  local ws="$1"
  cat > "$ws/probe.mjs" <<'PROBE'
const target = process.argv[2];
try {
  const r = await fetch(target);
  console.log("OK " + r.status);
} catch (e) {
  console.log("ERR " + ((e && e.cause && e.cause.code) || e.message));
}
PROBE
  chmod 0666 "$ws/probe.mjs"
  touch "$ws/result.txt"
  chmod 0666 "$ws/result.txt"
}

# --- run all scenarios --------------------------------------------------------

echo ""
echo "=== Testing $AGENT adapter ($MODEL) ==="
echo ""

scenario_sentinel_edit
scenario_multi_file
if [ "${SMOKE_EGRESS:-0}" = "1" ]; then
  scenario_egress
fi

echo ""
echo "Results for $AGENT: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
