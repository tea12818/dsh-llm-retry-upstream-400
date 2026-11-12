/**
 * Retry a failed model request a fixed number of milliseconds after an
 * upstream-provider 400 rejection.
 *
 * Some OpenAI-compatible gateways answer a perfectly valid request with
 * `400: {"message":"Upstream error (request id: ...)"}` while their own
 * upstream is temporarily unavailable. Route-level retry policies treat that
 * HTTP 400 as a permanent `INVALID_REQUEST`, so the turn dies even though the
 * very same request succeeds a moment later.
 *
 * This plugin is one listener in the agent loop's `agent/request-error`
 * waterfall: when the terminal failure matches the configured upstream-400
 * shape, it waits (cancellably) and returns `{ kind: 'retry' }`, so the loop
 * re-runs the failed step inside the same open turn. Everything else is
 * delegated to the next listener unchanged.
 *
 * @module dsh-llm-retry-upstream-400
 */

/** Plugin display name used by the Cordis loader. */
export const name = 'llm-retry-upstream-400'

/** No mandatory services: the plugin only observes an agent event and logs. */
export const inject = []

/** Largest delay accepted, matching Node's timer ceiling. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Defaults tuned for "the gateway hiccuped, try again in a moment". */
const DEFAULTS = Object.freeze({
  enabled: true,
  delayMs: 5000,
  maxRetries: 12,
  statuses: Object.freeze([400]),
  codes: Object.freeze(['INVALID_REQUEST']),
  matchPattern: String.raw`upstream\s+error\s*\(\s*request\s*id`,
})

/** Keys accepted in the plugin config; anything else is a typo worth failing on. */
const CONFIG_KEYS = new Set([
  'enabled',
  'delayMs',
  'maxRetries',
  'statuses',
  'codes',
  'matchPattern',
])

/** Bounds for the in-memory retry ledger, so a long-lived process cannot leak. */
const LEDGER_LIMIT = 512

/**
 * Validate, default, and freeze one plugin configuration.
 * @param raw - the config object supplied by the profile patch (`undefined` when omitted).
 * @returns an immutable normalized config.
 * @throws when a key is unknown or a value is outside its documented domain.
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('llm-retry-upstream-400: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`llm-retry-upstream-400: unknown key "${key}"`)
  }

  const enabled = raw.enabled ?? DEFAULTS.enabled
  if (typeof enabled !== 'boolean') throw new Error('llm-retry-upstream-400: "enabled" must be a boolean')

  const delayMs = raw.delayMs ?? DEFAULTS.delayMs
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-retry-upstream-400: "delayMs" must be a finite number between 0 and ${MAX_TIMER_DELAY_MS}`)
  }

  const maxRetries = raw.maxRetries ?? DEFAULTS.maxRetries
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('llm-retry-upstream-400: "maxRetries" must be a non-negative safe integer')
  }

  const statuses = raw.statuses ?? [...DEFAULTS.statuses]
  if (!Array.isArray(statuses)) throw new Error('llm-retry-upstream-400: "statuses" must be an array of HTTP status codes')
  for (const status of statuses) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error('llm-retry-upstream-400: "statuses" must contain only HTTP status codes (100-599)')
    }
  }

  const codes = raw.codes ?? [...DEFAULTS.codes]
  if (!Array.isArray(codes)) throw new Error('llm-retry-upstream-400: "codes" must be an array of failure codes')
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('llm-retry-upstream-400: "codes" must contain only non-empty strings')
    }
  }

  const matchPattern = raw.matchPattern ?? DEFAULTS.matchPattern
  if (typeof matchPattern !== 'string' || matchPattern.length === 0) {
    throw new Error('llm-retry-upstream-400: "matchPattern" must be a non-empty regular expression source')
  }
  let matcher
  try {
    matcher = new RegExp(matchPattern, 'i')
  } catch (error) {
    throw new Error(`llm-retry-upstream-400: "matchPattern" is not a valid regular expression: ${error.message}`)
  }

  return Object.freeze({
    enabled,
    delayMs,
    maxRetries,
    statuses: Object.freeze([...statuses]),
    codes: Object.freeze([...codes]),
    matchPattern,
    matcher,
  })
}

/**
 * Read an HTTP status out of a provider message such as
 * `400: {"message":"Upstream error ..."}` or `HTTP 400 ...`.
 * @param message - the failure message text.
 * @returns the status code, or undefined when the text names none.
 */
export function statusFromMessage(message) {
  if (typeof message !== 'string') return undefined
  const match = /(?:^|\b(?:http|status|error)(?:\s+code)?\s*[:=]?\s*)([45]\d{2})\b/i.exec(message)
  if (match === null) return undefined
  const status = Number(match[1])
  return Number.isInteger(status) ? status : undefined
}

