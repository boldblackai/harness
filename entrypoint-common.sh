#!/bin/bash
# Disable in-container self-update checks/notifications (boldblackai/harness#100).
# Updates inside containers do not survive restarts and can corrupt persisted state.
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_PRUNE=true
