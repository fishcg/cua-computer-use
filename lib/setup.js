/**
 * First-run setup: put the Cua Driver binary on this machine, then get it the
 * macOS permission grants it needs.
 *
 * Two constraints shape this module.
 *
 * Installing is a side effect the operator must be able to see, and refuse. The
 * official installer is a remote shell script, so every knob that changes what
 * it does travels through the ENVIRONMENT rather than through interpolated
 * command text: an environment is logged verbatim, needs no quoting on any
 * platform, and behaves identically under bash and PowerShell. `autoInstall:
 * false`, or `CUA_DRIVER_NO_AUTO_INSTALL=1`, removes the step entirely.
 *
 * Failing here must never take the harness down with it. The harness boots with
 * the plugin inert, the operator gets an actionable message, and everything else
 * keeps working. Only the final "still not installed" error propagates, and it
 * carries the manual command.
 *
 * @module cua-computer-use/setup
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BINARY, isRunnableFile, locateCuaDriver } from './locate.js'

/** Where the official installers live. Both are also what `INSTALL_COMMANDS` quotes. */
export const INSTALLER_URL = {
  unix: 'https://cua.ai/driver/install.sh',
  win32: 'https://cua.ai/driver/install.ps1',
}

/** Default ceiling for the installer. A cold download plus signature check is slow. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000
/** Default ceiling for the short permission probes. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000

/** Set this to any non-empty value to suppress auto-install without editing config. */
export const AUTO_INSTALL_ENV = 'CUA_DRIVER_NO_AUTO_INSTALL'

/**
 * The harness home directory name, mirroring `DSH_HOME_DIR_NAME` from
 * `@deepseek-ai/dsh-home-paths`.
 *
 * The value is inlined rather than imported. In-box `@deepseek-ai/*` packages
 * are supplied to a plugin by the DSH loader at run time and are NOT resolvable
 * by plain Node resolution from an installed plugin directory — verified with
 * `import.meta.resolve` against a git-installed profile, which fails with
 * `ERR_MODULE_NOT_FOUND` for every one of them. Importing the helper would
 * therefore work only under the loader and break every direct invocation,
 * including this package's own tests.
 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Environment variable that overrides the harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Name of the plugin's state file inside its state directory. */
export const STATE_FILE = 'setup.json'

/** Human labels for the two TCC grants this product depends on. */
export const GRANT_LABELS = {
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
}

/**
 * @typedef {object} RunResult
 * @property {boolean} ok - whether the process exited zero.
 * @property {number | null} code - exit code, or null when it never ran.
 * @property {string} stdout - captured standard output.
 * @property {string} stderr - captured standard error.
 * @property {Error} [error] - why it failed, when it did.
 */

/**
 * @typedef {object} PermissionReport
 * @property {boolean | null} accessibility - Accessibility grant, or null when unreported.
 * @property {boolean | null} screenRecording - Screen Recording grant, or null when unreported.
 * @property {boolean | null} capturable - live capture probe, or null when unreported.
 * @property {string | null} bundle - bundle identifier of the process holding the grants.
 * @property {string | null} executable - path of the process holding the grants.
 * @property {string | null} platform - platform the driver reported.
 */

/**
 * @typedef {object} EnsureResult
 * @property {{ command: string | null, source: string | null, checked: Array<string>, explicit: string | null }} found - the located executable.
 * @property {boolean} installed - whether this call ran the installer successfully.
 * @property {Partial<RunResult>} [install] - the installer's result, when it ran.
 * @property {string} [skipped] - why installation did not happen.
 */

/** Grant keys, kept as a literal tuple so indexing a report stays type-safe. */
const GRANT_KEYS = /** @type {const} */ (['accessibility', 'screenRecording'])

/** A minimal leveled logger, matching what the harness hands a plugin. */
/** @type {Record<'info' | 'warn' | 'debug', (text: string) => void>} */
const NOOP_LOGGER = { info: () => {}, warn: () => {}, debug: () => {} }

