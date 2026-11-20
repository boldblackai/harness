#!/bin/bash
set -e

# Shared env setup (routes git's global config into persisted ~/.config).
# shellcheck disable=SC1091
. /etc/harness/setup-env.sh

CONFIG="/home/harness/.hermes/config.yaml"
HERMES_HOME="/home/harness/.hermes"

# Stamp docker install so Hermes skips in-container update banners (#100).
mkdir -p "$HERMES_HOME"
printf '%s\n' docker >"$HERMES_HOME/.install_method"

# Stale gateway control-pointer cleanup. A previous container's
# temp-fallback control socket can survive on a bind-mounted HERMES_HOME
# as an inode the host share (macOS virtiofs) can neither stat nor remove
# from inside the container. Hermes discovery follows gateway.sock.path,
# lstats that inode, gets "Operation not supported", and every later
# client fails with an opaque "Gateway inaccessible:
# invalid_control_peer" - which reads as "inaccessible", not "absent", so
# no gateway is ever auto-started again to clean it up: the workspace
# stays bricked until the artifacts are removed by hand. At entrypoint
# time nothing of THIS container is running yet, so a pointer whose
# target cannot be stat'ed is stale by definition. The gate checks the
# target, never blanket-deletes: a live sibling container sharing this
# bucket (the desktop multiplexer) owns a statable target and must keep
# it.
GW_POINTER="$HERMES_HOME/gateway.sock.path"
if [ -f "$GW_POINTER" ]; then
	# Hermes' pointer readers strip whitespace from both ends of the whole
	# content; match that so a whitespace-polluted pointer naming a live
	# socket (leading or trailing, CRLF included) is not called stale.
	gw_target=$(awk '{t = t $0} END {sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t); print t}' "$GW_POINTER" 2>/dev/null) || true
	# A published pointer's target is always a plain bound socket (the
	# listener binds before the pointer is published), so gate on that:
	# missing, unstatable, symlinked, or wrong-type targets are stale by
	# definition. A symlink target is a dead end for hermes too - its
	# discovery lstats the target itself and refuses non-sockets.
	if [ -z "$gw_target" ] || [ -L "$gw_target" ] || ! [ -S "$gw_target" ]; then
		echo "harness: removing stale gateway control pointer (dead target: ${gw_target:-unreadable})" >&2
		rm -f -- "$GW_POINTER" || true
		# Best effort: drop the dead target's private fallback directory.
		# Containment is exact-parent equality plus a one-segment name
		# check - bash case globs match "/" (a glob-shaped pin alone lets
		# a tampered pointer's ".." segments escape it), so this allows
		# exactly one directory level below $HERMES_HOME/cache/scratch
		# named hermes-gw-*. Other fallback locations hermes can choose
		# (XDG_RUNTIME_DIR, /tmp, the squat-proof hgw-* root) are not
		# swept; their dead directories stay as harmless junk once the
		# pointer is gone, and removal can fail on the same unstatable
		# share, which is also harmless.
		gw_dir=${gw_target%/*}
		if [ "${gw_dir%/*}" = "$HERMES_HOME/cache/scratch" ]; then
			case "${gw_dir##*/}" in
				hermes-gw-*)
					rm -rf -- "$gw_dir" 2>/dev/null || true
					;;
			esac
		fi
	fi
fi

if [ ! -f "$CONFIG" ]; then
	# First run
	if [ -z "$HARNESS_CLOUD_MODE" ]; then
		# Local mode: seed LM Studio config
		mkdir -p /home/harness/.hermes
		cp /etc/harness/hermes-local.yaml "$CONFIG"
	fi
	# Cloud mode first run: hermes self-seeds from env vars
	# Default skills marketplace (#163) — idempotent; public repo, no credentials
	hermes skills tap add boldblackai/skills >/dev/null 2>&1 || true
else
	# Config exists — reconcile with current harness mode
	if [ -z "$HARNESS_CLOUD_MODE" ]; then
		# Local mode: ensure LM Studio settings
		hermes config set model.provider custom >/dev/null 2>&1
		hermes config set model.base_url "http://host.docker.internal:1234/v1" >/dev/null 2>&1
		hermes config set model.default "${HERMES_MODEL:-gemma-4-e4b}" >/dev/null 2>&1
	else
		# Cloud mode: honor HERMES_PROVIDER/HERMES_BASE_URL when set; else hermes auto-detects (#132)
		hermes config set model.provider "${HERMES_PROVIDER:-}" >/dev/null 2>&1
		hermes config set model.base_url "${HERMES_BASE_URL:-}" >/dev/null 2>&1
	fi
