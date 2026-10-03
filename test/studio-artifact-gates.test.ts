import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAudioGate, validateImageGate, runStudioGates } from '../src/studio-artifact-gates.js'

test('audio gate rejects silent audio below -45dB', () => {
  const result = validateAudioGate('test.wav', { mean_volume: -91 })
  assert.equal(result.passed, false)
  assert.equal(result.gate, 'audio')
  assert.match(result.reason!, /Volume too low/)
})

test('audio gate passes normal audio above -45dB', () => {
  const result = validateAudioGate('test.wav', { mean_volume: -21 })
  assert.equal(result.passed, true)
  assert.equal(result.gate, 'audio')
})

test('audio gate passes when no volume metadata provided', () => {
  const result = validateAudioGate('test.wav', {})
  assert.equal(result.passed, true)
})

test('image gate rejects images without alpha channel', () => {
  const result = validateImageGate('test.png', { alpha_channel: false })
  assert.equal(result.passed, false)
  assert.match(result.reason!, /alpha/)
})

test('image gate passes images with alpha channel', () => {
  const result = validateImageGate('test.png', { alpha_channel: true })
  assert.equal(result.passed, true)
})

test('runStudioGates dispatches correct gates by file extension', () => {
  const verdicts = runStudioGates(['test.wav', 'sprite.png', 'output.mp4'], { mean_volume: -21, alpha_channel: true })
  assert.equal(verdicts.length, 3)
  assert.equal(verdicts[0].gate, 'audio')
  assert.equal(verdicts[1].gate, 'image')
  assert.equal(verdicts[2].gate, 'render')
  assert.ok(verdicts.every(v => v.passed))
})

test('runStudioGates catches audio failure while passing others', () => {
  const verdicts = runStudioGates(['silent.wav', 'good.png'], { mean_volume: -91, alpha_channel: true })
  assert.equal(verdicts.length, 2)
  assert.equal(verdicts[0].passed, false)
  assert.equal(verdicts[0].gate, 'audio')
  assert.equal(verdicts[1].passed, true)
  assert.equal(verdicts[1].gate, 'image')
})