/**
 * Decide whether one terminal model-request failure is the upstream-400 shape
 * this plugin covers.
 * @param failure - the failure facts carried by `agent/request-error`.
 * @param config - normalized plugin config.
 * @returns true when the failure should be retried by this plugin.
 */
export function isUpstream400(failure, config) {
  if (failure === null || typeof failure !== 'object') return false
  const message = typeof failure.message === 'string' ? failure.message : ''
  if (!config.matcher.test(message)) return false

  if (config.codes.length > 0 && !config.codes.includes(failure.code)) return false

  if (config.statuses.length > 0) {
    const status = Number.isInteger(failure.status) ? failure.status : statusFromMessage(message)
    // An adapter that drops the status still names the provider in the message;
    // requiring a status there would silently miss the very failure this plugin
    // exists for, so only a status that is present and different rejects.
    if (status !== undefined && !config.statuses.includes(status)) return false
  }

  return true
}

/**
 * Wait for `delayMs`, resolving `false` when the signal aborts first.
 * @param delayMs - milliseconds to wait.
 * @param signal - cancellation signal (turn signal fused with plugin lifetime).
 * @returns true when the full delay elapsed, false when it was aborted.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  if (delayMs === 0) return Promise.resolve(!signal.aborted)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Fuse the turn signal with the plugin lifetime without depending on AbortSignal.any. */
function fuseSignals(turnSignal, lifetimeSignal) {
  if (turnSignal === undefined) return lifetimeSignal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([turnSignal, lifetimeSignal])
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (turnSignal.aborted || lifetimeSignal.aborted) controller.abort()
  else {
    turnSignal.addEventListener('abort', abort, { once: true })
    lifetimeSignal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/**
 * Mount the upstream-400 retry listener.
 *
 * Config keys (all optional): `enabled`, `delayMs` (default 5000), `maxRetries`
 * (default 12, counted per session/turn/step), `statuses` (default `[400]`),
 * `codes` (default `['INVALID_REQUEST']`, empty disables the code filter), and
 * `matchPattern` (case-insensitive regular expression source).
 *
 * @param ctx - the Cordis plugin context.
 * @param rawConfig - the profile patch config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.('llm-retry-upstream-400: disabled by config')
    return
  }

  /** Retry attempts per `${session}:${turn}:${step}` for the current turn. */
  const attempts = new Map()
  /** Plugin lifetime; disposal aborts every active wait. */
  const lifetime = new AbortController()

  function attemptKey(agent, turn, step) {
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    return `${sessionId}:${turn}:${step}`
  }

  function readAttempts(key) {
    const entry = attempts.get(key)
    if (entry === undefined) return 0
    // Refresh insertion order so the ledger stays roughly LRU.
    attempts.delete(key)
    attempts.set(key, entry)
    return entry
  }

  function bumpAttempts(key) {
    const next = readAttempts(key) + 1
    attempts.set(key, next)
    while (attempts.size > LEDGER_LIMIT) {
      const oldest = attempts.keys().next().value
      attempts.delete(oldest)
    }
    return next
  }

  ctx.logger?.info?.(
    'llm-retry-upstream-400: active (delay %dms, up to %d retries per step, statuses %s, codes %s)',
    config.delayMs,
    config.maxRetries,
    config.statuses.join(','),
    config.codes.join(','),
  )

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return undefined

    const { agent, turn, step, provider, failure, signal } = payload ?? {}
    if (!isUpstream400(failure, config)) return next()

    const key = attemptKey(agent, turn, step)
    const attempt = readAttempts(key)
    if (attempt >= config.maxRetries) {
      ctx.logger?.warn?.(
        'llm-retry-upstream-400: retry budget exhausted (%d/%d) for provider "%s" at turn %s step %s; delegating the failure',
        attempt,
        config.maxRetries,
        String(provider),
        String(turn),
        String(step),
      )
      return next()
    }

    const retry = bumpAttempts(key)
    const fused = fuseSignals(signal, lifetime.signal)

    ctx.logger?.warn?.(
      'llm-retry-upstream-400: upstream 400 from provider "%s" at turn %s step %s; retry %d/%d in %dms',
      String(provider),
      String(turn),
      String(step),
      retry,
      config.maxRetries,
      config.delayMs,
    )

    return (async () => {
      if (!await cancellableDelay(config.delayMs, fused)) return undefined
      if (fused.aborted) return undefined
      return { kind: 'retry' }
    })()
  })

  ctx.effect(() => () => {
    disposeListener()
    lifetime.abort(new Error('llm-retry-upstream-400 plugin disposed'))
    attempts.clear()
  }, 'llm-retry-upstream-400: abort active waits')
}
