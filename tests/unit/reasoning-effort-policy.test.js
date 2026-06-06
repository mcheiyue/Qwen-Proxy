const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyReasoningEffortPolicy,
  isThinkingEnabled,
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