/**
 * Build the leveled logger the rest of this module expects.
 *
 * Passing `ctx.logger` straight through does not work, for two independent
 * reasons. Its methods live on the prototype and are callable through `this`,
 * so reading e.g. `logger.warn` off the object and invoking it detached throws
 * `TypeError: this is not a function` — the kind of failure a `try`/`catch`
 * around a boot step quietly swallows. And its output does not reach the
 * terminal a `dsh` launch prints to, so guidance the user has to act on would
 * never be seen. So console first, harness logger second, and a harness logger
 * that misbehaves must not take the boot down with it.
 *
 * @param {{ logger?: { info?: Function, warn?: Function, debug?: Function } }} [ctx] - plugin context.
 * @returns {{ info: (text: string) => void, warn: (text: string) => void, debug: (text: string) => void }} the logger.
 */
export function createSetupLogger(ctx) {
  const harness = ctx?.logger
  /**
   * @param {'info' | 'warn' | 'debug'} level - log level.
   * @param {string} text - message body.
   */
  const write = (level, text) => {
    if (level === 'warn') console.warn(text)
    else console.log(text)
    try {
      // Explicit receiver: these methods throw when called detached.
      harness?.[level]?.call(harness, text)
    } catch {
      // Bookkeeping output must never be able to fail a boot.
    }
  }
  return {
    info: (text) => write('info', text),
    warn: (text) => write('warn', text),
    debug: (text) => write('debug', text),
  }
}

/**
 * Normalize an unknown JSON value to `true`, `false`, or `null` for "not reported".
 *
 * @param {unknown} value - value from the driver's JSON.
 * @returns {boolean | null} the tri-state value.
 */
const tri = (value) => (value === true ? true : value === false ? false : null)

/**
 * Coerce a thrown value into an Error.
 *
 * @param {unknown} value - whatever was thrown.
 * @returns {Error} an Error carrying the original message.
 */
const toError = (value) => (value instanceof Error ? value : new Error(String(value)))

/**
 * Build the installer command for a platform.
 *
 * Both branches run the documented one-liner verbatim. Nothing is appended to
 * it: the flags the installer accepts are mirrored by environment variables, and
 * environment variables are the only channel this module uses.
 *
 * @param {string} [platform] - `process.platform` by default.
 * @returns {{ file: string, args: string[] }} the command to spawn.
 */
export function installerInvocation(platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `irm ${INSTALLER_URL.win32} | iex`,
      ],
    }
  }
  return {
    file: '/bin/bash',
    args: ['-c', `curl -fsSL ${INSTALLER_URL.unix} | /bin/bash -s`],
  }
}

/**
 * Compose the installer's environment.
 *
 * Precedence, lowest first: the plugin's own defaults, then whatever the host
 * already exports, then `installEnv` from config. An inherited variable counts
 * as the operator speaking, so a value already present is never overwritten.
 *
 * @param {object} [options] - setup options.
 * @param {Record<string, string>} [options.env] - `installEnv` from config.
 * @param {boolean} [options.modifyPath] - let the installer edit the shell rc files.
 * @param {boolean} [options.telemetry] - send the installer's anonymized install event.
 * @param {string} [options.binDir] - install the executable here instead of the default.
 * @returns {Record<string, string | undefined>} the child environment.
 */
export function installEnvironment(options = {}) {
  const env = { ...process.env }

  // This plugin hands the MCP client an absolute path, so there is nothing for
  // a PATH entry to fix. Rewriting a shell rc file from a harness boot is a side
  // effect nobody would think to look for, so it stays off unless asked for.
  if (!options.modifyPath) {
    env.CUA_DRIVER_NO_MODIFY_PATH ||= '1'
    env.CUA_DRIVER_RS_NO_MODIFY_PATH ||= '1'
  }

  // Install-time telemetry is default-on upstream, which is a fair bargain when
  // a human typed the command and read the notice. A boot has no consent step,
  // so the plugin does not spend the operator's consent for them.
  env.CUA_DRIVER_RS_TELEMETRY_ENABLED ||= options.telemetry ? '1' : '0'

  if (options.binDir) env.CUA_DRIVER_RS_INSTALL_DIR ||= options.binDir

  Object.assign(env, options.env ?? {})
  env.CUA_TELEMETRY_ENABLED ||= env.CUA_DRIVER_RS_TELEMETRY_ENABLED
  return env
}

/**
 * Whether auto-install has been switched off from the environment.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {boolean} true when the kill switch is set to a non-empty value.
 */
