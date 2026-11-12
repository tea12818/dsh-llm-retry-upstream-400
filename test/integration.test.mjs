/**
 * Integration test against the real Cordis runtime: mount the plugin on a live
 * Context, dispatch the `agent/request-error` waterfall the way
 * `@deepseek-ai/dsh-agent-loop` does, and check the retry decision and fiber
 * failure behavior.
 *
 * The Cordis copy under `ref/node_modules` is extracted from the installed
 * DeepSeek Harness package for offline verification; it is test-only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const cordisUrl = new URL('../ref/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url)
const { Context } = await import(cordisUrl.href)

const pluginUrl = new URL('../lib/index.js', import.meta.url)
const plugin = await import(pluginUrl.href)

const UPSTREAM = '400: {"message":"Upstream error (request id: 20261105-deadbeef)"}'

function payload(overrides = {}) {
  return {
    agent: { id: 'agent-1', session: { id: 'session-1' } },
    turn: 3,
    step: 2,
    provider: 'yjs',
    failure: { message: UPSTREAM, code: 'INVALID_REQUEST' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('mounts on a real Cordis context and retries the upstream 400', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { delayMs: 20 })
  await fiber

  const started = Date.now()
  let delegated = 0
  const decision = await ctx.waterfall(ctx, 'agent/request-error', payload(), () => {
    delegated += 1
    return { kind: 'downstream' }
  })

  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(delegated, 0)
  assert.ok(Date.now() - started >= 15, 'waited before retrying')

  await fiber.dispose()
})

test('delegates a non-matching failure to the next listener', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { delayMs: 1 })
  await fiber

  const decision = await ctx.waterfall(ctx, 'agent/request-error', payload({
    failure: { message: '429: rate limited', code: 'RATE_LIMIT' },
  }), () => ({ kind: 'downstream' }))

  assert.deepEqual(decision, { kind: 'downstream' })
  await fiber.dispose()
})

test('a later listener still sees the failure after this plugin delegates', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { delayMs: 1 })
  await fiber
  ctx.on('agent/request-error', (input, next) => {
    if (!/upstream error/i.test(input.failure.message)) return next()
    return { kind: 'retry-from-second-listener' }
  })

  const decision = await ctx.waterfall(ctx, 'agent/request-error', payload(), () => ({ kind: 'downstream' }))
  assert.deepEqual(decision, { kind: 'retry' }, 'this plugin handles it first')

  const other = await ctx.waterfall(ctx, 'agent/request-error', payload({
    failure: { message: '500: internal error', code: 'SERVER' },
  }), () => ({ kind: 'downstream' }))
  assert.deepEqual(other, { kind: 'downstream' })
  await fiber.dispose()
})

test('disposal aborts an in-flight wait', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { delayMs: 10_000 })
  await fiber

  const pending = ctx.waterfall(ctx, 'agent/request-error', payload(), () => undefined)
  await new Promise((resolve) => setTimeout(resolve, 25))
  await fiber.dispose()

  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
  ])
  assert.equal(result, undefined, 'an aborted wait does not decide to retry')
})

test('an invalid config fails the fiber instead of mounting silently', async () => {
  const ctx = new Context()
  let failed = false
  try {
    await ctx.plugin(plugin, { delayMs: -5 })
  } catch {
    failed = true
  }
  assert.equal(failed, true)
})

test('a disabled plugin registers no listener', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { enabled: false })
  await fiber
  const decision = await ctx.waterfall(ctx, 'agent/request-error', payload(), () => ({ kind: 'downstream' }))
  assert.deepEqual(decision, { kind: 'downstream' })
  await fiber.dispose()
})
