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
