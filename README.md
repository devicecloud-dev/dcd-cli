# devicecloud.dev CLI

---

One line swap out for Maestro Cloud

Install (no Node required):

```sh-session
$ curl -fsSL https://get.devicecloud.dev/install.sh | sh
```

On Windows:

```powershell
irm https://get.devicecloud.dev/install.ps1 | iex
```

Or via npm if you already have Node 22+:

```sh-session
$ npm install -g @devicecloud.dev/dcd
```

Upgrade later with `dcd upgrade` (binary install) or `npm install -g @devicecloud.dev/dcd@latest` (npm install).

Use:

```sh-session
# maestro cloud --apiKey <apiKey> <appFile> .myFlows/
$ dcd cloud --apiKey <apiKey> <appFile> .myFlows/
```

See full documentation: [Docs](https://docs.devicecloud.dev)

---

## Development

Requires Node 22+ and [pnpm](https://pnpm.io). `pnpm install` builds the CLI and installs the git hooks automatically.

```sh-session
$ pnpm install        # install deps, build, set up git hooks
$ pnpm dcd <args>     # run the CLI from source
$ pnpm lint           # ESLint
$ pnpm typecheck      # strict tsc, no emit
$ pnpm test           # build + boot mock API + integration/unit tests
```

### Secret scanning

A [gitleaks](https://github.com/gitleaks/gitleaks) scan runs in two places, both sharing the allowlist in `.gitleaks.toml`:

- **pre-commit hook** (via husky) — scans your staged changes and blocks the commit if a secret is found. Install the binary so it can run; without it the hook skips with a warning:
  ```sh-session
  $ brew install gitleaks      # or see github.com/gitleaks/gitleaks#installing
  ```
- **CI** — the `secret-scan` job scans the full history on every push and pull request, and is the enforced backstop regardless of local setup.

---

*Engineering notes:* internal architecture, telemetry, and release-process docs for DeviceCloud staff live at [bo.devicecloud.dev/docs/services/cli/](https://bo.devicecloud.dev/docs/services/cli/) (Supabase OTP sign-in required).
