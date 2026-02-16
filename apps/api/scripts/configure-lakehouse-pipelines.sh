#!/usr/bin/env bash
#
# Configure Cloudflare Pipelines + R2 Data Catalog sinks for lakehouse sources.
# Assumes R2 buckets already exist.
#
# Run from apps/api:
#   ./scripts/configure-lakehouse-pipelines.sh <environment> [options]
#
# Options:
#   --skip-lifecycle
#   --skip-compaction
#   --name-prefix <prefix>
#   --name-suffix <suffix>   (default: "_<environment>")
#
set -euo pipefail

# Avoid interactive Wrangler prompts in automation scripts.
export CI="${CI:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS_DIR="$SCRIPT_DIR/schemas"

SKIP_LIFECYCLE=false
SKIP_COMPACTION=false
RECREATE=false
DELETE_ONLY=false
ROLL_INTERVAL=60
NAMESPACE="lakehouse"
NAME_PREFIX=""
NAME_SUFFIX=""

usage() {
  echo "Usage: $0 <environment> [options]"
  echo ""
  echo "Environments: dev | preview | prod"
  echo ""
  echo "Options:"
  echo "  --skip-lifecycle          Do not apply R2 lifecycle rules"
  echo "  --skip-compaction         Do not enable catalog compaction"
  echo "  --recreate                Delete existing pipelines/sinks/streams and recreate"
  echo "  --delete-only             Delete pipelines/sinks/streams and exit"
  echo "  --name-prefix <prefix>    Prefix for stream/sink/pipeline names"
  echo "  --name-suffix <suffix>    Suffix for stream/sink/pipeline names (default: _<environment>)"
  echo ""
  echo "Required env: WRANGLER_R2_SQL_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN) for catalog and sinks"
  echo ""
  echo "Example:"
  echo "  WRANGLER_R2_SQL_AUTH_TOKEN=\$(cat .token) $0 preview"
  exit 1
}

resource_name() {
  local source="$1"
  local kind="$2"
  echo "${NAME_PREFIX}lakehouse_${source}_${kind}${NAME_SUFFIX}"
}

find_resource_id() {
  local kind="$1"
  local name="$2"
  local list_output=""

  case "$kind" in
    pipeline)
      if ! list_output="$(npx wrangler pipelines list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    stream)
      if ! list_output="$(npx wrangler pipelines streams list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    sink)
      if ! list_output="$(npx wrangler pipelines sinks list --json --per-page 1000 2>/dev/null)"; then
        echo ""
        return 0
      fi
      ;;
    *)
      echo ""
      return 0
      ;;
  esac

  printf "%s" "$list_output" | node -e '
const fs = require("node:fs")
const input = fs.readFileSync(0, "utf8")
const needle = process.argv[1]
let parsed
try {
  parsed = JSON.parse(input)
} catch {
  process.stdout.write("")
  process.exit(0)
}

function toArray(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []

  for (const key of ["result", "results", "items", "data", "pipelines", "streams", "sinks"]) {
    if (Array.isArray(value[key])) return value[key]
  }

  for (const item of Object.values(value)) {
    if (Array.isArray(item)) return item
  }

  return []
}

const rows = toArray(parsed)
const match = rows.find((row) => {
  if (!row || typeof row !== "object") return false
  const names = [
    row.name,
    row.pipeline,
    row.pipeline_name,
    row.stream,
    row.stream_name,
    row.sink,
    row.sink_name,
  ]
  return names.some((value) => value === needle)
})

if (!match) {
  process.stdout.write("")
  process.exit(0)
}

const id =
  match.id ??
  match.uuid ??
  match.pipeline_id ??
  match.stream_id ??
  match.sink_id

if (typeof id === "string" || typeof id === "number") {
  process.stdout.write(String(id))
  process.exit(0)
}

process.stdout.write("")
' "$name"
}

resource_exists() {
  local kind="$1"
  local name="$2"
  [[ -n "$(find_resource_id "$kind" "$name")" ]]
}

ensure_created() {
  local kind="$1"
  local name="$2"
  shift 2

  local output=""
  if output="$("$@" 2>&1)"; then
    if [[ -n "$output" ]]; then
      printf "%s\n" "$output"
    fi
    return 0
  fi

  if printf "%s" "$output" | grep -Eiq "(already exists|code:[[:space:]]*1002)"; then
    echo ">>> ${kind} already exists (create returned already exists): $name"
    return 0
  fi

  printf "%s\n" "$output" >&2
  return 1
}

