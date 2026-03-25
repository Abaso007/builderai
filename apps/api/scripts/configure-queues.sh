#!/usr/bin/env bash
# Create Cloudflare Queues declared in wrangler.jsonc.
# Run from apps/api:
#   ./scripts/configure-queues.sh [dev|preview|prod|all] [--dry-run]
set -euo pipefail

# Avoid interactive Wrangler prompts in automation scripts.
export CI="${CI:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER_CONFIG="$API_DIR/wrangler.jsonc"
SCOPE="all"
DRY_RUN=false

usage() {
  echo "Usage: $0 [dev|preview|prod|all] [--dry-run]"
  echo ""
  echo "Creates queues found under env.<name>.queues in wrangler.jsonc."
  echo ""
  echo "Examples:"
  echo "  $0 all"
  echo "  $0 dev"
  echo "  $0 preview --dry-run"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    dev|preview|prod|all)
      SCOPE="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      ;;
  esac
done

list_queues_from_wrangler() {
  local wrangler_config_path="$1"
  local scope="$2"

  node --input-type=module - "$wrangler_config_path" "$scope" <<'NODE'
import { readFileSync } from "node:fs"

const [, , configPath, scope] = process.argv

function stripJsonComments(text) {
  let result = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false
  let stringDelimiter = ""

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]
    const next = text[index + 1]

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false
        result += current
      }
      continue
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      result += current

      if (escaped) {
        escaped = false
        continue
      }

      if (current === "\\") {
        escaped = true
        continue
      }

      if (current === stringDelimiter) {
        inString = false
        stringDelimiter = ""
      }

      continue
    }

    if (current === '"' || current === "'") {
      inString = true
      stringDelimiter = current
      result += current
      continue
    }

    if (current === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (current === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    result += current
  }

  return result
}

function collectQueues(envConfig) {
  const queueSet = new Set()
  const queues = envConfig?.queues

  if (!queues || typeof queues !== "object") {
    return queueSet
  }

  const producers = Array.isArray(queues.producers) ? queues.producers : []
  for (const producer of producers) {
    if (typeof producer?.queue === "string" && producer.queue.length > 0) {
      queueSet.add(producer.queue)
    }
  }

  const consumers = Array.isArray(queues.consumers) ? queues.consumers : []
  for (const consumer of consumers) {
    if (typeof consumer?.queue === "string" && consumer.queue.length > 0) {
      queueSet.add(consumer.queue)
    }

    if (
      typeof consumer?.dead_letter_queue === "string" &&
      consumer.dead_letter_queue.length > 0
    ) {
      queueSet.add(consumer.dead_letter_queue)
    }
  }

  return queueSet
}

const content = readFileSync(configPath, "utf8")
const config = JSON.parse(stripJsonComments(content))
const envConfig = config?.env

if (!envConfig || typeof envConfig !== "object") {
  console.error(`No env block found in ${configPath}`)
  process.exit(1)
}

const selectedEnvs =
  scope === "all" ? Object.keys(envConfig) : [scope]

for (const envName of selectedEnvs) {
  if (!(envName in envConfig)) {
    console.error(`Environment '${envName}' was not found in ${configPath}`)
    process.exit(1)
  }
}

const result = new Set()
for (const envName of selectedEnvs) {
  const queues = collectQueues(envConfig[envName])
  for (const queue of queues) {
    result.add(queue)
  }
}

for (const queue of result) {
  process.stdout.write(`${queue}\n`)
}
NODE
}

create_queue() {
  local queue_name="$1"
  local output=""

  if output="$(npx wrangler queues create "$queue_name" 2>&1)"; then
    if [[ -n "$output" ]]; then
      printf "%s\n" "$output"
    fi
    return 0
  fi

  if printf "%s" "$output" | grep -Eiq "(already exists|code:[[:space:]]*1002)"; then
    echo ">>> Queue already exists: $queue_name"
    return 0
  fi

  printf "%s\n" "$output" >&2
  return 1
}

cd "$API_DIR"

queues=()
while IFS= read -r queue_name; do
  if [[ -n "$queue_name" ]]; then
    queues+=("$queue_name")
  fi
done < <(list_queues_from_wrangler "$WRANGLER_CONFIG" "$SCOPE")

if [[ ${#queues[@]} -eq 0 ]]; then
  echo "No queues found in $WRANGLER_CONFIG for scope '$SCOPE'."
  exit 0
fi

echo "=== Queue scope: $SCOPE ==="
echo "=== Wrangler config: $WRANGLER_CONFIG ==="
echo "=== Queues to ensure: ${#queues[@]} ==="
printf "  - %s\n" "${queues[@]}"
echo ""

for queue_name in "${queues[@]}"; do
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] npx wrangler queues create $queue_name"
    continue
  fi

  echo ">>> Ensuring queue: $queue_name"
  create_queue "$queue_name"
  echo ""
done

echo "Done."
