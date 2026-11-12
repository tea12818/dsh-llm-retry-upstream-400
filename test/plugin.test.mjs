import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  isUpstream400,
  name,
  normalizeConfig,
  statusFromMessage,
} from '../lib/index.js'

/** Minimal Cordis context stand-in: records the listener and the effect disposer. */
function fakeCtx() {
  const disposers = []
  const logs = []
  const ctx = {
    listeners: new Map(),
    logs,
    disposers,
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    on(event, listener) {
      ctx.listeners.set(event, listener)
      const dispose = () => ctx.listeners.delete(event)
      disposers.push(dispose)
      return dispose
    },
    effect(body, label) {
      const dispose = body(label)
      disposers.push(() => dispose())
      return () => {}
    },
  }
  return ctx
}

/** Emulate Cordis fiber disposal: every registered disposer runs in reverse order. */
function dispose(ctx) {
  for (const dispose of [...ctx.disposers].reverse()) dispose()
}

const UPSTREAM_MESSAGE =
  '400: {"message":"Upstream error (request id: 20261105-abc-def)"}'

function payload(overrides = {}) {
  return {
    agent: { id: 'agent-1', session: { id: 'session-1' } },
    turn: 1,
    step: 1,
    provider: 'yjs',
    failure: { message: UPSTREAM_MESSAGE, code: 'INVALID_REQUEST' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Run the plugin's listener once with a downstream sentinel. */
async function dispatch(ctx, input) {
  const listener = ctx.listeners.get('agent/request-error')
  assert.ok(listener, 'listener registered on agent/request-error')
  let delegated = 0
  const decision = await listener(input, () => {
    delegated += 1
    return { kind: 'downstream' }
  })
  return { decision, delegated }
}

test('exports a cordis plugin name', () => {
  assert.equal(name, 'llm-retry-upstream-400')
})

test('normalizeConfig applies defaults', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.delayMs, 5000)
  assert.equal(config.maxRetries, 12)
  assert.deepEqual(config.statuses, [400])
  assert.deepEqual(config.codes, ['INVALID_REQUEST'])
  assert.ok(config.matcher.test('Upstream error (request id: abc)'))
})

test('normalizeConfig rejects unknown keys and bad values', () => {
  assert.throws(() => normalizeConfig({ retryPolicies: [] }), /unknown key/)
  assert.throws(() => normalizeConfig({ delayMs: -1 }), /delayMs/)
  assert.throws(() => normalizeConfig({ maxRetries: 1.5 }), /maxRetries/)
  assert.throws(() => normalizeConfig({ statuses: [99] }), /statuses/)
  assert.throws(() => normalizeConfig({ codes: [''] }), /codes/)
  assert.throws(() => normalizeConfig({ matchPattern: '(' }), /matchPattern/)
})

test('statusFromMessage reads the leading provider status', () => {
  assert.equal(statusFromMessage(UPSTREAM_MESSAGE), 400)
  assert.equal(statusFromMessage('HTTP 502: bad gateway'), 502)
  assert.equal(statusFromMessage('stream ended before completion'), undefined)
})

test('isUpstream400 accepts the reported shape and rejects lookalikes', () => {
  const config = normalizeConfig(undefined)
  assert.equal(isUpstream400({ message: UPSTREAM_MESSAGE, code: 'INVALID_REQUEST' }, config), true)
  // Same text, wrong status: not the case this plugin covers.
  assert.equal(isUpstream400({ message: '422: Upstream error (request id: x)', code: 'INVALID_REQUEST' }, config), false)
  // Same status, different failure: not an upstream hiccup.
  assert.equal(isUpstream400({ message: '400: bad request: model does not exist', code: 'INVALID_REQUEST' }, config), false)
  // Structural status wins over the message text.
  assert.equal(
    isUpstream400({ message: 'Upstream error (request id: x)', code: 'INVALID_REQUEST', status: 400 }, config),
    true,
  )
  assert.equal(
    isUpstream400({ message: 'Upstream error (request id: x)', code: 'INVALID_REQUEST', status: 500 }, config),
    false,
  )
  // An adapter that drops the status keeps matching on the specific message.
  assert.equal(
    isUpstream400({ message: 'Upstream error (request id: x)', code: 'INVALID_REQUEST' }, config),
    true,
  )
  // An empty code filter disables code matching.
  const anyCode = normalizeConfig({ codes: [] })
  assert.equal(isUpstream400({ message: UPSTREAM_MESSAGE, code: 'SERVER' }, anyCode), true)
})

test('matches the target failure, waits, and decides to retry', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 25 })
  const started = Date.now()
  const { decision, delegated } = await dispatch(ctx, payload())
  const elapsed = Date.now() - started
  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(delegated, 0)
  assert.ok(elapsed >= 20, `waited at least the configured delay (${elapsed}ms)`)
  const [level, format, ...args] = ctx.logs.find((entry) => entry[0] === 'warn')
  assert.equal(level, 'warn')
  assert.match(format, /upstream 400 from provider/)
  assert.equal(args[0], 'yjs')
  assert.equal(args.at(-1), 25, 'logged delay matches the configured delayMs')
})

