#!/bin/bash
set -e

seed() {
	[ -d "$1" ] || return 0
	mkdir -p "$2"
	cp -rn "$1"/. "$2"/
}

if [ -z "$HARNESS_CLOUD_MODE" ]; then
	# Local mode: seed defaults into HERMES_HOME
	seed /etc/harness/hermes-defaults/local /home/harness/.hermes
fi
# Cloud mode: agent auto-detects provider from env vars

exec "$@"
