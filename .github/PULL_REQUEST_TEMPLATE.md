<!--
  PR TITLE: must follow Conventional Commits — it becomes the squash-merge
  commit and feeds release-please. e.g.  feat(cloud): add --json output
  Allowed types: feat, fix, perf, deps, revert, refactor, docs, chore, test, ci, build, style
  See CONTRIBUTING.md for details.
-->

## What & why

<!-- What does this change do, and why? Link any related issue: Closes #123 -->

## Type of change

<!-- Match this to your PR title's type. -->

- [ ] `fix` — bug fix
- [ ] `feat` — new feature
- [ ] `perf` — performance improvement
- [ ] `refactor` — code change that's neither a fix nor a feature
- [ ] `docs` — documentation only
- [ ] `chore` / `ci` / `build` / `test` — tooling, no user-facing change
- [ ] Breaking change (title has `!` or PR notes a `BREAKING CHANGE:`)

## Checklist

- [ ] PR title follows the Conventional Commits format (see comment above)
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes
- [ ] I have **not** bumped the version or edited `CHANGELOG.md` (release-please handles this)
- [ ] I have signed the CLA (the bot will prompt on first contribution)
- [ ] Docs / `README.md` / `STYLE_GUIDE.md` updated if behaviour or output changed

## How to test

<!-- Steps a reviewer can follow to verify the change. -->
