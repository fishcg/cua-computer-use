# cua-computer-use

Give [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) real computer use by bridging the
[Cua Driver](https://github.com/trycua/cua) MCP server into the harness.

Cua Driver ships an MCP server (`cua-driver mcp`) that exposes an accessibility-first GUI automation surface:
window discovery, accessibility snapshots, snapshot-bound element tokens, pixel fallback, menus, browser tabs,
recording, and playback. This plugin resolves the `cua-driver` executable, wires that server into the in-box MCP
client, registers the ~60 advertised tools as `mcp__cua-driver__*`, and ships a harness skill that teaches the
model the workflow.

No automation logic is reimplemented and there are no runtime dependencies.

## Why a plugin instead of a hand-written MCP row

You *can* add Cua Driver to a profile by hand. This plugin exists because doing so trips over two things:

1. **The harness host does not have your shell's `PATH`.** On macOS the desktop app is started by `launchd`,
   whose `PATH` omits `~/.local/bin` — exactly where the Cua Driver installer puts the binary. A bare
   `cua-driver` in an MCP row fails to spawn with an unhelpful error. This plugin resolves an absolute path,
   searches the per-platform install locations, and fails loudly with the list of directories it tried.
2. **Tools without guidance are used badly.** Registering 60 tools is not enough; the model needs to know that
   snapshots invalidate tokens, that `since: "latest"` is the cheap re-read, and that browser pages belong to the
   `browser_*` tools rather than the desktop pointer. The bundled skill and the short standing prompt note cover that.

## Requirements

- DeepSeek Harness `0.2.0-rc.2` or later.
- The `cua-driver` executable, on `PATH` or in a standard install location:

  ```sh
  # macOS / Linux
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

  ```powershell
  # Windows
  irm https://cua.ai/driver/install.ps1 | iex
  ```

- macOS: grant **Accessibility** and **Screen Recording** to the CuaDriver daemon, or to the terminal that
  launched it. `cua-driver doctor` and the `mcp__cua-driver__health_report` tool report what is missing.

## Install

```sh
# from a git checkout
dsh plugin --profile web add github:fishcg/cua-computer-use
```

Restart the harness afterwards. The bundle layer is read from `package.json`'s `dsh.bundle.patch`.

The package ships plain ESM with no build step and no runtime dependencies, so a git install needs no
`allowBuilds` entry in your profile's `pnpm-workspace.yaml` — there is nothing to compile.

## What it registers

| Kind | Name | Notes |
| --- | --- | --- |
| Tools | `mcp__cua-driver__*` | 60 tools, bridged by `@deepseek-ai/dsh-mcp-client` |
| Skill | `cua-computer-use` | Workflow, reliability rules, troubleshooting |
| Service | `cuaComputerUse` | Resolved launch parameters, for other rows to consume |
| Prompt | `tool:cua-computer-use` | Three-sentence standing note; disable with `prompt: false` |

The tools cover window discovery (`list_windows`, `launch_app`), state reading (`get_window_state`,
`get_accessibility_tree`), input (`click`, `type_text`, `set_value`, `press_key`, `hotkey`, `scroll`, `drag`),
verification (`verify_state`), batching (`run_steps`, `run_script`), native menus (`invoke_menu`), browser tabs
(`get_browser_state`, `browser_click`, …), geometry, recording, and diagnostics.

## Configuration

Set these on the `cua-computer-use` row in your profile's `cordis.patch.yml`:

```yaml
- id: cua-computer-use
  config:
    command: /opt/cua/cua-driver
    toolCallTimeoutMs: 180000
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | `''` | Explicit executable path or bare name. Empty auto-discovers. An explicit value never silently falls back to a different binary. |
| `args` | `string[]` | `['mcp']` | Arguments for the executable. |
| `env` | `object` | `{}` | Extra environment variables for the MCP child process. |
| `cwd` | `string` | `''` | Working directory for the child. Empty inherits the host's. |
| `toolCallTimeoutMs` | `number` | `120000` | Per-call timeout. Generous by default because GUI waits and cold daemon starts are slow; the MCP client's own default is 60 s. |
| `skill` | `boolean` | `true` | Register the bundled skill. |
| `prompt` | `boolean` | `true` | Add the standing system-prompt note. |

The `CUA_DRIVER_BIN` environment variable pins an absolute path and is honoured after `command` but before
directory discovery.

## How it works

The bundle patch inserts two rows, in order:

```yaml
- insert:
    - id: cua-computer-use
      name: 'cua-computer-use'

    - id: mcp-cua-driver
      name: '@deepseek-ai/dsh-mcp-client'
      inject: [cuaComputerUse]
      config:
        serverName: cua-driver
        transport: stdio
        command: !!js ctx.cuaComputerUse.command
        args: !!js ctx.cuaComputerUse.args
        env: !!js ctx.cuaComputerUse.env
        cwd: !!js ctx.cuaComputerUse.cwd
        toolCallTimeoutMs: !!js ctx.cuaComputerUse.toolCallTimeoutMs
        failOnStartupError: false
```

The first row resolves the binary and publishes it as a service. The second injects that service, so its `!!js`
config expressions are evaluated only after the path is known. `failOnStartupError: false` keeps a broken Cua
Driver installation from taking the whole harness down; the MCP client reports the failure instead.

## Verify it worked

After a restart, ask the model to list its windows — or check from a shell:

```sh
cua-driver --version          # the binary the plugin will find
cua-driver doctor             # daemon and permission health
```

If the tools do not appear, the host log carries a `[cua-computer-use]` line naming the resolved path on success,
or every directory searched on failure. The plugin throws at load time rather than registering a row that cannot
spawn.

## Development

```sh
pnpm install   # dev-only: TypeScript typings
pnpm test      # node --test, no dependencies required
pnpm typecheck
```

The locator's filesystem probe and target platform are injectable, so the full search order is covered without
touching the disk or the host platform.

## License

MIT. Cua Driver is a separate project by [trycua](https://github.com/trycua/cua) and is not bundled here.
