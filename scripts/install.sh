#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cli_path="${repo_root}/dist/cli.js"

if [ ! -f "$cli_path" ]; then
  printf 'error: TypeScript dispatcher is not built: %s\n' "$cli_path" >&2
  printf 'Run: npm install && npm run build\n' >&2
  exit 1
fi

exec node "$cli_path" install --link-skill "$@"
