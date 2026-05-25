#!/bin/bash
set -e

CONFIG="/home/harness/.hermes/config.yaml"

if [ ! -f "$CONFIG" ]; then
	# First run
	if [ -z "$HARNESS_CLOUD_MODE" ]; then
		# Local mode: seed LM Studio config
		mkdir -p /home/harness/.hermes
		cp /etc/harness/hermes-local.yaml "$CONFIG"
	fi
	# Cloud mode first run: hermes self-seeds from env vars
else
	# Config exists — reconcile with current harness mode
	if [ -z "$HARNESS_CLOUD_MODE" ]; then
		# Local mode: ensure LM Studio settings
		hermes config set model.provider custom >/dev/null 2>&1
		hermes config set model.base_url "http://host.docker.internal:1234/v1" >/dev/null 2>&1
		hermes config set model.default "${HERMES_MODEL:-gemma-4-e4b}" >/dev/null 2>&1
	else
		# Cloud mode: clear local provider so hermes detects from env vars
		hermes config set model.provider "" >/dev/null 2>&1
		hermes config set model.base_url "" >/dev/null 2>&1
	fi
fi

# Override model if -m was passed
if [ -n "$HERMES_MODEL" ]; then
	hermes config set model.default "$HERMES_MODEL" >/dev/null 2>&1
fi

exec "$@"
