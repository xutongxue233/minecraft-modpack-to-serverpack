# Contributing

Thanks for helping improve Minecraft Serverpack Tool.

## Before You Start

- Check existing issues and releases first.
- Do not commit API keys, tokens, `.env` files, local `config.json`, or unredacted reports.
- For conversion bugs, include Minecraft version, loader, modpack version, and the final part of `logs/latest.log`.

## Development Setup

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

For Windows release artifacts:

```bash
pnpm dist:win
```

## Commit Convention

Use Conventional Commits:

```text
<type>(<scope>): <short summary>
```

Common types:

- `feat`: user-facing feature
- `fix`: bug fix
- `docs`: documentation
- `refactor`: code restructuring without behavior change
- `test`: tests
- `build`: build or packaging
- `ci`: CI/CD
- `rules`: client/server Mod rule updates
- `release`: version and release metadata

Examples:

```text
feat(serverpack): generate optimized batch startup scripts
fix(rules): exclude lightspeed from Forge serverpacks
docs(readme): add Java home setup notes
```

You can use the repository template locally:

```bash
git config commit.template .github/commit-message-template.txt
```

## Pull Requests

Before opening a PR:

- Run relevant checks.
- Update docs when behavior changes.
- Add or update tests for core logic, rules, schemas, and startup script behavior.
- Keep generated release artifacts out of Git.

## Rule Updates

Client-only rules should prefer stable identifiers:

- `modId`
- CurseForge project ID
- Modrinth project ID
- slug

Avoid version-specific file names unless there is no stable identifier.

## Security

Report security issues privately using GitHub Security Advisories. Do not open public issues for secrets, path traversal, command execution, or supply-chain vulnerabilities.
