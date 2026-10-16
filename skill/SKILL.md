---
name: cua-computer-use
description: Drive a native GUI application on the host through the cua-driver MCP tools registered by the cua-computer-use plugin — read a window's accessibility tree, act on snapshot-bound element tokens or pixel coordinates, and verify the result from fresh state. Use when the user asks to operate, automate, click through, fill in, or take a screenshot of a real application (Finder, System Settings, Word, a game launcher, a browser window the browser tools cannot reach), or to continue earlier Cua activity.
when-to-use: The task needs a real application's UI rather than an API, CLI, or file — "open X and do Y", "click the button in X", "fill this form in the app", "read what that window says", "screenshot my screen". Also when a GUI step blocks an otherwise scriptable task.
version: 1.0.0
---

# Computer use through Cua Driver

This plugin bridges the [Cua Driver](https://github.com/trycua/cua) MCP server into DeepSeek Harness.
Every tool below is registered as `mcp__cua-driver__<name>` (for example `mcp__cua-driver__get_window_state`);
the short names are used here for readability.

Cua Driver owns a background daemon, a screenshot/AX capture pipeline, and its own agent-cursor overlay.
It is **accessibility-first**: the primary way to address a control is a snapshot-bound `element_token`, not a pixel.

## The core loop

1. **Find the window.** `list_windows({ app: "Finder" })` returns `pid`, `window_id`, title, and on-screen state.
   If the app is not running, `launch_app({ bundle_id: "com.apple.finder" })` starts it **in the background** and
   returns the pid plus its windows, so you can skip a round trip.
2. **Read the window.** `get_window_state({ pid, window_id })` returns a compact Markdown accessibility tree
   plus a screenshot. A row `[11]` is addressed as `element_token: "<snapshot_id>:11"`.
   Start narrow: `query: "Save"` or `max_elements` before a full read.
3. **Act on the token.** `click({ element_token: "s0000002a:11" })`, `set_value({ element_token, value })`,
   `type_text({ element_token, text, replace: true })`.
4. **Verify.** Re-read with `since: "latest"` to get only what changed, or assert with
   `verify_state({ pid, window_id, expect: [{ role: "button", name: "Save", gone: true }] })`.

## Rules that keep this reliable

- **Tokens are snapshot-scoped.** A newer `get_window_state` of the same window invalidates the previous
  snapshot's tokens; a stale token fails loudly and names the current snapshots. Re-read after anything that
  reshuffles the window, and never carry a token across a navigation.
- **Prefer `element_token` over `x, y`.** Pixels move with layout, scaling, and scroll position. Use coordinates
  only for surfaces missing from the tree: canvas, video, WebGL, custom-drawn views.
- **`since: "latest"` is the cheap re-read.** Use it after every action instead of a full tree walk. If it reports
  `since_status` fallback, the scope changed — read fully once, then diff again.
- **Stay in the background.** The default `delivery_mode: "background"` does not raise the window or steal focus.
  Escalate to `foreground` only when a step is refused or provably did not land, and expect the pointer to move.
  Never reach for desktop-scope pointer tools while a window-scoped tool can do the job.
- **Batch with `run_steps`, branch with `run_script`.** `run_steps` runs a fixed list of actions in one call and
  returns one diff at the end. When the flow needs a loop, a condition, or a retry, use `run_script` instead of
  many round trips. Both stop at the first failure and report which step, in which phase.
- **Verify at checkpoints, not after every click.** `verify_state` returns `satisfied`, `unsatisfied`, or `unknown`;
  `unknown` is never success. `effect: "unverifiable"` on a keystroke is not a delivery failure — confirm visually.
- **Menus beat pixel-hunting.** `invoke_menu({ path: ["File", "Save As..."] })` resolves one native menu level at a
  time. Background key events do not reach a native app's menu bar, so a `cmd+s` on an unfocused app is routed
  through accessibility instead.
- **Window geometry is a first-class tool.** `set_window_frame` moves and resizes; `list_windows` reads it back.
- **Screenshot-only reads are cheap.** `get_window_state({ include_accessibility_tree: false })` returns pixels and
  keeps the current snapshot's rows and tokens valid — use it when you only need to look. Add `display_only: true`
  for a live preview that neither grounds input nor replaces the snapshot.

## Web pages

If the target is a page in Chrome, Edge, or Brave, do **not** drive it with desktop pointer tools.
Use `get_browser_state({ pid, window_id })` to bind the tab, then `browser_click`, `browser_type`,
`browser_pointer`, `browser_navigate`, `browser_dialog`. If binding is refused, `get_browser_state` names the
exact `browser_prepare` call that sets it up. Safari and embedded WebViews fall back to the AX tree.

## Sessions, cursor, and recording

`start_session` is optional; pass a short `session` label on every call that accepts one so a long run stays
grouped. Cursor appearance is cosmetic — `set_agent_cursor_enabled`, `set_agent_cursor_motion`,
`set_agent_cursor_theme`. `start_recording({ output_dir })` writes per-turn screenshots, AX state, and
`action.json` for later `replay_trajectory`; `stop_recording` finalizes it. Call `end_session` when a labeled
session is finished so its cleanup hooks run.

`history_status` / `history_query` recall recent Cua activity on this host — useful when the user asks you to
continue or remember what you did last time. Make one bounded query before broad discovery.

## Reading the screen when the tree is empty

Some surfaces (Electron, Catalyst, virtualized rows) report an empty or misleading AX tree. In that order:

1. Re-read the window; consider `delivery_mode: "foreground"` if the app was still launching.
2. `zoom({ window_id, x1, y1, x2, y2 })` for a cropped, higher-resolution look, then act with `from_zoom: true`.
3. `parse_visual_regions({ capture_id })` for model-neutral text and icon regions.
4. `get_desktop_state` only when no single window is the target.

## macOS permissions and health

`check_permissions({ prompt: false })` reports Accessibility and Screen Recording grants read-only;
`health_report()` is the one-call end-to-end diagnostic. If capture is blocked, the fix is granting the
permission to the **CuaDriver daemon** (or to the terminal that launched it), not to DeepSeek Harness.

## Environment

The plugin resolves the executable once at load time and hands the absolute path to the MCP client. Search order:
the `command` config option, then `CUA_DRIVER_BIN`, then the known install locations, then `PATH`. Resolution is
absolute on purpose — the desktop host is launched by `launchd`, whose `PATH` omits `~/.local/bin`.

If the tools are missing entirely, the plugin failed to find the binary and the host log carries a
`[cua-computer-use]` line naming every location it tried. Install Cua Driver with:

```sh
# macOS / Linux
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

```powershell
# Windows
irm https://cua.ai/driver/install.ps1 | iex
```

`cua-driver doctor` and `cua-driver check-update` are useful when the daemon misbehaves or the version is stale.
DeepSeek Harness renders its own computer-use skill; this one is the MCP-backed variant and the two can coexist.
