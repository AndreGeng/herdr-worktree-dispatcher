#!/bin/bash
set -e

repo_root="$(git rev-parse --show-toplevel)"
git_dir="$(git -C "$repo_root" rev-parse --absolute-git-dir)"
install_root="$git_dir/herdr-hygiene"
hooks_dir="$install_root/hooks"
mkdir -p "$hooks_dir"
cp "$repo_root/scripts/check-public-hygiene.mjs" "$install_root/check-public-hygiene.mjs"
cp "$repo_root/.githooks/pre-commit" "$hooks_dir/pre-commit"
cp "$repo_root/.githooks/pre-push" "$hooks_dir/pre-push"
chmod +x "$install_root/check-public-hygiene.mjs" "$hooks_dir/pre-commit" "$hooks_dir/pre-push"
git -C "$repo_root" config core.hooksPath "$hooks_dir"

printf 'Installed trusted hygiene hooks inside the Git directory\n' >&2
printf '{"hooksPath":"<git-dir>/herdr-hygiene/hooks"}\n'
