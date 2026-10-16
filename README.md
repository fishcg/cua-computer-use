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
- Nothing else for a first run. If `cua-driver` is missing, the plugin installs it — see
  [First run](#first-run). To install it yourself instead, or to install it before the harness starts:

  ```sh
  # macOS / Linux
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  ```

  ```powershell
  # Windows
  irm https://cua.ai/driver/install.ps1 | iex
  ```

- macOS: **Accessibility** and **Screen Recording**. The plugin checks these and walks you through granting
  them; nothing else is needed from you.

## First run

The plugin sets itself up, in this order, and neither step can stop the harness from booting.

**1. The executable.** `cua-driver` is looked for in your config, then `$CUA_DRIVER_BIN`, then the standard
install locations, then `PATH`. If it is nowhere, the plugin runs the official installer with the same
one-liner the vendor documents, and then looks again.

The installer is driven by environment variables rather than flags — that is the interface the vendor
documents as stable, and it behaves identically on Windows, where there is no shell to quote for. Three
defaults are worth knowing, because a boot has no consent step and a human typing `curl … | bash` does:

| Variable | Default | Why |
| --- | --- | --- |
| `CUA_DRIVER_RS_NO_MODIFY_PATH` | `1` | The plugin hands the MCP client an absolute path, so appending to your `~/.zshrc` would be a side effect nobody would think to look for. Set `modifyPath: true` to allow it. |
| `CUA_DRIVER_RS_TELEMETRY_ENABLED` | `0` | Install telemetry is opt-in here, not opt-out. Set `installTelemetry: true` to send it. |
| `CUA_DRIVER_RS_INSTALL_DIR` | unset | Set `installDir` to install somewhere other than `~/.local/bin`. |

Everything the installer writes is verified against the release's `SHA256SUMS`, and the macOS app bundle is
codesign-checked before it is linked. Set `autoInstall: false`, or export `CUA_DRIVER_NO_AUTO_INSTALL=1`, to
keep the plugin from installing anything at all — it will then fail with the manual command instead.

**2. macOS permissions.** A second after the service is published, the plugin reads
`cua-driver permissions status --json` and, if a grant is being withheld, prints what to enable and where. It
also asks the driver to raise the system prompts itself, **once per missing grant**: the marker lives in
`~/.dsh/cua-computer-use/setup.json`, so later boots tell you what is still missing without re-prompting.

The grant belongs to **CuaDriver**, not to DeepSeek Harness — macOS attributes these permissions to the
process that owns the accessibility API, which is the driver daemon. Set `permissionCheck: false` to skip the
check, or `permissionPrompt: false` to report without ever raising a prompt.

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
| `autoInstall` | `boolean` | `true` | Install `cua-driver` when it is missing. Off means failing with the manual command instead. |
| `installTimeoutMs` | `number` | `300000` | Deadline for the installer. |
| `installEnv` | `object` | `{}` | Extra environment variables for the installer; wins over the defaults above. |
| `installTelemetry` | `boolean` | `false` | Let the installer send its install event. |
| `modifyPath` | `boolean` | `false` | Let the installer append its directory to your shell rc files. |
| `installDir` | `string` | `''` | Install the executable here instead of the installer's default. |
| `permissionCheck` | `boolean` | `true` | Check the macOS grants once after startup. Windows and Linux skip this. |
| `permissionPrompt` | `boolean` | `true` | Ask the driver to raise the macOS permission prompts, once per missing grant. |

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
or every directory searched on failure. A missing binary is loud but not fatal: the plugin's own row goes
inactive with the exact fix, and every other row keeps running. The MCP row then stays `pending (waiting for
service: cuaComputerUse)` instead of dying, so fixing the binary and restarting is all it takes.

Setup lines you should expect on a first run:

```
[cua-computer-use] cua-driver was not found; installing it with the official installer
[cua-computer-use] cua-driver installed: /Users/you/.local/bin/cua-driver
[cua-computer-use] cua-driver: /Users/you/.local/bin/cua-driver (via known-directory)
[cua-computer-use] macOS is withholding Accessibility, so the cua-driver tools will observe but not act.
```

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
