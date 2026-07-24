# Contributing

## Before Opening A Pull Request

1. Install dependencies with `npm ci`.
2. Install local hygiene hooks with `npm run hooks:install`.
3. Run `npm run check`, `npm test`, and `npm run hygiene:history`.
4. Do not add credentials, private tenant information, personal paths, or internal identifiers. See [Open-Source Hygiene](docs/open-source-hygiene.md).

## Changes

- Keep changes focused and include regression tests for behavior changes.
- Use descriptive commit messages.
- Do not bypass hooks with `--no-verify`.
- Do not add external dependencies unless the existing platform cannot solve the problem.

## Reporting Bugs

Open a GitHub issue with a minimal reproduction, expected behavior, actual behavior, and the commands you ran. Do not include credentials or private project details.