delete_resource_if_exists() {
  local kind="$1"
  local name="$2"
  local id
  id="$(find_resource_id "$kind" "$name")"

  if [[ -z "$id" ]]; then
    echo "No $kind found for '$name'; skipping delete."
    return 0
  fi

  echo ">>> Deleting $kind: $name (id: $id)"
  case "$kind" in
    pipeline)
      npx wrangler pipelines delete "$id" --force
      ;;
    sink)
      npx wrangler pipelines sinks delete "$id" --force
      ;;
    stream)
      npx wrangler pipelines streams delete "$id" --force
      ;;
    *)
      echo "Unsupported resource kind for delete: $kind"
      return 1
      ;;
  esac
}

if [[ $# -lt 1 ]]; then
  usage
fi

ENV="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-lifecycle)
      SKIP_LIFECYCLE=true
      shift
      ;;
    --skip-compaction)
      SKIP_COMPACTION=true
      shift
      ;;
    --recreate)
      RECREATE=true
      shift
      ;;
    --delete-only)
      DELETE_ONLY=true
      shift
      ;;
    --name-prefix)
      NAME_PREFIX="${2:-}"
      if [[ -z "$NAME_PREFIX" ]]; then
        echo "Missing value for --name-prefix"
        usage
      fi
      shift 2
      ;;
    --name-suffix)
      NAME_SUFFIX="${2:-}"
      if [[ -z "$NAME_SUFFIX" ]]; then
        echo "Missing value for --name-suffix"
        usage
      fi
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [[ -z "$NAME_SUFFIX" ]]; then
  NAME_SUFFIX="_${ENV}"
fi

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

TOKEN_SOURCE=""
if [[ -z "${WRANGLER_R2_SQL_AUTH_TOKEN:-}" ]]; then
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    export WRANGLER_R2_SQL_AUTH_TOKEN="$CLOUDFLARE_API_TOKEN"
    TOKEN_SOURCE="CLOUDFLARE_API_TOKEN"
  elif [[ "$DELETE_ONLY" != true ]]; then
    echo "Error: WRANGLER_R2_SQL_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN) is required."
    echo "Create token with: Workers R2 Data Catalog (Read+Edit), Workers Pipelines (Read+Send+Edit), Workers R2 Storage (Read+Edit)."
    exit 1
  fi
else
  TOKEN_SOURCE="WRANGLER_R2_SQL_AUTH_TOKEN"
fi

echo "=== Environment: $ENV | Bucket: $BUCKET ==="
echo "=== Resource name format: ${NAME_PREFIX}lakehouse_<source>_<stream|sink|pipeline>${NAME_SUFFIX} ==="
if [[ "$DELETE_ONLY" != true && -n "$TOKEN_SOURCE" ]]; then
  echo "=== Using API token from: $TOKEN_SOURCE ==="
fi
echo ""

STREAM_SPECS=(
  "usage:usage:usage"
  "verifications:verifications:verification"
  "metadata:metadata:metadata"
  "entitlements:entitlements:entitlement_snapshot"
)

if [[ "$RECREATE" == true || "$DELETE_ONLY" == true ]]; then
  echo ">>> Cleanup mode: deleting existing pipelines/sinks/streams for this environment naming scheme"
  for spec in "${STREAM_SPECS[@]}"; do
    source="${spec%%:*}"
    pipeline_name="$(resource_name "$source" "pipeline")"
    sink_name="$(resource_name "$source" "sink")"
    stream_name="$(resource_name "$source" "stream")"

    delete_resource_if_exists "pipeline" "$pipeline_name"
    delete_resource_if_exists "sink" "$sink_name"
    delete_resource_if_exists "stream" "$stream_name"
    echo ""
  done
fi

if [[ "$DELETE_ONLY" == true ]]; then
  echo "Delete-only mode complete."
  exit 0
fi

echo ">>> Verifying bucket exists: $BUCKET"
if ! npx wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "Error: bucket '$BUCKET' not found or inaccessible. Create it first, then rerun."
  exit 1
fi
echo "Bucket exists."
echo ""

