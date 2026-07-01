# Minecraft Modpack to Serverpack

[简体中文](./README.zh-CN.md) | English

Desktop tool for converting Minecraft Java modpacks into server-ready packs. It is designed for modpack maintainers, server owners, and players who need to turn CurseForge, Modrinth, or packwiz client modpacks into a cleaner Minecraft serverpack with clear reports.

Keywords: Minecraft serverpack generator, Minecraft modpack converter, CurseForge server pack, Modrinth server pack, packwiz server pack, client-only mod filtering, Electron desktop app.

## Features

- Desktop application built with Electron, React, TypeScript, and pnpm workspaces.
- Reads CurseForge `.zip`, Modrinth `.mrpack`, and packwiz directories.
- Enriches CurseForge `projectID/fileID` entries through the CurseForge API, so numeric entries become real file names.
- Enriches Modrinth files through SHA-1 version lookup and project metadata.
- Extracts JAR metadata from `fabric.mod.json`, `quilt.mod.json`, `META-INF/mods.toml`, `META-INF/neoforge.mods.toml`, and `mcmod.info`.
- Automatically decides client-only Mods through a remote project-level rule library, user rule files, platform metadata, and JAR metadata.
- Supports a GitHub-hosted project-level client Mod rule library and JSON/YAML user rule files for fixed include/exclude decisions by stable identifiers such as CurseForge project IDs, Modrinth project IDs, mod IDs, and slugs.
- Produces a conversion report with file decisions, rule sources, download status, hashes, and warnings.
- Keeps generating the first report even when individual downloads fail, marking those files as `failed`.
- Generates a serverpack directory with selected `mods/`, server-safe overrides, `server-core.json`, EULA placeholder, JVM args, install scripts, and start scripts.
- Optionally writes a distributable serverpack `.zip` next to the generated directory.
- Selects the server core from pack metadata: Vanilla, Fabric, Quilt, Forge, or NeoForge, including Java version guidance.
- Optional direct server core download/install, so generated packs can start from `start.bat` on Windows or `start.sh` on Linux/macOS after the EULA is accepted.
- Optional optimized launch scripts, `start-optimized.bat` and `start-optimized.sh`, with JVM flags inlined and no extra optimized args file.
- Startup script testing after direct core installation, with logs shown in the desktop task log; the test only verifies startup reaches the EULA gate and does not accept the EULA for you.
- Configurable Java Home for local core installation; generated scripts persist it as `java-home.txt`, then fall back to `JAVA_HOME` and `java` on `PATH`.
- Grouped progress for Mod downloads and server core downloads; Mod downloads show completed counts, percentages, and the current file, while core downloads keep byte progress.

## Current Status

This project is in early MVP development. It now covers parsing, metadata enrichment, downloads, automatic server-side Mod filtering, remote project-level rules, user rule files, initial serverpack directory generation, optional direct server core installation, optional optimized launch scripts, optional zip output, reports, and the desktop workflow. Richer packwiz remote metadata support and release packaging automation will continue to improve.

## Supported Modpack Formats

| Format | Status | Notes |
| --- | --- | --- |
| CurseForge `.zip` | MVP | Requires a CurseForge API key to resolve names and download URLs. |
| Modrinth `.mrpack` | MVP | Uses `modrinth.index.json`, hashes, downloads, and env metadata. |
| packwiz directory | MVP | Reads `pack.toml` and `index.toml`; remote metafile support is still evolving. |

## Why This Exists

Many Minecraft modpacks are distributed as client-first packages. A server pack usually needs different behavior:

- remove known client-only mods by rule;
- preserve server-side mods and shared mods;
- merge server-safe overrides;
- keep hashes and source metadata for auditability;
- generate reports before shipping a runnable server.

This tool aims to make that process visible and repeatable instead of relying on manual file deletion.

## Screenshots

Screenshots and packaged installers are best published through GitHub Releases. Build locally with the commands below until the first public release is attached.

## Getting Started

### Requirements

- Node.js 22 or newer
- pnpm 11
- Windows for current desktop packaging scripts
- Optional: CurseForge API key for CurseForge modpack metadata and download URL resolution

### Install

```bash
pnpm install
```

### Run in development

```bash
pnpm dev
```

### Build

```bash
pnpm build
```

### Package Windows builds

```bash
pnpm dist:win
```

Artifacts are written to `apps/desktop/release/`. That directory is intentionally ignored by Git; publish binaries through GitHub Releases instead of committing them.

## API Key Security

The desktop app does not embed a release CurseForge API key. Keys saved by users are encrypted with Electron `safeStorage` before being written to the local config; legacy plaintext config entries are migrated to encrypted storage on startup, or removed when secure storage is unavailable. Packaged builds use ASAR, compression, and JS minification, but those are not a security boundary for client-embedded secrets.

## Mod Rule Library

The desktop app always enables the GitHub-hosted project-level rule library. The source file is `rules/client-mod-rules.json`; packaged builds fetch it through the GitHub raw URL and cache it locally. The remote library tracks stable project identifiers, not every file version, file ID, or hash.

The desktop app no longer exposes local rule-file selection. Rule fixes should be added to the remote rule library, and matched rules take priority over platform/JAR metadata heuristics.

```json
{
  "include": ["server-helper.jar"],
  "exclude": [
    {
      "source": "curseforge",
      "projectId": "1234",
      "fileId": "5678",
      "reason": "client-only"
    }
  ],
  "rules": [
    {
      "id": "modmenu",
      "side": "client",
      "decision": "exclude",
      "reason": "Client-side Mod menu; not needed on a server.",
      "match": {
        "modrinthProjectIds": ["mOgUt4GM"],
        "curseforgeProjectIds": ["308702"],
        "modIds": ["modmenu"],
        "slugs": ["modmenu"]
      },
      "loaders": ["fabric", "quilt"],
      "minecraftVersions": [">=1.16"]
    }
  ]
}
```

## CurseForge API Key

CurseForge exports usually contain numeric `projectID` and `fileID` values. To display real names and resolve download URLs, configure a CurseForge API key.

Options:

- In the desktop app, paste the key into the CurseForge API Key field.
- Or start the app with `CURSEFORGE_API_KEY` or `CF_API_KEY` set.

The key is stored only in the local app configuration and is not returned to the renderer as plain text. Do not commit keys, tokens, `.env` files, or local `config.json` files.

## Project Structure

```text
apps/desktop/        Electron desktop app
packages/core/       Modpack parsing, metadata enrichment, downloads, reports
packages/shared/     Shared types, schemas, and errors
docs/                Requirements, architecture, and development plan
```

## Development Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm dist:win
```

## Security Notes

- Archive paths are validated to avoid path traversal.
- Download URLs must use HTTPS by default.
- Hashes are verified when the modpack or platform metadata provides supported hashes.
- Sensitive API keys are ignored by Git and should be rotated if they are ever exposed publicly.

## Roadmap

- Improve `overrides/` and `server-overrides/` merge rules with user-editable filters.
- Harden direct loader installation with more compatibility checks and fallback handling.
- Add user-editable client-only and server-only rule sets.
- Add GitHub Release automation for Windows installers and portable builds.
- Improve packwiz remote metadata and hash handling.

## Contributing

Issues and pull requests are welcome. Useful reports include:

- modpack format and source;
- Minecraft version and loader;
- whether a CurseForge API key was configured;
- generated `conversion-report.json` with secrets removed.

## License

MIT License. See [LICENSE](./LICENSE).
