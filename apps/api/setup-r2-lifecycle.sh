#!/usr/bin/env bash
# Delegates to scripts folder. Prefer: ./scripts/setup-r2-lifecycle.sh <env>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/scripts/setup-r2-lifecycle.sh" "$@"
