# Commit Convention

This repository uses Conventional Commits for readable history and release notes.

## Format

```text
<type>(<scope>): <summary>

<body>

<footer>
```

Only the first line is required.

## Types

| Type | Use For |
| --- | --- |
| `feat` | New user-facing behavior |
| `fix` | Bug fixes |
| `docs` | Documentation-only changes |
| `style` | Formatting-only changes |
| `refactor` | Code restructuring without behavior changes |
| `perf` | Performance improvements |
| `test` | Test additions or changes |
| `build` | Build, packaging, dependency changes |
| `ci` | CI/CD changes |
| `chore` | Maintenance tasks |
| `rules` | Client/server Mod rule updates |
| `release` | Version bumps and release metadata |

## Scopes

Use a short subsystem name when it adds clarity:

- `desktop`
- `ui`
- `core`
- `download`
- `metadata`
- `rules`
- `serverpack`
- `startup`
- `docs`
- `release`

## Examples

```text
feat(serverpack): generate optimized batch startup scripts
fix(startup): resolve Forge win_args lookup on Windows
rules(client-mods): exclude lightspeed from Forge serverpacks
docs(readme): add bilingual release instructions
```

## Breaking Changes

Use a footer when a change breaks existing behavior:

```text
BREAKING CHANGE: removed manual review unknown policy from settings schema.
```
