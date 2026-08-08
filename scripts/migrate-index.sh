#!/usr/bin/env bash
# One-off migration: patterns published before the gallery/profile rewrite were
# indexed under `idx:<invTs>-<id>` with metadata {title, author, created}.
# The current worker reads `pidx:` and a richer summary. This rewrites the index
# entries (and the document metadata) in place, then removes the old keys.
#
# Safe to re-run: it skips ids that already have a pidx: entry.
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== reading key list"
npx wrangler kv key list --remote --binding PRESETS > "$TMP/keys.json" 2>/dev/null

node - "$TMP" <<'NODE' > "$TMP/plan.sh"
const fs = require('fs');
const tmp = process.argv[2];
const raw = fs.readFileSync(tmp + '/keys.json', 'utf8');
const keys = JSON.parse(raw.slice(raw.indexOf('[')));

const old = keys.filter(k => k.name.startsWith('idx:'));
const already = new Set(keys.filter(k => k.name.startsWith('pidx:'))
  .map(k => k.name.slice(k.name.lastIndexOf('-') + 1)));

const lines = [];
for (const k of old) {
  const id = k.name.slice(k.name.lastIndexOf('-') + 1);
  if (already.has(id)) { lines.push(`echo "  skip ${id} (already migrated)"`); continue; }
  const m = k.metadata || {};
  const created = m.created || new Date().toISOString();
  const stamp = String(10 ** 13 - Date.parse(created)).padStart(13, '0');
  const pk = `pidx:${stamp}-${id}`;
  const summary = {
    title: m.title || 'untitled',
    desc: '',
    tags: [],
    authorId: '',
    authorName: m.author || 'anonymous',
    authorHandle: '',
    created,
    visibility: 'public',
    parent: '',
    likes: 0,
    pk,
    uk: '',
  };
  const meta = JSON.stringify(summary).replace(/'/g, "'\\''");
  lines.push(`echo "  migrating ${id} (${(m.title || '').replace(/"/g, '')})"`);
  lines.push(`npx wrangler kv key put --remote --binding PRESETS '${pk}' '1' --metadata '${meta}' >/dev/null`);
  // Re-attach the same summary to the document so the pattern page and the
  // ownership checks see the new field names.
  lines.push(`npx wrangler kv key get --remote --binding PRESETS 'preset:${id}' > '${tmp}/${id}.json'`);
  lines.push(`npx wrangler kv key put --remote --binding PRESETS 'preset:${id}' --path '${tmp}/${id}.json' --metadata '${meta}' >/dev/null`);
  lines.push(`npx wrangler kv key delete --remote --binding PRESETS '${k.name}' >/dev/null`);
}
if (!lines.length) lines.push('echo "  nothing to migrate"');
console.log(lines.join('\n'));
NODE

echo "== migrating"
bash "$TMP/plan.sh"
echo "== done"
