#!/usr/bin/env bash
#
# Configure R2 buckets, Data Catalog, and Cloudflare Pipelines for the lakehouse
# sources: verifications, usage, metadata, entitlements.
#
# Iceberg: Table schema = stream schema (schemas/*.json) + __ingest_ts.
# Partition = DAY(__ingest_ts) only (not configurable for r2-data-catalog).
# See scripts/docs/iceberg-schema-and-partitioning.md.
#
# Run from apps/api:
#   ./scripts/configure-r2-and-pipelines.sh <environment> [--skip-buckets] [--skip-lifecycle] [--skip-compaction]
#
# Prerequisites:
#   - npx wrangler login
#   - WRANGLER_R2_SQL_AUTH_TOKEN for catalog and pipeline sinks (create token with
#     Workers R2 Data Catalog Read+Edit, Workers Pipelines Read+Send+Edit, Workers R2 Storage Read+Edit)
#   - R2 buckets may already exist (created via wrangler.jsonc bindings); use --skip-buckets to only do catalog/pipelines.
#
# See: https://developers.cloudflare.com/r2-sql/tutorials/end-to-end-pipeline/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS_DIR="$SCRIPT_DIR/schemas"

# Defaults
SKIP_BUCKETS=false
SKIP_LIFECYCLE=false
SKIP_COMPACTION=false
ROLL_INTERVAL=60
NAMESPACE="lakehouse"

usage() {
  echo "Usage: $0 <environment> [options]"
  echo ""
  echo "Environments: dev | preview | prod"
  echo ""
  echo "Options:"
  echo "  --skip-buckets    Do not create buckets (use existing from wrangler env)"
  echo "  --skip-lifecycle  Do not apply R2 lifecycle rules"
  echo "  --skip-compaction Do not enable catalog compaction"
  echo ""
  echo "Required env: WRANGLER_R2_SQL_AUTH_TOKEN (for catalog and sinks)"
  echo ""
  echo "Example:"
  echo "  WRANGLER_R2_SQL_AUTH_TOKEN=\$(cat .token) $0 dev"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

ENV="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-buckets)   SKIP_BUCKETS=true;   shift ;;
    --skip-lifecycle) SKIP_LIFECYCLE=true; shift ;;
    --skip-compaction) SKIP_COMPACTION=true; shift ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

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

cd "$API_DIR"

if [[ -z "${WRANGLER_R2_SQL_AUTH_TOKEN:-}" ]]; then
  echo "Warning: WRANGLER_R2_SQL_AUTH_TOKEN is not set. Catalog enable and pipeline sinks will fail."
  echo "Create a token with: Workers R2 Data Catalog (Read+Edit), Workers Pipelines (Read+Send+Edit), Workers R2 Storage (Read+Edit)."
  read -r -p "Continue anyway? [y/N] " c
  if [[ "${c:-n}" != "y" && "${c:-n}" != "Y" ]]; then
    exit 1
  fi
fi

echo "=== Environment: $ENV | Bucket: $BUCKET ==="
echo ""

# --- 1. Create R2 bucket (optional) ---
if [[ "$SKIP_BUCKETS" != true ]]; then
  echo ">>> Creating R2 bucket if not exists: $BUCKET"
  if ! npx wrangler r2 bucket create "$BUCKET" --jurisdiction "eu" 2>/dev/null; then
    echo "Bucket $BUCKET may already exist; skipping."
  else
    echo "Bucket $BUCKET created."
  fi
  echo ""
fi

# --- 2. Enable R2 Data Catalog ---
echo ">>> Enabling R2 Data Catalog on bucket: $BUCKET"
npx wrangler r2 bucket catalog enable "$BUCKET" --jurisdiction "eu" || echo "Catalog may already be enabled."
echo ""

# --- 3. (Optional) Enable compaction ---
if [[ "$SKIP_COMPACTION" != true ]] && [[ -n "${WRANGLER_R2_SQL_AUTH_TOKEN:-}" ]]; then
  echo ">>> Enabling R2 Data Catalog compaction on bucket: $BUCKET"
  npx wrangler r2 bucket catalog compaction enable "$BUCKET" --jurisdiction "eu" --token "$WRANGLER_R2_SQL_AUTH_TOKEN" || true
  echo ""
fi

# --- 4. Create streams for each source ---
STREAMS=(
  "usage:usage"
  "verifications:verifications"
  "metadata:metadata"
  "entitlements:entitlements"
)

for entry in "${STREAMS[@]}"; do
  name="${entry%%:*}"
  schema_file="${entry##*:}.json"
  stream_name="lakehouse_${name}_stream"
  schema_path="$SCHEMAS_DIR/$schema_file"
  if [[ ! -f "$schema_path" ]]; then
    echo "Schema not found: $schema_path"
    exit 1
  fi
  echo ">>> Creating stream: $stream_name (schema: $schema_file)"
  if ! npx wrangler pipelines streams create "$stream_name" \
    --schema-file "$schema_path" \
    --http-enabled true \
    --http-auth true 2>/dev/null; then
    echo "Stream $stream_name may already exist; skipping."
  else
    echo "Created $stream_name"
  fi
  echo ""
done

# --- 5. Create sinks for each source ---
SINK_TABLES=(usage verification metadata entitlement_snapshot)
for i in "${!STREAMS[@]}"; do
  entry="${STREAMS[$i]}"
  name="${entry%%:*}"
  table="${SINK_TABLES[$i]}"
  sink_name="lakehouse_${name}_sink"
  echo ">>> Creating sink: $sink_name -> $NAMESPACE.$table"
  if ! npx wrangler pipelines sinks create "$sink_name" \
    --type "r2-data-catalog" \
    --bucket "$BUCKET" \
    --roll-interval "$ROLL_INTERVAL" \
    --namespace "$NAMESPACE" \
    --table "$table" \
    --catalog-token "${WRANGLER_R2_SQL_AUTH_TOKEN:?WRANGLER_R2_SQL_AUTH_TOKEN required for sinks}" 2>/dev/null; then
    echo "Sink $sink_name may already exist; skipping."
  else
    echo "Created $sink_name"
  fi
  echo ""
done

# --- 6. Create pipelines (stream -> sink) ---
for entry in "${STREAMS[@]}"; do
  name="${entry%%:*}"
  stream_name="lakehouse_${name}_stream"
  sink_name="lakehouse_${name}_sink"
  pipeline_name="lakehouse_${name}_pipeline"
  echo ">>> Creating pipeline: $pipeline_name (INSERT INTO $sink_name SELECT * FROM $stream_name)"
  if ! npx wrangler pipelines create "$pipeline_name" \
    --sql "INSERT INTO $sink_name SELECT * FROM $stream_name" 2>/dev/null; then
    echo "Pipeline $pipeline_name may already exist; skipping."
  else
    echo "Created $pipeline_name"
  fi
  echo ""
done

# --- 7. Apply R2 lifecycle rules ---
if [[ "$SKIP_LIFECYCLE" != true ]]; then
  echo ">>> Applying R2 lifecycle rules"
  "$SCRIPT_DIR/setup-r2-lifecycle.sh" "$ENV"
  echo ""
fi

echo "=== Done. ==="
echo ""
echo "Next steps:"
echo "  - Get stream HTTP ingest endpoints: npx wrangler pipelines streams list"
echo "  - Query with R2 SQL: npx wrangler r2 sql query \"<WAREHOUSE>\" \"SELECT * FROM $NAMESPACE.usage LIMIT 10\""
echo "  - Warehouse name is typically <ACCOUNT_ID>_<BUCKET_NAME> (e.g. from 'wrangler r2 bucket catalog enable' output)."
