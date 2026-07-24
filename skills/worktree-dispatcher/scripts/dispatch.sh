#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dispatch="scripts/dispatch.sh"
package_dispatch="$(cd "${script_dir}/../../.." && pwd -P)/scripts/dispatch.sh"

if [ -f "$repo_dispatch" ]; then
  exec bash "$repo_dispatch" "$@"
fi

if [ -f "$package_dispatch" ]; then
  exec bash "$package_dispatch" "$@"
fi

if command -v herdr-worktree-dispatcher >/dev/null 2>&1; then
  exec herdr-worktree-dispatcher "$@"
fi

printf 'error: dispatcher not found. checked: %s, %s, and PATH\n' "$repo_dispatch" "$package_dispatch" >&2
printf 'skill wrapper path: %s\n' "$script_dir/dispatch.sh" >&2
exit 1
