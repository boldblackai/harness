#!/bin/bash
set -e

# Disable in-container self-update notifications (#100).
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

seed() {
  [ -d "$1" ] || return 0
  mkdir -p "$2"
  cp -rn "$1"/. "$2"/
}

seed /etc/harness/pi-defaults /home/harness/.pi/agent

exec "$@"
