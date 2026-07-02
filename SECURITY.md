# Security Policy

## Supported Versions

Only the latest published release receives security fixes.

| Version | Supported |
| --- | --- |
| latest release | Yes |
| older alpha builds | No |

## Reporting a Vulnerability

Use GitHub Security Advisories:

https://github.com/xutongxue233/minecraft-modpack-to-serverpack/security/advisories/new

Do not open a public issue for:

- leaked API keys or tokens;
- path traversal or archive extraction bypasses;
- command execution issues;
- unsafe startup script generation;
- dependency or supply-chain vulnerabilities.

## Sensitive Data

Do not include these in issues, pull requests, screenshots, or reports:

- CurseForge API keys;
- GitHub tokens;
- `.env` files;
- local `config.json`;
- private server addresses;
- unredacted `conversion-report.json` files.

## Expected Response

Maintainers will triage security reports as project capacity allows. Alpha releases may change behavior quickly while fixes are prepared.
