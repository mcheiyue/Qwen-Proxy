const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createThinkingBlockStripper,
  sanitizeVisibleOutput,
} = require('../../src/utils/visible-output-sanitize.js')

function collect(chunks) {
  const stripper = createThinkingBlockStripper()
  let output = ''
  for (const chunk of chunks) {
    output += stripper.push(chunk)
  }
  output += stripper.flush()
  return output
}

test('thinking stripper removes complete think block in one chunk', () => {
  assert.equal(collect(['hello <think>hidden</think> world']), 'hello  world')
})

test('thinking stripper removes think tag split across chunks', () => {
  assert.equal(collect(['hello <thin', 'k>hidden</thin', 'k> world']), 'hello  world')
})

test('thinking stripper removes thinking tag split across chunks', () => {
  assert.equal(collect(['a <think', 'ing>hidden</think', 'ing> b']), 'a  b')
})

test('thinking stripper preserves content before and after hidden block', () => {
  assert.equal(collect(['before ', '<think>hidden', '</think>', ' after']), 'before  after')
})

test('thinking stripper removes multiple hidden blocks', () => {
  assert.equal(collect(['a<think>x</think>b<thinking>y</thinking>c']), 'abc')
})

test('thinking stripper drops unclosed hidden block on flush', () => {
  assert.equal(collect(['visible <think>hidden forever']), 'visible ')
})

test('thinking stripper passes through normal text without thinking tags', () => {
  assert.equal(collect(['hello ', 'world']), 'hello world')
})

test('thinking stripper cooperates with visible output sanitizer', () => {
  const stripped = collect(['answer <think>hidden</think> <|DSML|broken> done'])
  assert.equal(sanitizeVisibleOutput(stripped), 'answer   done')
})
