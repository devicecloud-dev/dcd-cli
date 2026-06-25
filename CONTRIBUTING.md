# Contributing to the devicecloud.dev CLI

Thanks for your interest in improving `@devicecloud.dev/dcd`! This guide covers
everything you need to land a change: local setup, our commit/PR conventions, and
how releases work.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement (CLA)

Before your first contribution can be merged, you must sign our Contributor
License Agreement. When you open your first pull request, the **CLA Assistant**
bot will comment with a link and instructions — signing takes under a minute and
is a one-time step. PRs cannot be merged until the CLA check is green.

- Individuals: sign the [Individual CLA](CLA.md#individual-contributor-license-agreement).
- Contributing on behalf of an employer? Have an authorised signatory complete the
  [Corporate CLA](CLA.md#corporate-contributor-license-agreement).

## Getting started

You need **Node.js 22+** and **[pnpm](https://pnpm.io)** (`packageManager` pins
the exact version; [Corepack](https://nodejs.org/api/corepack.html) will pick it
up automatically).

```sh-session
$ git clone https://github.com/devicecloud-dev/dcd-cli.git
$ cd dcd-cli
$ pnpm install        # installs deps, builds, and sets up git hooks
$ pnpm dcd <args>     # run the CLI from source
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint over `src/` and `test/` |
| `pnpm typecheck` | Strict `tsc --noEmit` over `src/` and `test/` |
| `pnpm build` | Compile to `dist/` |
| `pnpm test` | Build + boot the mock API + run integration/unit tests |

**Before pushing, make sure `pnpm lint`, `pnpm typecheck`, and `pnpm build`
pass.** These run for every PR (including from forks) and are required to merge.

### About the test suite

`pnpm test` boots a **mock API that lives in a private repository**, so the full
integration suite only runs on branches inside this repo. **On pull requests from
forks the integration tests are automatically skipped** — you'll see a CI notice
saying so. That's expected: lint, typecheck, and build still run and gate your
PR, and a maintainer runs the full suite before merge. You don't need backend
access to contribute.

### Secret scanning

A [gitleaks](https://github.com/gitleaks/gitleaks) scan runs as a pre-commit hook
and in CI (sharing the allowlist in `.gitleaks.toml`). Installing the binary
locally (`brew install gitleaks`) catches secrets before you commit; without it
the hook skips with a warning and CI remains the backstop. **Never commit real
credentials.**

## Branching & pull requests

1. Branch off **`dev`** (the default branch). Name it descriptively, e.g.
   `fix/upload-retry` or `feat/json-output`.
2. Open your pull request **against `dev`**. (The `production` branch is the
   stable release track and is maintainer-only — don't target it.)
3. Keep PRs focused. Smaller, single-purpose PRs are reviewed and merged faster.
4. Fill in the PR template, including the checklist.
5. PRs are merged via **squash merge**, so your PR ends up as a single commit on
   `dev` whose message is your **PR title** — which is why the title must follow
   the Conventional Commits format below.

## Commit & PR title conventions

We use [Conventional Commits](https://www.conventionalcommits.org). Because we
squash-merge, **only your PR title needs to follow the format** — individual
commit messages on your branch are squashed away, so commit however you like
while developing. A CI check (`PR Title`) validates the title and must pass to
merge.

Format:

```
<type>(<optional scope>): <description>
```

Allowed types and how they affect the next release:

| Type | Use for | Changelog | Version bump |
| --- | --- | --- | --- |
| `feat` | A new feature | **Features** | minor |
| `fix` | A bug fix | **Bug Fixes** | patch |
| `perf` | A performance improvement | **Performance** | patch |
| `deps` | Dependency updates | **Dependencies** | patch |
| `revert` | Reverting a previous change | **Reverts** | patch |
| `refactor` | Code change that neither fixes a bug nor adds a feature | **Code Refactoring** | patch |
| `docs` | Documentation only | hidden | none |
| `chore` | Tooling/maintenance | hidden | none |
| `test` | Adding or fixing tests | hidden | none |
| `ci` | CI configuration | hidden | none |
| `build` | Build system | hidden | none |
| `style` | Formatting, whitespace | hidden | none |

**Breaking changes:** append `!` after the type (e.g. `feat!: drop Node 20`) or
add a `BREAKING CHANGE:` footer in the PR description. While the CLI is pre-1.0,
`feat` bumps the minor version and breaking changes bump the minor too.

Examples:

```
feat(cloud): add --json output for run results
fix: retry binary upload on transient 5xx
docs: clarify dcd login flow in README
deps: bump @modelcontextprotocol/sdk to 1.x
```

## Code style

- TypeScript, strict mode. Run `pnpm lint` and `pnpm typecheck` before pushing.
- Formatting is handled by Prettier (config in `.prettierrc`); an `.editorconfig`
  keeps editors consistent.
- All human-facing CLI output goes through the rendering layer described in
  [`STYLE_GUIDE.md`](STYLE_GUIDE.md) — please read it before adding output. Don't
  hand-roll layouts or call `console.log` directly.

## How releases work

You don't need to do anything for releases — **do not bump the version in
`package.json` or edit `CHANGELOG.md`** in your PR.

Releases are automated by [release-please](https://github.com/googleapis/release-please):

- Merges to `dev` accumulate into a **beta** release (published to npm under the
  `beta` tag).
- Maintainers promote `dev` → `production` for **stable** releases (npm `latest`).

release-please reads the Conventional Commit titles of merged PRs to compute the
next version and generate the changelog — which is exactly why the PR title
convention matters.

## Questions

- General questions and help: [Discord](https://discord.gg/gm3mJwcNw8).
- Security vulnerabilities: **do not** open an issue — see [SECURITY.md](SECURITY.md).

Thanks for contributing! 🎉
