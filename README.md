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


## MCP server

The same npm package ships an [MCP](https://modelcontextprotocol.io) server (`dcd-mcp` bin) so AI agents — Claude, Cursor, VS Code — can drive devicecloud.dev directly.

Add it to your MCP client config:

```jsonc
{
  "mcpServers": {
    "devicecloud": {
      "command": "npx",
      "args": ["-y", "@devicecloud.dev/dcd", "dcd-mcp"],
      "env": { "DEVICE_CLOUD_API_KEY": "<your-api-key>" }
    }
  }
}
```

Auth is inherited from the CLI: set `DEVICE_CLOUD_API_KEY` as above, or run `dcd login` once and the server picks up the stored session. Point it at a non-prod environment with `DCD_API_URL`.

**Tools**

| Tool | What it does |
| --- | --- |
| `dcd_list_devices` | Discover available devices, OS versions, and Maestro versions |
| `dcd_list_runs` | List recent test runs (filter by name/date, paginated) |
| `dcd_get_status` | Get the status + per-test results of a run |
| `dcd_download_artifacts` | Download a run's artifacts/report to disk |
| `dcd_run_cloud_test` | Submit a flow to run on the cloud (**billable**) |

**Read-only mode.** `dcd_run_cloud_test` consumes test minutes, so it is annotated as non-read-only/destructive (clients can prompt before calling it). To hide it entirely — recommended for autonomous or untrusted agents — pass `--read-only` in `args`, or set `DCD_MCP_READONLY=1` in `env`.

By default `dcd_run_cloud_test` is async: it returns an `uploadId` immediately, which you poll with `dcd_get_status`. Pass `wait: true` (bounded by `waitTimeoutSeconds`) to block until completion, or `dryRun: true` to preview the flows without submitting.


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


## Contributing

Contributions are welcome! Read **[CONTRIBUTING.md](CONTRIBUTING.md)** for local
setup, our commit/PR conventions (Conventional Commit PR titles, squash-merge),
and how releases work. All contributors sign our
[Contributor License Agreement](CLA.md) — the bot prompts you on your first PR —
and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Please **don't** open a public issue — see
[SECURITY.md](SECURITY.md).


## License

[MIT](LICENSE) © Moropo Ltd t/a DeviceCloud


