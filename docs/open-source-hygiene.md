# Open-Source Hygiene

## Objective

Prevent credentials, personal machine paths, private tenant identifiers, internal names, and private commit identities from entering published files or reachable Git history. Public rules live in this repository. Exact private terms must remain outside it.

Success means every commit passes the staged scan, every push passes the history scan, and GitHub CI blocks changes that fail public hygiene, type checking, tests, dependency audit, or Gitleaks.

## Commands

```bash
# Install a trusted scanner and hook snapshot once per clone
npm run hooks:install

# Scan the tracked checkout
npm run hygiene

# Scan content currently staged for commit and the pending commit identity
npm run hygiene:staged

# Scan patches and identities in every reachable commit
npm run hygiene:history

# Require the external private denylist before publishing
npm run hygiene:release

# Full local verification
npm run check
npm test
npm audit --audit-level=high
```

The scanner reports only the source and rule label. It never prints a matched private value.

## Private Denylist

Store one literal value per line. Blank lines and lines beginning with `#` are ignored. Entries must contain at least two Unicode characters. Release checks require at least one entry.

The scanner checks these locations in order:

1. `OPEN_SOURCE_DENYLIST_FILE`, when set.
2. `.open-source-denylist.local` in the repository root.
3. `~/.config/herdr-worktree-dispatcher/open-source-denylist.txt`.

`.open-source-denylist.local` is ignored by Git. The home-directory path is recommended because it cannot be staged accidentally.

```bash
mkdir -p ~/.config/herdr-worktree-dispatcher
$EDITOR ~/.config/herdr-worktree-dispatcher/open-source-denylist.txt
```

Never put real private terms in tests, examples, issues, workflow files, or encoded string fragments. The denylist itself is sensitive operational configuration.

`npm publish` runs `prepublishOnly`, which invokes `npm run release:check`. Publishing therefore fails unless a nonempty denylist outside the repository exists and passes the full-history scan, type check, tests, and dependency audit. A force-added ignored file inside the repository is not accepted for release checks.

`npm run hooks:install` copies the reviewed scanner and hooks into `<git-dir>/herdr-hygiene/` and points Git at that copy. This trust boundary matters: an untrusted branch can modify repository scripts, but it cannot replace the installed copy merely by being checked out. Reinstall only from reviewed code when intentionally updating the scanner.

## Commit Identity

Configure a public GitHub noreply identity in each clone:

```bash
git config --local user.name AndreGeng
git config --local user.email AndreGeng@users.noreply.github.com
```

Add private email addresses or domains to the external denylist. The pre-commit scan checks the pending author and committer identities; the pre-push scan checks identities already recorded in reachable history.

## GitHub CI

`.github/workflows/ci.yml` uses read-only repository permissions, checks out full history, pins every action to a full commit SHA, and runs:

- public history hygiene
- TypeScript checking
- the full test suite
- `npm audit --audit-level=high`
- Gitleaks across Git history

The private denylist is deliberately not sent to GitHub Actions. Workflow code comes from the repository under review, so giving it the denylist would let a malicious change print or transmit the values.

For an external contribution, check out the proposed commit and invoke the installed trusted scanner directly before approval:

```bash
trusted_scanner="$(git rev-parse --absolute-git-dir)/herdr-hygiene/check-public-hygiene.mjs"
node "$trusted_scanner" --history
```

Fork and Dependabot runs receive the same public checks and Gitleaks as trusted branches. A maintainer's review plus the trusted local scan is the private-identifier gate.

Protect `main` in the repository settings:

- require the `quality` status check
- require pull requests before merging
- prevent force pushes and branch deletion
- require review for changes under `.github/workflows/`

## Project Structure

- `scripts/check-public-hygiene.mjs`: reviewed source for public rules, external denylist loading, and staged/tracked/history modes
- `.githooks/pre-commit`: staged-content hook template
- `.githooks/pre-push`: reachable-history and optional local Gitleaks hook template
- `scripts/install-git-hooks.sh`: copies trusted snapshots inside `.git` and activates them per clone
- `.github/workflows/ci.yml`: required remote quality gate
- `test/openSourceHygiene.test.mjs`: scanner, hook, workflow, and packaging regression coverage

## Boundaries

Always:

- keep exact private identifiers outside the repository
- run the full-history scan before pushing or publishing
- rotate any credential that was committed, even if history is later rewritten
- review `npm pack --dry-run` before npm publication

Never:

- bypass a failed hook with `--no-verify`
- weaken a rule only to make a failing scan pass
- pass the private denylist to workflow code or a scanner from an untrusted checkout
- use `pull_request_target` to execute untrusted pull-request code with secrets
- assume deleting a file from HEAD removes it from Git history

## Testing Strategy

Unit tests validate public rules and denylist redaction. Integration tests create temporary Git repositories to verify staged and history failures. Static workflow tests ensure action references stay SHA-pinned and all required CI gates remain present.

## Sources

- GitHub Actions secure use and full-SHA pinning: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
- Gitleaks Action usage: https://github.com/gitleaks/gitleaks-action
