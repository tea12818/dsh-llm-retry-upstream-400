#!/usr/bin/env node
/**
 * Install (or remove) the dsh-llm-retry-upstream-400 row in a DSH profile's
 * `cordis.patch.yml`.
 *
 * The row inserts one plugin whose name is a `file:` URL, so no package
 * installation or network access is involved: the running profile composes the
 * row, imports the module straight from this checkout, and hot-reloads on save.
 *
 * Usage:
 *   node scripts/install.mjs                  # install/update into $DSH_PROFILE_DIR
 *   node scripts/install.mjs --delay-ms 3000  # change the retry delay
 *   node scripts/install.mjs --uninstall      # remove the row again
 *   node scripts/install.mjs --profile-dir <dir> --dry-run
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SENTINEL_START = '# >>> dsh-llm-retry-upstream-400 (managed by scripts/install.mjs)'
const SENTINEL_END = '# <<< dsh-llm-retry-upstream-400'
const PLUGIN_ID = 'llm-retry-upstream-400'

const here = path.dirname(fileURLToPath(import.meta.url))
const checkout = path.resolve(here, '..')

function parseArgs(argv) {
  const options = {
    profileDir: process.env.DSH_PROFILE_DIR ?? '',
    delayMs: 5000,
    maxRetries: 12,
    uninstall: false,
    dryRun: false,
    emit: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--emit') options.emit = argv[++i]
    else if (arg === '--profile-dir') options.profileDir = argv[++i]
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i])
    else if (arg === '--max-retries') options.maxRetries = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown argument "${arg}"`)
  }
  if (!options.profileDir && !options.emit) throw new Error('set DSH_PROFILE_DIR or pass --profile-dir <dir>')
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new Error('--delay-ms must be >= 0')
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0) throw new Error('--max-retries must be a non-negative integer')
  return options
}

/** Render the managed patch block for the given options. */
function renderBlock(options) {
  const entry = path.join(checkout, 'lib', 'index.js')
  if (!fs.existsSync(entry)) throw new Error(`plugin entry not found: ${entry}`)
  const pluginUrl = pathToFileURL(entry).href
  return [
    SENTINEL_START,
    '- insert:',
    `    - id: ${PLUGIN_ID}`,
    `      name: '${pluginUrl}'`,
    '      config:',
    '        enabled: true',
    `        delayMs: ${options.delayMs}`,
    `        maxRetries: ${options.maxRetries}`,
    '        statuses: [400]',
    '        codes: [INVALID_REQUEST]',
    "        matchPattern: 'upstream\\s+error\\s*\\(\\s*request\\s*id'",
    SENTINEL_END,
    '',
  ].join('\n')
}

/** Remove a previously managed block, leaving the rest of the file intact. */
function stripBlock(text) {
  const start = text.indexOf(SENTINEL_START)
  if (start === -1) return text
  const end = text.indexOf(SENTINEL_END, start)
  const after = end === -1 ? text.length : end + SENTINEL_END.length
  // Swallow the trailing newline of the managed block, keep everything else.
  const tail = text.slice(after).replace(/^\r?\n/, '')
  return `${text.slice(0, start)}${tail}`.replace(/\s+$/, '\n')
}

/** True when a hand-written row already owns this plugin id. */
function hasManualEntry(text) {
  return new RegExp(String.raw`^\s*-?\s*id:\s*${PLUGIN_ID}\s*$`, 'm').test(text)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.emit) {
    fs.mkdirSync(path.dirname(path.resolve(options.emit)), { recursive: true })
    fs.writeFileSync(path.resolve(options.emit), renderBlock(options), 'utf8')
    console.log(`wrote overlay patch: ${path.resolve(options.emit)}`)
    return
  }

  const patchPath = path.join(options.profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) throw new Error(`profile patch not found: ${patchPath}`)

  const original = fs.readFileSync(patchPath, 'utf8')
  let updated = stripBlock(original)

  if (!options.uninstall) {
    if (hasManualEntry(updated)) {
      throw new Error(
        `a row with id "${PLUGIN_ID}" already exists in ${patchPath} outside the managed block; remove it first`,
      )
    }
    if (updated.trim() === '' ) updated = '\n'
    updated = `${updated.replace(/\s+$/, '')}\n\n${renderBlock(options)}`
  }

  if (updated === original) {
    console.log(`nothing to do: ${patchPath} already has the expected row`)
    return
  }

  if (options.dryRun) {
    console.log(`--- ${patchPath} (dry run) ---`)
    console.log(updated)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${patchPath}.bak-${stamp}`
  fs.writeFileSync(backup, original, 'utf8')
  fs.writeFileSync(patchPath, updated, 'utf8')

  console.log(`${options.uninstall ? 'removed' : 'installed'} ${PLUGIN_ID}`)
  console.log(`  profile patch: ${patchPath}`)
  console.log(`  backup:        ${backup}`)
  if (!options.uninstall) {
    console.log(`  delay:         ${options.delayMs}ms x up to ${options.maxRetries} retries per step`)
    console.log('The running profile hot-reloads the patch; restart the app if the plugin does not appear.')
  }
}

try {
  main()
} catch (error) {
  console.error(`install failed: ${error.message}`)
  process.exitCode = 1
}
