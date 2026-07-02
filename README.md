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
- Tries MCIM mirror URLs before falling back to CurseForge/Modrinth official CDNs for Mod files; BMCLAPI remains scoped to core/loader resources.
- Generates a serverpack directory with selected `mods/`, server-safe overrides, `server-core.json`, EULA placeholder, JVM args, install scripts, and start scripts.
- Copies server-safe `overrides/` files as raw files instead of parsing config JSON, which keeps legacy mod configs compatible.
- Optionally writes a distributable serverpack `.zip` next to the generated directory.
- Selects the server core from pack metadata: Vanilla, Fabric, Quilt, Forge, or NeoForge, including Java version guidance.
- Optional direct server core download/install, so generated packs can start from `start.bat` on Windows or `start.sh` on Linux/macOS after the EULA is accepted.
- Optional optimized launch scripts, `start-optimized.bat` and `start-optimized.sh`, with JVM flags inlined and no extra optimized args file.
- Startup script testing after direct core installation, with logs shown in the desktop task log; the test only verifies startup reaches the EULA gate and does not accept the EULA for you.
- Configurable Java Home for local core installation; direct core install also follows PCL-style candidate paths and keyword recursive search to auto-select a compatible local Java runtime.
- Generated scripts persist the selected Java Home as `java-home.txt`, then fall back to `JAVA_HOME` and `java` on `PATH`.
- Grouped progress for Mod downloads and server core downloads; Mod downloads show completed counts, percentages, and the current file, while core downloads keep byte progress.

## Current Status

This project is in early MVP development. It now covers parsing, metadata enrichment, downloads, automatic server-side Mod filtering, remote project-level rules, initial serverpack directory generation, optional direct server core installation, optional optimized launch scripts, optional zip output, reports, and the desktop workflow.

Compatibility is expanded through real modpack smoke tests and automated integration tests. A listed Minecraft version means the workflow below has been tested in this repository; it is not a guarantee that every modpack for that version can run without rule updates.

## Supported Modpack Formats

| Format | Status | Notes |
| --- | --- | --- |
| CurseForge `.zip` | MVP | Requires a CurseForge API key to resolve names and download URLs. |
| Modrinth `.mrpack` | MVP | Uses `modrinth.index.json`, hashes, downloads, and env metadata. |
| packwiz directory | MVP | Reads `pack.toml` and `index.toml`; remote metafile support is still evolving. |

## Tested Minecraft Versions

| Minecraft | Loader / Core | Test Pack or Scenario | Tested Coverage | Status |
| --- | --- | --- | --- | --- |
| 1.20.1 | Forge 47.4.10 | CurseForge zip, TerraFirmaFarHorizons v1.3.1 | Manifest parsing, CurseForge metadata, Mod/core downloads, client Mod filtering, report generation, serverpack scripts, optimized script flow | Tested |
| 1.20.1 | Fabric 0.15.x | Modrinth `.mrpack` integration fixture | Hash-verified Mod download, env-based filtering, report generation, zip output | Automated integration |
| 1.20.1 | Vanilla | Generated integration fixture | Direct `server.jar` download, generated launch scripts, startup test to EULA gate | Automated integration |
| 1.12.2 | Forge 14.23.5.2860 | CurseForge zip, RLCraft v2.9.3 | Manifest parsing, raw `overrides/` copy, malformed legacy `mcmod.info` tolerance, legacy Forge install artifacts, optimized script startup to EULA gate | Startup smoke tested; full runtime still depends on Mod download/rule coverage |

When adding compatibility claims, prefer a real pack smoke test plus a generated `conversion-report.json`. If a pack only parses but has not reached script startup, mark it as partial.

## Overrides Policy

`overrides/` and `server-overrides/` are treated as file trees, not as structured JSON or TOML documents. The converter copies server-safe files byte-for-byte because many legacy Minecraft configs use `.json` names while allowing comments, raw newlines, or other non-standard syntax.

The converter only filters clearly client-local paths, such as `options.txt`, `shaderpacks/`, `resourcepacks/`, screenshots, saves, logs, and `overrides/mods/`. Mod files should come from the pack manifest and platform metadata so the report can keep hashes, download status, and decisions.

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
packages/*/test/     Package-level tests organized outside production src trees
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

- Broaden legacy Forge 1.12 runtime smoke tests with full downloaded Mod sets.
- Harden direct loader installation with more compatibility checks and fallback handling.
- Improve remote client-Mod rule diagnostics and contribution workflow.
- Add GitHub Release automation for Windows installers and portable builds.
- Improve packwiz remote metadata and hash handling.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [commit convention](./docs/commit-convention.md) before opening a pull request.

Use the GitHub issue templates for bug reports, conversion failures, feature requests, and client-only Mod rule updates. Useful reports include:

- modpack format and source;
- Minecraft version and loader;
- whether a CurseForge API key was configured;
- generated `conversion-report.json` with secrets removed.

For security issues, follow [SECURITY.md](./SECURITY.md) and do not open a public issue.

## License

MIT License. See [LICENSE](./LICENSE).
