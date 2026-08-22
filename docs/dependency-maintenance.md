# Dependency maintenance

_Maintainer policy. Last reviewed against v1.8.2 on 2026-08-01._

This guide defines how ClaudeClaw maintainers handle dependency updates,
security advisories, npm overrides, and cross-platform validation.

## Supported toolchain

- Node.js 22 LTS and Node.js 24 LTS are the supported release lines.
- `package-lock.json` is authoritative and must stay committed with
  `package.json` changes.
- Use the npm version supplied by a supported Node release.
- Use `npm install` when updating the live fleet. Never run `npm ci` against the
  live runtime because it removes and recreates `node_modules`.
- Use a clean `npm ci --include=dev` in an isolated checkout when validating a
  lockfile change.

## Security update policy

1. Never run `npm audit fix` or `npm audit fix --force`. They can replace parent
   packages, introduce unreviewed major upgrades, and change build tooling.
2. Record both audit views before and after a dependency change:
   - `npm audit`
   - `npm audit --omit=dev`
3. Prefer a direct dependency update when its existing compatible range contains
   the fix.
4. Use an npm override when the vulnerable package is transitive and a compatible
   patched release exists.
5. Scope overrides as narrowly as practical. A parent-major upgrade belongs in
   its own PR with focused compatibility and runtime testing.
6. Treat overrides as temporary bridges. Review every override during each
   release and remove it once all parent packages resolve a patched version on
   their own.
7. Do not treat deprecation warnings as security findings. Track an upstream
   replacement only when ClaudeClaw can control the parent dependency.

Every override must record its package, advisory or advisory family, parent
chain, reason, and removal condition in the register below.

## Current override register