export function autoInstallDisabled(env = process.env) {
  return Boolean(env[AUTO_INSTALL_ENV]?.trim())
}

/**
 * Resolve the directory this plugin may write its own state into.
 *
 * Mirrors `resolveDshHome` from `@deepseek-ai/dsh-home-paths`: an explicit
 * `$DSH_HOME` wins, otherwise `<os home>/.dsh`. A blank override is treated as
 * unset, so an empty variable never resolves the state directory to the current
 * working directory.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {string} [home] - operating-system home directory.
 * @returns {string} absolute path to the plugin's state directory.
 */
export function resolveStateDir(env = process.env, home = homedir()) {
  const configured = env[DSH_HOME_ENV]?.trim()
  return join(configured ? configured : join(home, DSH_HOME_DIR_NAME), 'cua-computer-use')
}

/**
 * Read the plugin's state file, tolerating absence and corruption.
 *
 * @param {string} dir - state directory.
 * @returns {Record<string, unknown>} stored state, or an empty object.
 */
export function readState(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the plugin's state file.
 *
 * State is a convenience, never a source of truth: a write that fails is
 * reported as `null` and the caller carries on.
 *
 * @param {string} dir - state directory.
 * @param {Record<string, unknown>} patch - keys to merge in.
 * @returns {Record<string, unknown> | null} the stored state, or null on failure.
 */
export function writeState(dir, patch) {
  try {
    mkdirSync(dir, { recursive: true })
    const next = { ...readState(dir), ...patch }
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`)
    return next
  } catch {
    return null
  }
}

/**
 * Spawn a process and collect its output under a hard deadline.
 *
 * @param {string} file - executable.
 * @param {string[]} args - arguments.
 * @param {object} [options] - spawn options.
 * @param {Record<string, string | undefined>} [options.env] - child environment.
 * @param {string} [options.cwd] - working directory; empty inherits.
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @returns {Promise<RunResult>} the result.
 */
export function run(file, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    let child
    try {
      child = spawn(file, args, {
        env: options.env ?? process.env,
        cwd: options.cwd || undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: toError(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    /** @param {RunResult} result - the outcome to settle with. */
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone; the close handler below reports the real outcome.
      }
      settle({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: new Error(`timed out after ${timeoutMs} ms`),
      })
    }, timeoutMs)
    // A pending probe must never be the reason the harness stays alive.
    timer.unref?.()

    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => settle({ ok: false, code: null, stdout, stderr, error: toError(error) }))
    child.on('close', (code, signal) => {
      settle({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? undefined : new Error(signal ? `killed by ${signal}` : `exited with code ${code}`),
      })
    })
  })
}

/**
 * Run the official installer.
 *
 * @param {object} [options] - install options.
 * @param {string} [options.platform] - platform to install for.
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @param {boolean} [options.modifyPath] - allow shell rc edits.
 * @param {boolean} [options.telemetry] - allow install telemetry.
 * @param {string} [options.binDir] - target directory for the executable.
 * @param {Record<string, string>} [options.env] - extra environment entries.
 * @returns {Promise<RunResult>} the installer result.
 */
export function runInstaller(options = {}) {
  const { file, args } = installerInvocation(options.platform)
  return run(file, args, {
    env: installEnvironment(options),
    timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  })
}

/**
 * Keep the last few lines of a long, noisy log.
 *
 * @param {string | undefined} text - captured output.
 * @param {number} [lines] - how many lines to keep.
 * @returns {string} the tail, trimmed.
 */
export function tail(text, lines = 12) {
  return String(text ?? '')
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .join('\n')
    .trim()
}

/**
 * Parse the JSON emitted by `cua-driver permissions status --json`.
 *
 * A field that is absent or not a boolean becomes `null` — "not reported" — so
 * that a future driver dropping a key can never be mistaken for a revoked
 * grant.
 *
 * @param {string} text - captured stdout.
 * @returns {PermissionReport | null} the report, or null when unparseable.
 */
export function parsePermissionReport(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const source = data.source && typeof data.source === 'object' ? data.source : {}
  return {
    accessibility: tri(data.accessibility),
    screenRecording: tri(data.screen_recording),
    capturable: tri(data.screen_recording_capturable),
    bundle: typeof source.bundle_id === 'string' ? source.bundle_id : null,
    executable: typeof source.executable === 'string' ? source.executable : null,
    platform: typeof data.platform === 'string' ? data.platform : null,
  }
}

/**
 * List the grants macOS is explicitly withholding.
 *
 * @param {Partial<PermissionReport> | null} report - a parsed report.
 * @returns {Array<(typeof GRANT_KEYS)[number]>} the missing grant keys.
 */
export function missingGrants(report) {
  if (!report) return []
  return GRANT_KEYS.filter((key) => report[key] === false)
}

/**
 * Compose the guidance shown when a grant is missing.
 *
 * @param {object} options - guidance inputs.
 * @param {string} options.command - absolute path to the cua-driver executable.
 * @param {Partial<PermissionReport>} options.report - a parsed report.
 * @returns {string} a copy-pasteable, multi-line guide.
 */
export function permissionGuide({ command, report }) {
  const missing = missingGrants(report)
  const labels = missing.map((key) => GRANT_LABELS[key])
  const owner = report?.bundle ? `CuaDriver (${report.bundle})` : 'CuaDriver'
  return [
    `macOS is withholding ${labels.join(' and ')}, so the cua-driver tools will observe but not act.`,
    `The grant belongs to ${owner}, not to DeepSeek Harness: macOS attributes these permissions to the process that owns the accessibility API, and that is the driver daemon.`,
    'Grant it in System Settings → Privacy & Security:',
    ...labels.map((label) => `  • ${label} → enable CuaDriver`),
    `Or let the driver raise the prompts itself:  ${command} permissions grant`,
    `Then re-check with:  ${command} permissions status`,
  ].join('\n')
}

/**
 * Ask the driver for its current permission status.
 *
 * @param {string} command - absolute path to the cua-driver executable.
 * @param {object} [options] - probe options.
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @param {Record<string, string>} [options.env] - child environment.
 * @returns {Promise<ReturnType<typeof parsePermissionReport>>} the report, or null when unavailable.
 */
export async function probePermissions(command, options = {}) {
  const result = await run(command, ['permissions', 'status', '--json'], {
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  })
  if (!result.ok) return null
  return parsePermissionReport(result.stdout)
}

/**
 * Ask the driver to raise the macOS permission prompts.
 *
 * The driver does this by re-launching CuaDriver through LaunchServices, so the
 * prompt is attributed to the app rather than to the harness.
 *
 * @param {string} command - absolute path to the cua-driver executable.
 * @param {object} [options] - prompt options.
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @param {Record<string, string>} [options.env] - child environment.
 * @returns {Promise<RunResult>} the result.
 */
export function requestPermissions(command, options = {}) {
  return run(command, ['permissions', 'grant'], {
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  })
}

/**
 * Report on — and, once per distinct problem, prompt for — the macOS grants.
 *
 * This never throws. It runs after the service is published so that a slow or
 * absent driver daemon can never delay the row that the MCP client is waiting
 * on, and every failure mode degrades to a log line.
 *
 * The prompt fires at most once per distinct set of missing grants, recorded in
 * the plugin's state file. macOS only shows a dialog the first time anyway, so
 * re-running it every boot would be pure noise; the guide is logged every time,
 * because that is the part that stays useful.
 *
 * @param {object} options - check options.
 * @param {string} options.command - absolute path to the cua-driver executable.
 * @param {string} [options.stateDir] - directory for the prompt marker.
 * @param {string} options.platform - the platform to check.
 * @param {boolean} [options.prompt] - whether the driver may raise prompts.
 * @param {number} [options.timeoutMs] - deadline per subprocess.
 * @param {Record<string, string>} [options.env] - child environment.
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger] - harness logger.
 * @param {string} [options.label] - log prefix.
 * @returns {Promise<{ status: string, missing?: Array<string>, report?: PermissionReport | null }>} the outcome.
 */
export async function checkPermissions(options) {
  const label = options.label ?? ''
  /** @param {'info' | 'warn' | 'debug'} level - log level.
   * @param {string} text - message body. */
  const say = (level, text) => (options.logger?.[level] ?? NOOP_LOGGER[level])(label ? `${label} ${text}` : text)

  if (options.platform !== 'darwin') return { status: 'not-applicable' }

  const report = await probePermissions(options.command, options)
  if (!report) {
    say('debug', 'could not read macOS permission status; skipping the check')
    return { status: 'unknown', report: null }
  }

  const missing = missingGrants(report)
  if (missing.length === 0) return { status: 'granted', report }

  say('warn', permissionGuide({ command: options.command, report }))

  const signature = missing.join('+')
  if (!options.prompt) return { status: 'missing', missing, report }

  // Without a state directory the marker cannot be kept, so the prompt is
  // skipped rather than repeated on every boot.
  const stateDir = options.stateDir
  if (!stateDir) return { status: 'missing', missing, report }
  if (readState(stateDir).promptedFor === signature) {
    return { status: 'missing', missing, report }
  }

  writeState(stateDir, { promptedFor: signature, promptedAt: new Date().toISOString() })
  const prompted = await requestPermissions(options.command, options)
  if (!prompted.ok) {
    say('debug', `could not raise the macOS permission prompts: ${prompted.error?.message ?? 'unknown error'}`)
    return { status: 'missing', missing, report }
  }
  say('info', 'asked macOS for the missing permissions; approve the CuaDriver prompts and restart the harness')
  return { status: 'prompted', missing, report }
}

/**
 * Locate the executable, installing it first when it is absent and allowed.
 *
 * @param {object} options - resolution options.
 * @param {string} [options.explicit] - configured absolute path.
 * @param {boolean} [options.autoInstall] - install when nothing is found.
 * @param {string} [options.platform] - platform to resolve for.
 * @param {string} [options.home] - operating-system home directory.
 * @param {Record<string, string>} [options.env] - environment used for lookup.
 * @param {Record<string, string>} [options.installEnv] - extra installer environment.
 * @param {number} [options.timeoutMs] - installer deadline.
 * @param {boolean} [options.modifyPath] - allow shell rc edits.
 * @param {boolean} [options.telemetry] - allow install telemetry.
 * @param {string} [options.binDir] - install directory.
 * @param {(path: string) => boolean} [options.isFile] - filesystem probe, for tests.
 * @param {(options?: object) => Promise<Partial<RunResult>>} [options.install] - installer runner, for tests.
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger] - harness logger.
 * @param {string} [options.label] - log prefix.
 * @returns {Promise<EnsureResult>} the resolution outcome.
 */
export async function ensureBinary(options = {}) {
  const label = options.label ?? ''
  /** @param {'info' | 'warn' | 'debug'} level - log level.
   * @param {string} text - message body. */
  const say = (level, text) => (options.logger?.[level] ?? NOOP_LOGGER[level])(label ? `${label} ${text}` : text)
  const probe = options.isFile ?? isRunnableFile
  const installFn = options.install ?? runInstaller

  const locate = () =>
    locateCuaDriver({
      explicit: options.explicit,
      platform: options.platform,
      home: options.home,
      env: options.env,
      isFile: probe,
    })

  const found = locate()
  if (found.command) return { found, installed: false }

  if (!options.autoInstall) return { found, installed: false, skipped: 'disabled' }
  if (autoInstallDisabled(options.env)) return { found, installed: false, skipped: 'environment' }
  if (found.explicit) return { found, installed: false, skipped: 'explicit-missing' }

  say('info', 'cua-driver was not found; installing it with the official installer')
  const install = await installFn({
    platform: options.platform,
    timeoutMs: options.timeoutMs,
    modifyPath: options.modifyPath,
    telemetry: options.telemetry,
    binDir: options.binDir,
    env: options.installEnv,
  })

  // A non-default install directory is not in the search path, so look there
  // directly before concluding that the install failed.
  if (options.binDir) {
    const candidate = join(options.binDir, BINARY)
    if (probe(candidate)) {
      return {
        found: { command: candidate, source: 'install', checked: found.checked, explicit: null },
        installed: true,
        install,
      }
    }
  }

  const after = locate()
  if (after.command) {
    say('info', `cua-driver installed: ${after.command}`)
    return { found: after, installed: true, install }
  }

  if (!install.ok) {
    say('warn', `the cua-driver installer failed: ${install.error?.message ?? 'unknown error'}`)
    const output = tail(`${install.stdout}\n${install.stderr}`)
    if (output) say('warn', `installer output:\n${output}`)
  }
  return { found: after, installed: false, install, skipped: 'install-failed' }
}
