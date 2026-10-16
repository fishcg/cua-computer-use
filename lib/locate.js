/**
 * Cross-platform discovery of the `cua-driver` executable.
 *
 * The desktop host is started by launchd (macOS) or a desktop shortcut
 * (Windows), so its `PATH` is not the one an interactive shell has. On macOS in
 * particular `~/.local/bin` — where the Cua Driver installer puts the binary —
 * is almost never present. Resolving an absolute path here is what makes the
 * plugin work without the user hand-editing their profile.
 *
 * Everything in this module is pure apart from the filesystem probe, which is
 * injectable so the search order can be tested without touching the disk.
 *
 * @module cua-computer-use/locate
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, posix, win32 } from 'node:path'

/** Executable base name shipped by Cua Driver. */
export const BINARY = 'cua-driver'

/** Environment variable that pins an absolute path, overriding all discovery. */
export const ENV_OVERRIDE = 'CUA_DRIVER_BIN'

/** Install one-liners shown when the binary cannot be found. */
export const INSTALL_COMMANDS = {
  unix: '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"',
  win32: 'irm https://cua.ai/driver/install.ps1 | iex',
}

/** Candidate file names, most specific first. */
function executableNames(platform) {
  return platform === 'win32'
    ? [`${BINARY}.exe`, `${BINARY}.cmd`, `${BINARY}.bat`, BINARY]
    : [BINARY]
}

/**
 * Path flavour for a target platform. Using the target's flavour rather than
 * the host's keeps Windows and POSIX joins correct when a platform is
 * simulated, which is what the tests do.
 *
 * @param {string} platform - `process.platform` value.
 * @returns {typeof posix} the matching path module.
 */
function pathApi(platform) {
  return platform === 'win32' ? win32 : posix
}

/**
 * Whether `path` is a regular file this process may execute.
 *
 * @param {string} path - candidate path.
 * @returns {boolean} whether the path is runnable.
 */
export function isRunnableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Directories searched for the executable, in priority order.
 *
 * @param {object} [options] - overrides for testing.
 * @param {string} [options.platform] - `process.platform` value.
 * @param {string} [options.home] - user home directory.
 * @param {Record<string, string | undefined>} [options.env] - environment.
 * @returns {string[]} absolute directories, de-duplicated.
 */
export function searchDirectories(options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const join = pathApi(platform).join
  /** @type {string[]} */
  const dirs = []
  const push = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
    push(local && join(local, 'Programs', BINARY))
    push(local && join(local, BINARY))
    push(programFiles && join(programFiles, BINARY))
    push(home && join(home, '.local', 'bin'))
    push(home && join(home, '.cargo', 'bin'))
    return dirs
  }

  push(home && join(home, '.local', 'bin'))
  if (platform === 'darwin') {
    push('/opt/homebrew/bin')
    push('/Applications/CuaDriver.app/Contents/MacOS')
    push(home && join(home, 'Applications/CuaDriver.app/Contents/MacOS'))
  }
  push(home && join(home, '.cargo', 'bin'))
  push('/usr/local/bin')
  push('/usr/bin')
  if (platform === 'linux') push('/snap/bin')
  return dirs
}

/**
 * Whether a configured command names a path rather than a bare executable.
 *
 * @param {string} value - the configured command.
 * @returns {boolean} whether it carries directory components.
 */
function looksLikePath(value) {
  return isAbsolute(value) || value.includes('/') || value.includes('\\')
}

/**
 * Resolve the `cua-driver` executable.
 *
 * Order: explicit config, then `CUA_DRIVER_BIN`, then well-known install
 * directories, then `PATH`. An explicit value is authoritative: when it does
 * not resolve, discovery stops instead of silently running a different binary.
 *
 * @param {object} [options] - discovery inputs.
 * @param {string} [options.explicit] - `command` from the plugin config.
 * @param {string} [options.platform] - `process.platform` value.
 * @param {string} [options.home] - user home directory.
 * @param {Record<string, string | undefined>} [options.env] - environment.
 * @param {(path: string) => boolean} [options.isFile] - filesystem probe.
 * @returns {{ command: string | null, source: string | null, checked: string[], explicit: string | null }} the resolution result.
 */
export function locateCuaDriver(options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const isFile = options.isFile ?? isRunnableFile
  const names = executableNames(platform)
  const pathSeparator = platform === 'win32' ? ';' : ':'
  const join = pathApi(platform).join
  /** @type {string[]} */
  const checked = []

  /** @type {(path: string) => string | null} */
  const probe = (path) => {
    checked.push(path)
    return isFile(path) ? path : null
  }

  /** @type {(value: string, dir: string) => string | null} */
  const probeIn = (value, dir) => {
    for (const n of names) {
      const hit = probe(join(dir, n))
      if (hit) return hit
    }
    return null
  }

  const explicit = (options.explicit ?? '').trim()
  if (explicit) {
    if (looksLikePath(explicit)) {
      const hit = probe(explicit)
      return { command: hit, source: hit ? 'config' : null, checked, explicit }
    }
    for (const dir of (env.PATH ?? '').split(pathSeparator)) {
      if (!dir) continue
      const hit = probeIn(explicit, dir)
      if (hit) return { command: hit, source: 'config', checked, explicit }
    }
    return { command: null, source: null, checked, explicit }
  }

  const fromEnv = (env[ENV_OVERRIDE] ?? '').trim()
  if (fromEnv) {
    const hit = looksLikePath(fromEnv)
      ? probe(fromEnv)
      : (() => {
          for (const dir of (env.PATH ?? '').split(pathSeparator)) {
            if (!dir) continue
            const found = probeIn(fromEnv, dir)
            if (found) return found
          }
          return null
        })()
    return { command: hit, source: hit ? 'env' : null, checked, explicit: fromEnv }
  }

  for (const dir of searchDirectories({ platform, home, env })) {
    const hit = probeIn(BINARY, dir)
    if (hit) return { command: hit, source: 'known-directory', checked, explicit: null }
  }

  for (const dir of (env.PATH ?? '').split(pathSeparator)) {
    if (!dir) continue
    const hit = probeIn(BINARY, dir)
    if (hit) return { command: hit, source: 'PATH', checked, explicit: null }
  }

  return { command: null, source: null, checked, explicit: null }
}

/**
 * Build the operator-facing failure message for an unresolved binary.
 *
 * @param {ReturnType<typeof locateCuaDriver>} result - the failed resolution.
 * @param {object} [options] - message inputs.
 * @param {string} [options.platform] - `process.platform` value.
 * @returns {string} a multi-line, actionable error message.
 */
export function missingBinaryMessage(result, options = {}) {
  const platform = options.platform ?? process.platform
  const install = platform === 'win32' ? INSTALL_COMMANDS.win32 : INSTALL_COMMANDS.unix
  /** @type {string[]} */
  const lines = []

  if (result.explicit) {
    lines.push(
      `the configured cua-driver path does not exist or is not executable: ${result.explicit}`,
      '',
      'Fix `command` on the `cua-computer-use` row in your profile, or unset it to',
      'fall back to automatic discovery.',
    )
  } else {
    lines.push(
      'cannot find the `cua-driver` executable.',
      '',
      'Install it, then restart dsh:',
      `  ${install}`,
    )
  }

  lines.push(
    '',
    'If it is already installed somewhere unusual, either set `command` on the',
    `\`cua-computer-use\` row in your profile, or export ${ENV_OVERRIDE}=/absolute/path.`,
  )

  if (result.checked.length > 0) {
    lines.push('', 'Searched:', ...result.checked.map((p) => `  ${p}`))
  }

  return lines.join('\n')
}
