#!/usr/bin/env bash
# fetch_retry OUT URL [curl args...] — bounded retry with backoff, fail-closed.
#
# Single retry implementation for every network fetch in the image build's
# verify chains (Dockerfile.hermes). Transient failures — HTTP 403/429/5xx
# and transport errors (curl exit 7/28/56) — retry with bounded exponential
# backoff; Retry-After (delta-seconds) governs the sleep when present.
# Redirects are followed (-L, bounded) and the final post-redirect status is
# classified. Non-transient failures (other 4xx, other curl exits) fail
# immediately so a bad digest never sits through retries. Persistent failure
# exits non-zero after the bound: verification stays fail-closed.
set -u
OUT="$1"
URL="$2"
shift 2
MAX_ATTEMPTS=5
MAX_SLEEP=60
DEADLINE=$(( $(date +%s) + 300 ))
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  HDRS=$(mktemp)
  # Curl semantics: the FIRST -o wins for a single transfer and scalar options
  # are last-wins — so the fixed output path goes before "$@", and the fixed
  # bounds (status capture, timeouts, redirect policy) go after it. Caller
  # args can add options (e.g. -H) but cannot override the fetch contract.
  CODE=$(curl -sS -o "$OUT.tmp" "$@" -D "$HDRS" -w "%{http_code}" \
        --connect-timeout 10 --max-time 60 --max-redirs 10 -L "$URL" 2>/dev/null)
  RC=$?
  RA=$(sed -n 's/^[Rr]etry-[Aa]fter: *\([0-9][0-9]*\).*/\1/p' "$HDRS" | tail -1)
  rm -f "$HDRS"
  if [ "$RC" -eq 0 ] && [ "$CODE" -ge 200 ] && [ "$CODE" -lt 300 ]; then
    # mv -T: strict target semantics — a non-file at OUT is a failed promote,
    # never a silent move-into-directory that would report success.
    if mv -T "$OUT.tmp" "$OUT"; then
      exit 0
    fi
    echo "fetch_retry: failed to promote $OUT.tmp to $OUT" >&2
    rm -f "$OUT.tmp"
    exit 1
  fi
  TRANSIENT=0
  case "$RC" in 7|28|56) TRANSIENT=1 ;; esac
  case "$CODE" in 403|429|5??) TRANSIENT=1 ;; esac
  if [ "$TRANSIENT" -ne 1 ]; then
    echo "fetch_retry: non-transient failure rc=$RC code=$CODE url=$URL" >&2
    rm -f "$OUT.tmp"
    exit 1
  fi
  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    break
  fi
  if [ -n "$RA" ] && [ "$RA" -le "$MAX_SLEEP" ]; then
    SLEEP=$RA
  else
    SLEEP=$(( 4 << (attempt - 1) ))
    [ "$SLEEP" -gt "$MAX_SLEEP" ] && SLEEP=$MAX_SLEEP
  fi
  NOW=$(date +%s)
  if [ $(( NOW + SLEEP )) -ge "$DEADLINE" ]; then
    echo "fetch_retry: total budget exhausted rc=$RC code=$CODE" >&2
    rm -f "$OUT.tmp"
    exit 1
  fi
  sleep "$SLEEP"
  attempt=$(( attempt + 1 ))
done
echo "fetch_retry: giving up after $MAX_ATTEMPTS attempts code=$CODE url=$URL" >&2
rm -f "$OUT.tmp"
exit 1
