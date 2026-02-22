#!/usr/bin/env bash

# Please Use Google Shell Style: https://google.github.io/styleguide/shell.xml

# ---- Start unofficial bash strict mode boilerplate
# http://redsymbol.net/articles/unofficial-bash-strict-mode/
set -o errexit  # always exit on error
set -o errtrace # trap errors in functions as well
set -o pipefail # don't ignore exit codes when piping output
set -o posix    # more strict failures in subshells
# set -x          # enable debugging

EXAMPLE_FILE=".dev.vars.example"
OUTPUT_FILE=".dev.vars"

# Build .dev.vars from .dev.vars.example: use env value if set, else keep existing .dev.vars value
EXISTING_TMP=""
if [[ -f "$OUTPUT_FILE" ]]; then
  EXISTING_TMP=$(mktemp)
  trap 'rm -f "$EXISTING_TMP"' EXIT
  cp "$OUTPUT_FILE" "$EXISTING_TMP"
fi

: > "$OUTPUT_FILE"
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip empty lines and comments
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  key="${line%%=*}"
  [[ -z "$key" ]] && continue
  if [[ -n "${!key}" ]]; then
    printf '%s=%s\n' "$key" "${!key}" >> "$OUTPUT_FILE"
  elif [[ -n "$EXISTING_TMP" ]] && [[ -f "$EXISTING_TMP" ]]; then
    existing_val=$(awk -v key="$key" 'index($0, key "=")==1 { print substr($0, length(key)+2); exit }' "$EXISTING_TMP" 2>/dev/null || true)
    if [[ -n "${existing_val}" ]]; then
      printf '%s=%s\n' "$key" "$existing_val" >> "$OUTPUT_FILE"
    else
      printf '%s=\n' "$key" >> "$OUTPUT_FILE"
    fi
  else
    printf '%s=\n' "$key" >> "$OUTPUT_FILE"
  fi
done < "$EXAMPLE_FILE"

# Run the development command
pnpm dev:wrangler