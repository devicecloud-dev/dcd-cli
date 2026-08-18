# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `pnpm dcd <args>` — run the CLI from source via `tsx`.
- `pnpm build` — clean, compile TypeScript to `dist/`, and `chmod +x dist/index.js dist/mcp/index.js` so both published binaries are directly executable.
- `pnpm build:binaries` — `scripts/build-binaries.mjs` produces the bun-compiled, self-contained `dcd-<platform>-<arch>` binaries published to GitHub Releases (the install `dcd upgrade` self-updates). The platform/arch keys must stay in sync with `ASSET_BY_PLATFORM` in `src/commands/upgrade.ts`.
- `pnpm lint` — ESLint over `src/` and `test/`.
- `pnpm typecheck` — `tsc --noEmit -p tsconfig.test.json` over `src/` and `test/` (strict mode; `pnpm build` only compiles `src/`). Requires Node `>=22`.
- `pnpm test` — runs `scripts/test-runner.mjs`: builds the CLI, boots the mock API if one is available, then runs mocha. TypeScript is loaded by **tsx** (`.mocharc.json`'s `node-option: ["import=tsx"]`), *not* ts-node — Mocha 11 imports specs as ESM, which bypasses the `require: ts-node/register` hook. The runner isolates `DCD_CONFIG_DIR` to a temp dir so tests never touch your real `dcd login` session.
- `pnpm test:unit` — the same runner with `--unit`: unit specs only, no mock API. **This is what CI runs.**
- Tests split into `test/unit/*` (pure, no backend) and `test/integration/*` (drive the built CLI against a Prism mock of the dcd API on port 3001).
- **There is no default mock API any more.** It used to live in the sibling private `dcd/` repo; dcd#1036 deleted it, and this repo — which is public — deliberately no longer reaches into that one (no deploy key, no `swagger.json` pull). So `pnpm test` with no `MOCK_API_DIR` set **silently degrades to the unit suite** and prints a notice. To run `test/integration/*`, stand up a Prism mock over the API's `swagger.json` and point `MOCK_API_DIR=/path/to/mock-api` at it (it needs a `start:auth` npm script serving port 3001).
- Consequence worth knowing: CI no longer catches **CLI↔swagger contract drift**, which used to surface as a Prism 422 from the integration specs. Nothing replaces that check yet.
- Run a single test: `pnpm mocha test/integration/cloud.integration.test.ts --timeout 60000` (picks up `.mocharc.json` which wires tsx; integration specs require the mock API already running on port 3001).

## Entry point

The CLI is citty-native: `src/index.ts` has a `#!/usr/bin/env node` shebang (preserved by tsc), and `package.json` points `bin.dcd` directly at `dist/index.js`. There is no `bin/` wrapper directory — don't add one.

The package ships a **second bin, `dcd-mcp`** (`bin.dcd-mcp` → `dist/mcp/index.js`, also shebanged + chmod'd by `pnpm build`). It's the MCP server — see the MCP section under Architecture.

## Architecture

Top-level `defineCommand` in `src/index.ts` wires eleven subcommands (`cloud`, `upload`, `list`, `status`, `artifacts`, `live`, `upgrade`, plus the auth-related `login`, `logout`, `whoami`, `switch-org`). `cloud` is the primary command and replicates `maestro cloud`; `upgrade` self-updates the standalone bun binary (no-op for npm installs, which it redirects to `npm install -g`). Note `src/index.ts` deliberately **reimplements** citty's `runMain` rather than calling it — see the Telemetry section for why.

**Flag composition.** Flag definitions are split by domain in `src/config/flags/*.flags.ts` (api, binary, device, environment, execution, github, output) and re-exported as a single `flags` object from `src/constants.ts`. Commands that need the full cloud surface spread `...flags` into their citty `args`; subset commands import individual flag groups.

**Output rendering.** All human-facing output goes through `src/utils/ui.ts` (the canonical layer: `section`/`branch`/`fields`/`status`/`success`/`info`/`warn`) on top of `src/utils/styling.ts` (`colors`, `symbols`, `statusPalette`). The visual language is a Claude Code-style tree (`⏺` section headings, `⎿` branch groups). Commands must not hand-roll layouts from `colors`/`symbols` or call `console.log` (except the single `JSON.stringify` line under `--json`). Full rules and a cookbook live in `STYLE_GUIDE.md`.

**Layered call stack.**
- `src/commands/*` — thin citty command definitions; orchestrate services, no I/O logic.
- `src/services/*.service.ts` — domain workflows (execution planning, device validation, test submission, results polling, report download, version check, metadata extraction). Services call gateways and each other.
- `src/gateways/api-gateway.ts`, `src/gateways/supabase-gateway.ts` — HTTP/Supabase boundaries. `ApiGateway` also owns network-error enhancement and standardized response handling.
- `src/methods.ts` — shared binary/archive helpers (zip verification, SHA-based upload dedup, JSON file writes).
- `src/utils/*` — `cli` (logger, CliError, version, enum/int parsing), `styling` (colors, section headers), `progress` (ux/spinners), `compatibility` (device/OS matrix), `expo` (Expo URL download + tarball extraction), `connectivity`.

**Types.** `src/types/generated/schema.types.ts` is **auto-generated by openapi-typescript** — do not hand-edit. Domain types live in `src/types/domain/`.

**Cloud command workflow** (the canonical shape other commands mirror): upload binary with SHA dedup → extract metadata / validate devices → build execution plan → submit tests → poll results every 10s → download artifacts (reports/videos/logs). `RunFailedError` from the polling service is the signal for a failed test run (distinct from infra errors).

**Auth.** Every command calls `resolveAuth({ apiKeyFlag })` (`src/utils/auth.ts`) once and threads the returned `AuthContext` into gateways/services. `ApiGateway` and `fetchCompatibilityData` spread `auth.headers` into fetch headers — they no longer accept a raw api key. Precedence: `--api-key` flag > `DEVICE_CLOUD_API_KEY` env > stored session from `dcd login`. `resolveAuth` refreshes expiring Supabase sessions via `CliAuthGateway.refresh` and rewrites the config atomically.

**Config store.** `dcd login` writes `$XDG_CONFIG_HOME/dcd/config.json` (fallback `~/.dcd/config.json`, 0600). Shape: `{ version, env, api_url, supabase_url, session: { access_token, refresh_token, expires_at, user_email, user_id }, current_org_id, current_org_name }`. `DCD_CONFIG_DIR` overrides the directory (used by tests). The login command itself (`src/commands/login.ts`) uses PKCE (S256) with a server rendezvous — no loopback server: it mints `state`, `code_verifier`, and `code_challenge`, opens `<frontend>/cli-login?state=...&code_challenge=...`, then polls the dcd API's `POST /cli-login/claim` with `{state, code_verifier}` while the frontend POSTs proof of identity (the browser's access token) to `POST /cli-login/handoff`; the API verifies the token, **mints a dedicated Supabase session for the CLI** (its own refresh-token family — sharing the browser's tokens caused "Invalid Refresh Token: Already Used" whenever either client rotated them), stores it keyed by state, then on claim verifies `sha256(verifier) === challenge` and returns it. After claiming, the CLI fetches `/me/orgs` and prompts for an org (the same picker `dcd switch-org` uses). The frontend lives in `../dcd/frontend/app/features/cli-login/CliLoginScreen.tsx`.

**Cross-repo auth surface.** The dcd API's `ApiKeyGuard` accepts either `x-app-api-key` (existing) or `Authorization: Bearer <jwt>` + `x-dcd-org: <id>`. For Bearer it verifies the JWT, checks `user_org_profile` membership, and injects the org's api_key back into the request headers so existing `@Headers(APP_API_KEY_HEADER)` controller code keeps working unchanged. `dcd switch-org` calls `GET /me/orgs`, a JWT-only endpoint at `../dcd/api/src/apps/me/me.controller.ts`.

**Telemetry.** `src/services/telemetry.service.ts` ships lifecycle (`command started` / `command completed` / `command failed`) and error events to the dcd API's `/cli/logs` proxy → Axiom `cli-dev` / `cli-prod`. Wired in at three points: `src/index.ts` replicates citty's `runMain` (which would otherwise swallow errors and exit 1) to record start/success/failure and honor `CliError.exitCode`; `src/utils/auth.ts` calls `telemetry.configure({ auth })` from `resolveAuth` so the token never has to be re-derived; `src/utils/cli.ts` `logger.error` calls `telemetry.flushSync()` (which shells out to `curl` because `process.exit` bypasses `beforeExit`) before exiting. Unauthenticated invocations (`--help`, `--version`, `dcd login` pre-success) buffer in memory and drop on exit — by design, since there's no identity to attach. Opt out per-invocation with `DCD_TELEMETRY_DISABLED=1`.

**MCP server.** `src/mcp/` is a third front-end onto the same service layer (a sibling to `src/commands/`), shipped as the `dcd-mcp` bin over stdio transport (`@modelcontextprotocol/sdk`, `zod` schemas). `index.ts` boots the server; `server.ts` registers tools; `context.ts` resolves auth + API URL **lazily and once** (so `tools/list` works unauthenticated and auth errors surface as tool errors, not a boot crash) via the same `resolveAuth`/`resolveApiUrl` as the CLI — `DEVICE_CLOUD_API_KEY` env or stored `dcd login` session, with `DCD_API_URL` to override. **Critical invariant: stdout is the JSON-RPC channel** — tools must never call the `src/commands/*` layer or `utils/cli` `logger` (both write to stdout / can `process.exit`); they call services/gateways directly with `logStderr` and return data via `helpers.ts` `jsonResult`/`errorResult`. The `runTool` wrapper records `mcp tool …` telemetry and converts thrown errors to `isError` results. Tools: `dcd_list_devices`, `dcd_list_runs`, `dcd_get_status`, `dcd_download_artifacts` (read-only), and `dcd_run_cloud_test` (billable — gated out by `--read-only` / `DCD_MCP_READONLY=1`, annotated destructive, async-by-default). `dcd_run_cloud_test` reuses `computeCommonRoot`/`buildTestMetadataMap` from `src/services/flow-paths.ts` (extracted from `cloud.ts` so both build identical server-side paths). Registry manifest: `server.json` at repo root.

## Contributing

Full guide in `CONTRIBUTING.md`; the operationally important parts (the ones that gate a merge or affect a release):

- **Branch off `dev`** (the default branch) and open PRs **against `dev`**. `production` is the maintainer-only stable track — never target it directly.
- PRs are **squash-merged**, so the **PR title becomes the commit** and must be a [Conventional Commit](https://www.conventionalcommits.org). The title — not the branch commits — is what release-please reads to compute the next version, so it matters even though individual commits are squashed away. A `PR Title` CI check enforces it.
- Type → bump: `feat` **minor**; `fix`/`perf`/`deps`/`revert`/`refactor` **patch**; `docs`/`chore`/`test`/`ci`/`build`/`style` are hidden and bump nothing. Allowed scopes are free-form.
- ⚠️ **A `!` (or `BREAKING CHANGE:` footer) bumps the MAJOR — do not use it casually.** The configs set `bump-minor-pre-major: true`, but that only applies **below 1.0.0**; we are on 5.x, so it is inert and a breaking marker means exactly what semver says. A `refactor(cloud)!:` PR title once produced a `6.0.0-beta.1` release PR for what was only a flag rename in an unconsumed beta. Because PRs are squash-merged, **the PR title IS the commit** — the `!` lands even if no branch commit carried it.
- **Never hand-edit `package.json` version, `CHANGELOG.md`, or the `.release-please-manifest*.json` files** — release-please owns all of them. `src/types/generated/schema.types.ts` is likewise generated (openapi-typescript).
- A first-time contributor must sign the CLA (the CLA Assistant bot comments on the first PR); the CLA check must be green to merge.
- **CI (`.github/workflows/cli-ci.yml`) runs on every PR** including forks: gitleaks secret scan, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm audit --audit-level moderate`. The **integration tests need the private `devicecloud-dev/dcd` mock-api** (cloned via the `DCD_SSH_DEPLOY_KEY` secret), and GitHub withholds secrets from fork and Dependabot PRs — so `pnpm test` is **skipped there** and a maintainer runs the full suite before merge. gitleaks also runs as a pre-commit hook (allowlist in `.gitleaks.toml`); without the binary installed the hook self-skips and CI is the backstop.

## Releases

Fully automated by [release-please](https://github.com/googleapis/release-please) — no manual version bumping. `.github/workflows/release-please.yml` drives **two parallel tracks off two separate config+manifest pairs**:

| Push to | Track | Config / manifest | Version | npm tag |
| --- | --- | --- | --- | --- |
| `dev` | **beta** (prerelease) | `release-please-config-beta.json` / `.release-please-manifest-beta.json` | `X.Y.Z-beta.N` | `beta` |
| `production` | **stable** | `release-please-config.json` / `.release-please-manifest.json` | `X.Y.Z` | `latest` |

The two manifests track their versions **independently** (e.g. beta `5.0.0-beta.3` while stable is `5.0.0`). On each qualifying push release-please opens/updates a **Release PR** on that branch; merging the Release PR creates the git tag + GitHub Release, and the same workflow run **chains** (as `needs:` jobs, because a `GITHUB_TOKEN`-created release won't fire `release: published`) into:
1. `npm-publish.yml` — publishes to npm. Guards: a prod publish may only run from `production` and its version must **not** carry `-beta`; a beta version **must** carry `-beta`.
2. `release-binaries.yml` — bun-compiles the standalone binaries (`node scripts/build-binaries.mjs`) and uploads them to the GitHub Release. `get.devicecloud.dev` serves them by reading the GitHub Releases API at runtime, so there's no separate manifest to deploy.

**Promoting beta → stable** is a maintainer merging `dev` into `production` via a PR (also gated by `cli-ci.yml`) — that push to `production` is what triggers the stable Release PR. The current `release/promote-v5` branch is exactly such a promotion. Releases prefer an automation GitHub App token (`BOT_APP_ID`) so the Release PR triggers the CI / PR-title / CLA checks that branch protection requires, falling back to `GITHUB_TOKEN` until the App secrets are configured.
