const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyReasoningEffortPolicy,
  isThinkingEnabled,
  resolveReasoningEffort,
} = require('../../src/utils/thinking-policy.js')

test('ignore policy strips reasoning_effort before thinking config', () => {
  const effectiveEffort = applyReasoningEffortPolicy('high', 'ignore')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, undefined, effectiveEffort)

  assert.equal(effectiveEffort, undefined)
  assert.equal(thinkingConfig.thinking_enabled, false)
})

test('passthrough policy preserves previous reasoning_effort behavior', () => {
  const effectiveEffort = applyReasoningEffortPolicy('high', 'passthrough')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, undefined, effectiveEffort)

  assert.equal(effectiveEffort, 'high')
  assert.equal(thinkingConfig.thinking_enabled, true)
  assert.equal(thinkingConfig.thinking_budget, 81920)
})

test('downgrade policy maps all reasoning_effort values to low budget', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const effectiveEffort = applyReasoningEffortPolicy(effort, 'downgrade')
    const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, undefined, effectiveEffort)

    assert.equal(effectiveEffort, 'low')
    assert.equal(thinkingConfig.thinking_enabled, true)
    assert.equal(thinkingConfig.thinking_budget, 4096)
  }
})

test('explicit enable_thinking is preserved when reasoning_effort is ignored', () => {
  const effectiveEffort = applyReasoningEffortPolicy('high', 'ignore')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', true, undefined, effectiveEffort)

  assert.equal(thinkingConfig.thinking_enabled, true)
})

test('thinking model suffix is preserved when reasoning_effort is ignored', () => {
  const effectiveEffort = applyReasoningEffortPolicy('high', 'ignore')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max-thinking', undefined, undefined, effectiveEffort)

  assert.equal(thinkingConfig.thinking_enabled, true)
})

test('explicit thinking_budget is preserved when reasoning_effort is ignored', () => {
  const effectiveEffort = applyReasoningEffortPolicy('high', 'ignore')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, 5000, effectiveEffort)

  assert.equal(thinkingConfig.thinking_enabled, false)
  assert.equal(thinkingConfig.thinking_budget, 5000)
})

test('top-level reasoning_effort takes precedence over reasoning object effort', () => {
  const effort = resolveReasoningEffort('medium', { effort: 'high' })

  assert.equal(effort, 'medium')
})

test('reasoning object effort is used when top-level reasoning_effort is absent', () => {
  const effort = resolveReasoningEffort(undefined, { effort: 'high' })
  const effectiveEffort = applyReasoningEffortPolicy(effort, 'passthrough')
  const thinkingConfig = isThinkingEnabled('qwen3.7-plus', undefined, undefined, effectiveEffort)

  assert.equal(effort, 'high')
  assert.equal(thinkingConfig.thinking_enabled, true)
  assert.equal(thinkingConfig.thinking_budget, 81920)
})

test('reasoning string is used when top-level reasoning_effort is absent', () => {
  const effort = resolveReasoningEffort(undefined, 'high')
  const effectiveEffort = applyReasoningEffortPolicy(effort, 'passthrough')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, undefined, effectiveEffort)

  assert.equal(effort, 'high')
  assert.equal(thinkingConfig.thinking_enabled, true)
  assert.equal(thinkingConfig.thinking_budget, 81920)
})

test('blank reasoning string does not enable thinking', () => {
  const effort = resolveReasoningEffort(undefined, '   ')
  const thinkingConfig = isThinkingEnabled('qwen3.7-max', undefined, undefined, effort)

  assert.equal(effort, undefined)
  assert.equal(thinkingConfig.thinking_enabled, false)
})

test('blank top-level reasoning_effort falls back to reasoning object effort', () => {
  const effort = resolveReasoningEffort('   ', { effort: 'medium' })

  assert.equal(effort, 'medium')
})

test('invalid reasoning object does not enable thinking', () => {
  for (const reasoning of [undefined, null, [], {}, { effort: '' }]) {
    const effort = resolveReasoningEffort(undefined, reasoning)
    const thinkingConfig = isThinkingEnabled('qwen3.7-plus', undefined, undefined, effort)

    assert.equal(effort, undefined)
    assert.equal(thinkingConfig.thinking_enabled, false)
  }
})

test('ignore policy still strips reasoning object effort', () => {
  const effort = resolveReasoningEffort(undefined, { effort: 'high' })
  const effectiveEffort = applyReasoningEffortPolicy(effort, 'ignore')
  const thinkingConfig = isThinkingEnabled('qwen3.7-plus', undefined, undefined, effectiveEffort)

  assert.equal(effort, 'high')
  assert.equal(effectiveEffort, undefined)
  assert.equal(thinkingConfig.thinking_enabled, false)
})
