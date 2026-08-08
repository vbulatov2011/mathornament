#!/usr/bin/env bash
# One-shot Cloudflare deploy for MathOrnament.
# Prereq: npx wrangler login   (opens a browser for OAuth)
set -euo pipefail
cd "$(dirname "$0")"

echo "== Checking Cloudflare auth"
npx wrangler whoami

# Create the KV namespace if the config still has the local-dev placeholder.
if grep -q '"id": "00000000000000000000000000000000"' wrangler.jsonc; then
  echo "== Creating KV namespace PRESETS"
  out=$(npx wrangler kv namespace create PRESETS 2>&1) || { echo "$out"; exit 1; }
  echo "$out"
  id=$(echo "$out" | grep -oE '"id": "[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1)
  if [ -z "$id" ]; then echo "Could not parse namespace id — paste it into wrangler.jsonc manually."; exit 1; fi
  # Replace the placeholder id in wrangler.jsonc
  perl -pi -e "s/00000000000000000000000000000000/$id/" wrangler.jsonc
  echo "== wrangler.jsonc updated with namespace id $id"
fi

echo "== Deploying"
npx wrangler deploy

echo "== Done. The URL above is your live site."