test('delegates unrelated failures downstream', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 1 })
  const { decision, delegated } = await dispatch(ctx, payload({
    failure: { message: '403: forbidden', code: 'AUTH' },
  }))
  assert.deepEqual(decision, { kind: 'downstream' })
  assert.equal(delegated, 1)
})

test('delegates the same message when the failure code is excluded', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 1, codes: ['RATE_LIMIT'] })
  const { decision, delegated } = await dispatch(ctx, payload())
  assert.deepEqual(decision, { kind: 'downstream' })
  assert.equal(delegated, 1)
})

test('stops at maxRetries and delegates the final failure', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 1, maxRetries: 2 })
  for (let i = 0; i < 2; i += 1) {
    const { decision } = await dispatch(ctx, payload())
    assert.deepEqual(decision, { kind: 'retry' })
  }
  const { decision, delegated } = await dispatch(ctx, payload())
  assert.deepEqual(decision, { kind: 'downstream' })
  assert.equal(delegated, 1)
  assert.match(ctx.logs.at(-1)[1], /retry budget exhausted/)
})

test('counts a fresh budget per step', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 1, maxRetries: 1 })
  assert.deepEqual((await dispatch(ctx, payload())).decision, { kind: 'retry' })
  assert.deepEqual((await dispatch(ctx, payload({ step: 2 }))).decision, { kind: 'retry' })
  assert.deepEqual((await dispatch(ctx, payload({ step: 2 }))).decision, { kind: 'downstream' })
})

test('an aborted turn wait returns nothing instead of retrying', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 200 })
  const controller = new AbortController()
  const pending = dispatch(ctx, payload({ signal: controller.signal }))
  setTimeout(() => controller.abort(), 10)
  const { decision, delegated } = await pending
  assert.equal(decision, undefined)
  assert.equal(delegated, 0)
})

test('config delay 0 retries immediately', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 0 })
  const { decision } = await dispatch(ctx, payload())
  assert.deepEqual(decision, { kind: 'retry' })
})

test('plugin disposal aborts an in-flight wait', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 5000 })
  const pending = dispatch(ctx, payload())
  // Let the listener reach its wait, then dispose the plugin.
  await new Promise((resolve) => setTimeout(resolve, 20))
  dispose(ctx)
  const { decision } = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ decision: 'timeout' }), 500)),
  ])
  assert.equal(decision, undefined, 'disposal makes a captured callback fail closed')
})

test('a disposed plugin stops listening', async () => {
  const ctx = fakeCtx()
  apply(ctx, { delayMs: 1 })
  dispose(ctx)
  assert.equal(ctx.listeners.has('agent/request-error'), false)
})
