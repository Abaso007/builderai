#!/usr/bin/env bash
# Apply R2 lifecycle rules to the lakehouse bucket for the given environment.
# Run from apps/api: ./scripts/setup-r2-lifecycle.sh <env>
# Requires: WRANGLER_R2_SQL_AUTH_TOKEN not needed for lifecycle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIFECYCLE_FILE="$SCRIPT_DIR/r2-lifecycle.json"

usage() {
  echo "Usage: $0 <environment>"
  echo ""
  echo "Environments:"
  echo "  dev      - unprice-lakehouse-dev"
  echo "  preview  - unprice-lakehouse-preview"
  echo "  prod     - unprice-lakehouse-prod"
  echo ""
  echo "Example:"
  echo "  $0 dev"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

ENV="$1"

case "$ENV" in
  dev)
    BUCKET="unprice-lakehouse-dev"
    ;;
  preview)
    BUCKET="unprice-lakehouse-preview"
    ;;
  prod)
    BUCKET="unprice-lakehouse-prod"
    ;;
  *)
    echo "Error: Unknown environment '$ENV'"
    usage
    ;;
esac

echo "Applying lifecycle rules to bucket: $BUCKET"
echo "Using config: $LIFECYCLE_FILE"
echo ""

cd "$API_DIR"
npx wrangler r2 bucket lifecycle set "$BUCKET" --file "$LIFECYCLE_FILE"

echo ""
echo "Lifecycle rules applied successfully."
echo ""
echo "To verify, run:"
echo "  npx wrangler r2 bucket lifecycle list $BUCKET"