The resolved parents below reflect the v1.8.2 dependency work in PR
[#181](https://github.com/earlyaidopters/claudeclaw-os/pull/181). Run
`npm explain <package>` before removing an override because parent chains change
over time.

| Override | Advisory | Current parent chain | Reason | Removal condition |
| --- | --- | --- | --- | --- |
| `ws ^8.21.0` | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | OpenAI, Puppeteer through WhatsApp, and Google GenAI | Keeps all consumers on the patched 8.x line without replacing their parents. | All parents require at least 8.21.0 and `npm explain ws` shows no overridden edge. |
| `protobufjs ^7.6.5` | [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) and the protobufjs advisory family fixed through 7.6.5 | Google GenAI | Clears code-execution, injection, and denial-of-service findings while remaining on 7.x. | Google GenAI requires at least the audited patched protobufjs release. |
| `@protobufjs/utf8 ^1.1.2` | [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf) | protobufjs through Google GenAI | Prevents protobufjs from resolving the vulnerable UTF-8 helper. | protobufjs requires at least 1.1.2 and the override no longer affects resolution. |
| `axios ^1.18.1` | Axios advisory family affecting releases before 1.18.1, including [GHSA-42h9-826w-cgv3](https://github.com/advisories/GHSA-42h9-826w-cgv3) | Slack Web API | Keeps Slack's HTTP client on the patched 1.x line. | Slack Web API requires at least 1.18.1 and `npm explain axios` shows no overridden edge. |
| `basic-ftp ^5.3.1` | [GHSA-rp42-5vxx-qpwr](https://github.com/advisories/GHSA-rp42-5vxx-qpwr), [GHSA-rpmf-866q-6p89](https://github.com/advisories/GHSA-rpmf-866q-6p89) | Puppeteer browser tooling through `get-uri` | Prevents unbounded-memory denial of service while remaining on 5.x. | The Puppeteer chain requires at least 5.3.1. |
| `form-data ^4.0.6` | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) | Axios and Slack Web API | Clears multipart field-name and filename CRLF injection. | Axios and Slack Web API both require at least 4.0.6. |
| `@modelcontextprotocol/sdk ^1.30.0` | MCP 1.25.0 through 1.29.0 inherited the Hono adapter advisory [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | Claude Agent SDK and optional Google GenAI peer | Selects the compatible patched MCP peer without upgrading either provider SDK. | Both provider SDKs require at least MCP 1.30.0. |
| `dompurify $dompurify` | DOMPurify advisory family through 3.4.11, including [GHSA-c2j3-45gr-mqc4](https://github.com/advisories/GHSA-c2j3-45gr-mqc4) | Monaco Editor pins 3.2.7 | Deduplicates Monaco onto ClaudeClaw's patched direct DOMPurify range. | Monaco requires a patched DOMPurify release, then the nested copy stays clean without the override. |
| `fast-uri ^3.1.5` | [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | Ajv through MCP | Clears authority host confusion while remaining on 3.x. | Ajv requires at least 3.1.4 and the lockfile resolves a patched release unaided. |
| `minimatch@5 > brace-expansion ^2.1.4` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `readdir-glob` through WhatsApp archive support | Applies the fixed 2.x release without forcing a different brace-expansion major. | The Minimatch 5 chain requires at least brace-expansion 2.1.3. |
| `minimatch@9 > brace-expansion ^2.1.4` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | Glob through archive tooling and Vitest coverage | Applies the fixed 2.x release without forcing a different brace-expansion major. | The Minimatch 9 chain requires at least brace-expansion 2.1.3. |
| `minimatch@10 > brace-expansion ^5.0.9` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | Vitest coverage through `test-exclude` | Applies a fixed 5.x release while preserving the Node 20 and 22 support baseline. | The Minimatch 10 chain requires at least brace-expansion 5.0.8. |
| `postcss ^8.5.25` | [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | Vite 5 | Clears source-map path traversal without mixing in a Vite major upgrade. | The selected Vite release requires a patched PostCSS version. |

The first six overrides were introduced in PR
[#139](https://github.com/earlyaidopters/claudeclaw-os/pull/139). The remaining
entries were added or expanded in PR
[#181](https://github.com/earlyaidopters/claudeclaw-os/pull/181).

## Accepted residual findings

Accepted findings are snapshots, not permanent waivers. Re-evaluate them against
the current advisory database before every release.

As of 2026-08-01 after PR #181:

- The production audit contains one moderate `@hono/node-server` finding for
  encoded-backslash path traversal in `serveStatic`. ClaudeClaw imports `serve`
  from the adapter and does not import or call `serveStatic`. The Hono 2 migration
  remains a separate runtime-tested change.
- The full development audit also reports the Vitest 2 and Vite 5 toolchain.
  These packages do not ship in the production audit. Upgrade Vitest, coverage,
  Vite, and their coupled packages together in a separate PR.

Codex ACP uses the maintained `@agentclientprotocol/codex-acp` package. Keep it
off the retired `@zed-industries/codex-acp` line so new Codex models and model
metadata remain compatible.

## Validation matrix

Any PR that changes `package.json`, `package-lock.json`, or an override must pass:

1. A clean install on Windows using Node 22 or 24.
2. A clean install on macOS or Linux using Node 22 or 24.
3. `npm run build`.
4. `npm run typecheck`.
5. `npm test`.
6. `npm run codex:schema-check` when Codex or MCP dependencies can affect the
   provider surface.
7. `npm run gen:cli-docs:check` when CLI dependencies or generated references
   can be affected.
8. Both full and production audit results recorded in the PR.

On Windows PowerShell, prepare an isolated validation checkout with:

```powershell
$env:NODE_ENV = 'development'
npm ci --include=dev
```

On macOS or Linux:

```bash
NODE_ENV=development npm ci --include=dev
```

Do not run these clean-install commands against the live fleet directory.

## Release review

Before cutting a release that contains dependency changes:

1. Re-run `npm explain` for every overridden package.
2. Remove any override whose parents now select a patched release themselves.
3. Confirm `package-lock.json` contains the expected Windows, macOS, and Linux
   optional packages.
4. Re-run the validation matrix from a clean checkout.
5. Record accepted residual findings with package, advisory, exposure, and
   mitigation in the PR and release notes.