fi

# Override model if -m was passed
if [ -n "$HERMES_MODEL" ]; then
	hermes config set model.default "$HERMES_MODEL" >/dev/null 2>&1
fi

# Desktop mode: serve the Webapp (browser-hosted Desktop) from this
# container. Mechanical setup: config, first-boot sign-in credentials,
# gateway launch - no agent prompt involved.
DESKTOP_OK=0
if [ -n "${HARNESS_DESKTOP:-}" ]; then
	hermes config set webapp.enabled true >/dev/null 2>&1 || true
	hermes config set webapp.host 0.0.0.0 >/dev/null 2>&1 || true
	hermes config set webapp.port 3000 >/dev/null 2>&1 || true

	# First-boot sign-in credentials (basic auth): generated once, persisted
	# in ~/.hermes/.env (0600), printed at every start. The password is
	# taken from HARNESS_DESKTOP_PASSWORD when set (then it replaces the
	# stored one). The session secret is generated once too, so logins
	# survive restarts.
	if [ -n "${HARNESS_DESKTOP_PASSWORD:-}" ]; then
		DESKTOP_PASSWORD="$HARNESS_DESKTOP_PASSWORD"
	else
		DESKTOP_PASSWORD=$(grep '^HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=' "$HERMES_HOME/.env" 2>/dev/null | cut -d= -f2- | head -1)
		if [ -z "$DESKTOP_PASSWORD" ]; then
			DESKTOP_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(16))')
		fi
	fi
	DESKTOP_SECRET=$(grep '^HERMES_DASHBOARD_BASIC_AUTH_SECRET=' "$HERMES_HOME/.env" 2>/dev/null | cut -d= -f2- | head -1)
	if [ -z "$DESKTOP_SECRET" ]; then
		DESKTOP_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(16))')
	fi
	: >"$HERMES_HOME/.env.desktop"
	if [ -f "$HERMES_HOME/.env" ]; then
		grep -v -e '^HERMES_DASHBOARD_BASIC_AUTH_' "$HERMES_HOME/.env" >>"$HERMES_HOME/.env.desktop" || true
	fi
	{
		echo "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin"
		echo "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=$DESKTOP_PASSWORD"
		echo "HERMES_DASHBOARD_BASIC_AUTH_SECRET=$DESKTOP_SECRET"
	} >>"$HERMES_HOME/.env.desktop"
	mv "$HERMES_HOME/.env.desktop" "$HERMES_HOME/.env"
	chmod 600 "$HERMES_HOME/.env"

	# Launch: starts the gateway (no idle-exit) and proves the baked bundle
	# exists. An image without the bundle fails here - loudly - and the
	# session continues without the Desktop.
	if DESKTOP_OUT=$(hermes webapp --no-open --skip-build 2>&1); then
		DESKTOP_OK=1
		echo "harness desktop: http://localhost:${HARNESS_DESKTOP_HOST_PORT:-3000} - sign in: admin / $DESKTOP_PASSWORD"
	else
		echo "harness desktop: ERROR: the Webapp is not available in this image:" >&2
		echo "$DESKTOP_OUT" >&2
		if [ -n "${HARNESS_DESKTOP_SERVE_ONLY:-}" ]; then
			echo "harness desktop: serve-only mode has nothing to run; exiting." >&2
		else
			echo "harness: continuing without the Desktop." >&2
		fi
	fi
fi

if [ "$DESKTOP_OK" = 1 ]; then
	if [ -n "${HARNESS_DESKTOP_SERVE_ONLY:-}" ]; then
		# Serve-only (the `harness desktop` subcommand): no agent command
		# runs - the Desktop's browser chat is the interface. Hand PID 1 to
		# the gateway so the Webapp serves until the container stops.
		exec hermes gateway run --replace
	fi
	# The Desktop outlives the agent command: run it as a child, then hand
	# PID 1 to the gateway so the Webapp keeps serving until the container
	# stops (docker stop / Ctrl-C).
	rc=0
	"$@" || rc=$?
	echo "harness desktop: agent command exited ($rc); the Desktop keeps serving until the container stops"
	exec hermes gateway run --replace
fi

if [ -n "${HARNESS_DESKTOP_SERVE_ONLY:-}" ]; then
	# Serve-only with no Desktop to serve (the loud error is above): stop
	# instead of falling through to a command that was never given.
	exit 1
fi

exec "$@"
