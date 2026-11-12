#!/usr/bin/env node
/**
 * Validate that a profile patch file (optionally with the managed block already
 * merged in) is a well-formed Cordis patch list and that this plugin's row is
 * shaped the way the loader expects.
 *
 * Usage:
 *   node scripts/validate-patch.mjs <patch.yml> [--expect-row]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const yamlPath = path.resolve(here, '..', 'ref', 'js-yaml', 'dist', 'js-yaml.mjs')
const yaml = await import(new URL(`file:///${yamlPath.replaceAll('\\', '/')}`).href)

const file = process.argv[2]
const expectRow = process.argv.includes('--expect-row')
if (!file) throw new Error('usage: node scripts/validate-patch.mjs <patch.yml> [--expect-row]')

const text = fs.readFileSync(file, 'utf8')
let entries
try {
  entries = yaml.load(text)
} catch (error) {
  console.error(`YAML parse failed: ${error.message}`)
  process.exit(1)
}

const problems = []
if (!Array.isArray(entries)) problems.push('patch must be a top-level YAML array')

const rows = []
for (const [index, entry] of (entries ?? []).entries()) {
  if (entry === null || typeof entry !== 'object') {
    problems.push(`entry ${index} is not a mapping`)
    continue
  }
  const keys = Object.keys(entry)
  if (keys.includes('insert')) {
    if (!Array.isArray(entry.insert)) problems.push(`entry ${index}: "insert" must be a list`)
    else rows.push(...entry.insert)
  } else if (keys.includes('id')) {
    rows.push(entry)
  } else {
    problems.push(`entry ${index}: neither "insert" nor "id": ${keys.join(', ')}`)
  }
}

const pluginRows = rows.filter((row) => row?.id === 'llm-retry-upstream-400')
if (expectRow) {
  if (pluginRows.length !== 1) problems.push(`expected exactly one row with id "llm-retry-upstream-400", found ${pluginRows.length}`)
  const [row] = pluginRows
  if (row) {
    if (typeof row.name !== 'string' || row.name.length === 0) problems.push('plugin row needs a "name"')
    else if (!/^file:\/\//.test(row.name) && !/^[./]/.test(row.name)) {
      problems.push(`plugin row name should be a file URL (got ${row.name})`)
    } else if (!fs.existsSync(fileURLToPath(row.name))) {
      problems.push(`plugin row name does not resolve to a file: ${row.name}`)
    }
    const config = row.config ?? {}
    const allowed = new Set(['enabled', 'delayMs', 'maxRetries', 'statuses', 'codes', 'matchPattern'])
    for (const key of Object.keys(config)) if (!allowed.has(key)) problems.push(`unknown plugin config key "${key}"`)
    if (typeof config.delayMs !== 'number' || config.delayMs < 0) problems.push('config.delayMs must be a number >= 0')
    if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) problems.push('config.maxRetries must be a non-negative integer')
  }
}

if (problems.length > 0) {
  console.error(`invalid patch (${file}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`ok: ${file} parses as a patch list with ${entries.length} entries and ${rows.length} rows`)
if (pluginRows.length) console.log(`    plugin row: ${JSON.stringify(pluginRows[0])}`)
