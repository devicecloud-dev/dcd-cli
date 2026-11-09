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

`dcd mcp` is an [MCP](https://modelcontextprotocol.io) server, so AI agents (Claude, Codex, Cursor, VS Code) can run cloud tests and read their results. You don't run it yourself. You add it to your MCP client's config, and the client starts it. It works the same on your machine and headless, such as in CI.

### Set it up with `dcd mcp install`

Install the CLI (see the top of this page), sign in, then add the server to your AI tool:

```sh-session
$ dcd login
$ dcd mcp install cursor     # or claude-code, claude-desktop, codex, vscode
```

Leave out the client name to pick from a list. Add `--read-only` for a server that only offers tools that change nothing, or `--print` to see what would be added without changing anything. For Claude Code, Codex and VS Code it runs `claude mcp add`, `codex mcp add` and `code --add-mcp`. For Claude Desktop and Cursor it adds an entry to their JSON config file and keeps everything else in it. Restart the app afterwards.

### Headless, with an API key

For an agent that runs without you, such as in CI or a script, sign in with an API key instead of `dcd login`. Create one in the console under Settings → API Keys, and give it to the server as `DEVICE_CLOUD_API_KEY` in its environment. For example, for Claude Code in CI:

```sh-session
$ claude mcp add --scope user devicecloud -e DEVICE_CLOUD_API_KEY="$DEVICE_CLOUD_API_KEY" -- dcd mcp
```

In a JSON config, put it in the server's `env`: `"env": { "DEVICE_CLOUD_API_KEY": "<your-api-key>" }`. Store the key as a secret in your CI provider, never in the repository.

### Setting it up by hand

Start dcd by its **full path**. Desktop apps such as Claude Desktop and Cursor are usually opened from the Dock or Start menu, so they don't see the PATH your shell sets up, and a bare `dcd` gives "command not found". The installer prints the path at the end; it's `~/.dcd/bin/dcd` by default, written out in full because config files don't expand `~`.

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```jsonc
{
  "mcpServers": {
    "devicecloud": {
      "command": "/Users/you/.dcd/bin/dcd",
      "args": ["mcp"]
    }
  }
}
```

VS Code (`.vscode/mcp.json`, or the user `mcp.json`) uses `servers` and a `type`:

```jsonc
{
  "servers": {
    "devicecloud": {
      "type": "stdio",
      "command": "/Users/you/.dcd/bin/dcd",
      "args": ["mcp"]
    }
  }
}
```

Codex (`~/.codex/config.toml`, shared by the Codex CLI, IDE extension and desktop app):

```toml
[mcp_servers.devicecloud]
command = "/Users/you/.dcd/bin/dcd"
args = ["mcp"]
```

Claude Code and the Codex CLI, run from a terminal, do see your PATH:

```sh-session
$ claude mcp add --scope user devicecloud -- dcd mcp
$ codex mcp add devicecloud -- dcd mcp
```

If you use the npm package instead of the standalone binary, the command is `npx` with `"args": ["-y", "@devicecloud.dev/dcd", "mcp"]`. That needs Node 22 or newer on the app's PATH, and it checks npm each time it starts.

It signs in the same way as the CLI: with your `dcd login` session, which it renews as it runs, or with `DEVICE_CLOUD_API_KEY`. Point it at a non-prod environment with `DCD_API_URL`.

### Tools

| Tool | What it does |
| --- | --- |
| `dcd_list_devices` | Discover available devices, OS versions, and Maestro versions |
| `dcd_list_runs` | List recent test runs (filter by name/date, paginated) |
| `dcd_get_status` | Get the status + per-test results of a run |
| `dcd_download_artifacts` | Download a run's artifacts/report to disk |
| `dcd_run_cloud_test` | Submit a flow to run on the cloud (**billable**) |

By default `dcd_run_cloud_test` is async: it returns an `uploadId` immediately, which you poll with `dcd_get_status`. Pass `wait: true` (bounded by `waitTimeoutSeconds`) to block until completion, or `dryRun: true` to preview the flows without submitting.

**Read-only mode.** `dcd_run_cloud_test` consumes test minutes, so it is annotated as non-read-only/destructive (clients can prompt before calling it). To hide it entirely, which is recommended for autonomous or untrusted agents, add `--read-only` after `mcp` in the args (or pass it to `dcd mcp install`), or set `DCD_MCP_READONLY=1` in `env`.

### `dcd-mcp`

The npm package also ships `dcd-mcp`, an older server with the same `dcd_*` tools. `dcd mcp` covers it, so you only need it for a setup that already uses it:

```jsonc
{
  "mcpServers": {
    "devicecloud": {
      "command": "npx",
      "args": ["-y", "--package=@devicecloud.dev/dcd", "dcd-mcp"],
      "env": { "DEVICE_CLOUD_API_KEY": "<your-api-key>" }
    }
  }
}
```

`--package` matters: the package's default bin is `dcd`, so `npx @devicecloud.dev/dcd dcd-mcp` would run `dcd dcd-mcp` (an unknown command) instead of the server. It signs in like `dcd mcp`, and takes `--read-only` and `DCD_MCP_READONLY=1` the same way.


## Development

Requires Node 22+ and [pnpm](https://pnpm.io). `pnpm install` builds the CLI and installs the git hooks automatically.

```sh-session
$ pnpm install        # install deps, build, set up git hooks
$ pnpm dcd <args>     # run the CLI from source
$ pnpm lint           # ESLint
$ pnpm typecheck      # strict tsc, no emit
$ pnpm test:unit      # unit tests, no backend needed — what CI runs
$ pnpm test           # the above, plus integration tests if MOCK_API_DIR is set
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


