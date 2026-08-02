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
# Hermes detects the provider from the "openrouter/" prefix but passes
# the full string to the API, which OpenRouter rejects (it expects just
# the model part without the provider prefix). Passing the bare model
# ID without the prefix works as a diagnostic — if it passes, the bug
# is confirmed in how harness passes model names to hermes.
case "$AGENT" in
  hermes) MODEL="${2:-google/gemini-3.1-flash-lite}" ;;
  *)      MODEL="${2:-openrouter/google/gemini-3.1-flash-lite}" ;;
esac

NODE_BIN="${NODE_BIN:-node}"
HARNESS_BIN="$(pwd)/bin/harness.js"

mkdir -p integration-output
OUTPUT_DIR="$(pwd)/integration-output"
PASS=0
FAIL=0

# --- helpers ------------------------------------------------------------------

run_harness() {
  local workspace="$1"
  local prompt="$2"
  local outfile="$3"

  (
    cd "$workspace" || return 1
    timeout "$TIMEOUT" "$NODE_BIN" "$HARNESS_BIN" \
      --agent "$AGENT" \
      -m "$MODEL" \
      -p "$prompt" \
      -e "$ENV_FILE" \
      > "$outfile" 2>&1
  )
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
  SCENARIO_OUT="$OUTPUT_DIR/${AGENT}-multi-file.txt"
  SCENARIO_EXIT=0

  run_harness "$SCENARIO_WS" \
    "Read alpha.txt and beta.txt, then create a file called combined.txt that contains the contents of both files." \
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

# --- run all scenarios --------------------------------------------------------

echo ""
echo "=== Testing $AGENT adapter ($MODEL) ==="
echo ""

scenario_sentinel_edit
scenario_multi_file

echo ""
echo "Results for $AGENT: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
