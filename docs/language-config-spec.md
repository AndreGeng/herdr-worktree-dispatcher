# Spec: Unified Output Language

## Objective

Use one top-level `language` setting for plain and team dispatches, including generated human-readable file content. Remove the former team-specific language setting.

## Tech Stack

TypeScript source under `src/` with Node.js tests under `test/`.

## Commands

- Build: `npm run build`
- Test: `npm test`
- Type check: `npm run check`

## Project Structure

- `src/config/`: top-level configuration loading
- `src/prompt/`: plain, leader, and worker prompt generation
- `src/team/`: team profiles and persisted state
- `test/`: behavior tests

## Code Style

```ini
[default]
language = zh-CN
```

Use the existing camelCase TypeScript naming and snake_case config keys.

## Testing Strategy

Cover the default and profile-overridden config values, then assert that plain, leader, and worker prompts apply the configured language to summaries and generated files.

## Boundaries

- Always: preserve existing config precedence and default to `zh-CN`.
- Ask first: introduce a CLI language flag or environment variable.
- Never: retain a separate team-only language source.

## Success Criteria

- `language` is accepted in `[default]` and `[profile.*]`.
- Plain and team prompts use the resolved setting.
- No separate team-specific language setting remains.
- Tests, type checks, and build pass.

## Open Questions

None.
