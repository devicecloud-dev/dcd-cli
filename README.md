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

devicecloud.dev has an [MCP](https://modelcontextprotocol.io) server, so AI agents (Claude, Cursor, VS Code) can run cloud tests and drive cloud devices. You don't run it yourself. You add it to your MCP client's config, and the client starts it.

There are three ways to connect:

| | Install | Tools | Use it when |
| --- | --- | --- | --- |
| **`dcd mcp`** (recommended) | the CLI | device tools + `dcd_*` cloud-test tools | you want everything, including installing a local build or running local flow files |
| **Hosted** `https://api.devicecloud.dev/mcp` | nothing | device tools | the agent only drives devices, with apps and flows that are already uploaded or at a URL |
| **`dcd-mcp`** | the CLI | `dcd_*` cloud-test tools | you only run cloud tests (the older server; `dcd mcp` covers it) |

### `dcd mcp`

`dcd mcp` connects to the hosted server and passes its device tools through. It adds what only a local process can do: `install_app` takes `app_path` (a build on your machine, uploaded first) and `run` takes `path` (a flow file, or a directory uploaded as a bundle). It also serves the `dcd_*` tools below.

**Set it up with `dcd mcp install`.** Install the CLI (see the top of this page), sign in, then add the server to your AI tool:

```sh-session
$ dcd login
$ dcd mcp install cursor     # or claude-code, claude-desktop, vscode
```

Leave out the client name to pick from a list. Add `--read-only` for a server that only offers tools that change nothing, or `--print` to see what would be added without changing anything. For Claude Code and VS Code it runs `claude mcp add` and `code --add-mcp`. For Claude Desktop and Cursor it adds an entry to their JSON config file and keeps everything else in it. Restart the app afterwards.

**Setting it up by hand.** Start dcd by its **full path**. Desktop apps such as Claude Desktop and Cursor are usually opened from the Dock or Start menu, so they don't see the PATH your shell sets up, and a bare `dcd` gives "command not found". The installer prints the path at the end; it's `~/.dcd/bin/dcd` by default, written out in full because config files don't expand `~`.

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

Claude Code, run from a terminal, does see your PATH:

```sh-session
$ claude mcp add --scope user devicecloud -- dcd mcp
```

If you use the npm package instead of the standalone binary, the command is `npx` with `"args": ["-y", "@devicecloud.dev/dcd", "mcp"]`. That needs Node 22 or newer on the app's PATH, and it checks npm each time it starts.

It signs in the same way as the CLI: run `dcd login` once, or set `DEVICE_CLOUD_API_KEY` in `env`. Add `--read-only` to the args (or set `DCD_MCP_READONLY=1`) to serve only the tools that change nothing. If the hosted server can't be reached, it serves the `dcd_*` tools only and says why on stderr.

**Device tools:** `list_devices`, `start_device`, `get_device_status`, `install_app`, `launch_app`, `inspect_screen`, `take_screenshot`, `run`, `get_command_status`, `get_logs`, `request_human`, `get_human_status`, `stop_device`, and `cheat_sheet` (Maestro syntax for the agent).

### Hosted

Point an HTTP-capable client at the URL. It signs you in through the browser (OAuth), and you can disconnect it later under Settings → Connected apps.

```sh-session
$ claude mcp add --transport http devicecloud https://api.devicecloud.dev/mcp
```

### `dcd-mcp`

The older server, with the `dcd_*` tools only. Add it to your MCP client config:

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

`--package` matters: the package's default bin is `dcd`, so `npx @devicecloud.dev/dcd dcd-mcp` would run `dcd dcd-mcp` (an unknown command) instead of the server.

Auth is inherited from the CLI: set `DEVICE_CLOUD_API_KEY` as above, or run `dcd login` once and the server picks up the stored session. Point it at a non-prod environment with `DCD_API_URL`.

**`dcd_*` tools** (served by both `dcd mcp` and `dcd-mcp`)

| Tool | What it does |
| --- | --- |
| `dcd_list_devices` | Discover available devices, OS versions, and Maestro versions |
| `dcd_list_runs` | List recent test runs (filter by name/date, paginated) |
| `dcd_get_status` | Get the status + per-test results of a run |
| `dcd_download_artifacts` | Download a run's artifacts/report to disk |
| `dcd_run_cloud_test` | Submit a flow to run on the cloud (**billable**) |

**Read-only mode.** `dcd_run_cloud_test` consumes test minutes, so it is annotated as non-read-only/destructive (clients can prompt before calling it). To hide it entirely — recommended for autonomous or untrusted agents — pass `--read-only` at the end of `args` (`["-y", "--package=@devicecloud.dev/dcd", "dcd-mcp", "--read-only"]`), or set `DCD_MCP_READONLY=1` in `env`.

By default `dcd_run_cloud_test` is async: it returns an `uploadId` immediately, which you poll with `dcd_get_status`. Pass `wait: true` (bounded by `waitTimeoutSeconds`) to block until completion, or `dryRun: true` to preview the flows without submitting.


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