# --- 1. Enable R2 Data Catalog ---
echo ">>> Enabling R2 Data Catalog on bucket: $BUCKET"
npx wrangler r2 bucket catalog enable "$BUCKET" || echo "Catalog may already be enabled."
echo ""

# --- 2. (Optional) Enable compaction ---
if [[ "$SKIP_COMPACTION" != true ]]; then
  echo ">>> Enabling R2 Data Catalog compaction on bucket: $BUCKET"
  npx wrangler r2 bucket catalog compaction enable "$BUCKET" --token "$WRANGLER_R2_SQL_AUTH_TOKEN" || true
  echo ""
fi

# --- 3. Create streams for each source ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  schema_file="$(echo "$spec" | cut -d: -f2).json"
  stream_name="$(resource_name "$source" "stream")"
  schema_path="$SCHEMAS_DIR/$schema_file"
  if [[ ! -f "$schema_path" ]]; then
    echo "Schema not found: $schema_path"
    exit 1
  fi
  if resource_exists "stream" "$stream_name"; then
    echo ">>> Stream already exists: $stream_name"
  else
    echo ">>> Creating stream: $stream_name (schema: $schema_file)"
    ensure_created "Stream" "$stream_name" \
      npx wrangler pipelines streams create "$stream_name" \
      --schema-file "$schema_path" \
      --http-enabled true \
      --http-auth true
    echo "Ensured $stream_name"
  fi
  echo ""
done

# --- 4. Create sinks for each source ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  table="$(echo "$spec" | cut -d: -f3)"
  sink_name="$(resource_name "$source" "sink")"

  if resource_exists "sink" "$sink_name"; then
    echo ">>> Sink already exists: $sink_name"
  else
    echo ">>> Creating sink: $sink_name -> $NAMESPACE.$table"
    ensure_created "Sink" "$sink_name" \
      npx wrangler pipelines sinks create "$sink_name" \
      --type "r2-data-catalog" \
      --bucket "$BUCKET" \
      --roll-interval "$ROLL_INTERVAL" \
      --namespace "$NAMESPACE" \
      --table "$table" \
      --catalog-token "$WRANGLER_R2_SQL_AUTH_TOKEN"
    echo "Ensured $sink_name"
  fi
  echo ""
done

# --- 5. Create pipelines (stream -> sink) ---
for spec in "${STREAM_SPECS[@]}"; do
  source="$(echo "$spec" | cut -d: -f1)"
  stream_name="$(resource_name "$source" "stream")"
  sink_name="$(resource_name "$source" "sink")"
  pipeline_name="$(resource_name "$source" "pipeline")"

  if resource_exists "pipeline" "$pipeline_name"; then
    echo ">>> Pipeline already exists: $pipeline_name"
  else
    echo ">>> Creating pipeline: $pipeline_name (INSERT INTO $sink_name SELECT * FROM $stream_name)"
    ensure_created "Pipeline" "$pipeline_name" \
      npx wrangler pipelines create "$pipeline_name" \
      --sql "INSERT INTO $sink_name SELECT * FROM $stream_name"
    echo "Ensured $pipeline_name"
  fi
  echo ""
done

# --- 6. Apply R2 lifecycle rules ---
if [[ "$SKIP_LIFECYCLE" != true ]]; then
  echo ">>> Applying R2 lifecycle rules"
  "$SCRIPT_DIR/setup-r2-lifecycle.sh" "$ENV"
  echo ""
fi

echo "=== Done. ==="
echo ""
echo "Created or ensured:"
echo "  Streams:   ${NAME_PREFIX}lakehouse_<usage|verifications|metadata|entitlements>_stream${NAME_SUFFIX}"
echo "  Sinks:     ${NAME_PREFIX}lakehouse_<usage|verifications|metadata|entitlements>_sink${NAME_SUFFIX}"
echo "  Pipelines: ${NAME_PREFIX}lakehouse_<usage|verifications|metadata|entitlements>_pipeline${NAME_SUFFIX}"
echo ""
echo "Next steps:"
echo "  - Get stream ingest endpoints: npx wrangler pipelines streams list"
echo "  - Query R2 SQL: npx wrangler r2 sql query \"<WAREHOUSE>\" \"SELECT * FROM $NAMESPACE.usage LIMIT 10\""
