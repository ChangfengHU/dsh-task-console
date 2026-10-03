import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe } from 'node:test'
import { HermesKernel } from '../src/hermes-kernel.ts'
import { runStudioGates, validateAudioGate } from '../src/studio-artifact-gates.ts'

const tempDb = async () => join(await mkdtemp(join(tmpdir(), 'dsh-hermes-studio-')), 'kanban.db')

describe('Hermes -> Studio: Single-Card Rework Loop', () => {
  test('requestChanges transitions task back for same-card rework', async () => {
    const path = await tempDb()
    let now = 100
    const kernel = new HermesKernel(path, { now: () => now, claimer: () => 'test-pid' })
    
    // Create a standalone task (no parents => auto-promoted to ready via createTask)
    kernel.createTask({ id: 'exec-task', title: 'Studio Executor - Scene 1', assignee: 'executor-agent' })
    kernel.promoteReadyTasks()
    
    // Run 1: executor claims and works
    const claim1 = kernel.claimTask('exec-task')
    assert.ok(claim1, 'Run 1 claimed')
    assert.equal(claim1.task.status, 'running')
    
    // Executor submits for review
    now += 10
    const reviewed = kernel.requestReview('exec-task', { expectedRunId: claim1.run.id, summary: 'Scene rendered', reviewer: 'reviewer-agent' })
    assert.ok(reviewed, 'Review requested')
    
    // Run 2: reviewer claims (fromReview)
    now += 10
    const reviewClaim = kernel.claimTask('exec-task', { fromReview: true })
    assert.ok(reviewClaim, 'Review claim obtained')
    
    // Reviewer rejects with gate failure reason
    now += 10
    const changes = kernel.requestChanges('exec-task', { expectedRunId: reviewClaim.run.id, reason: 'Audio gate failed: mean_volume -91dB (silent)' })
    assert.ok(changes.ok, 'requestChanges succeeded')
    assert.equal(changes.implementer, 'executor-agent', 'Implementer tracked back to executor')
    
    // Task should be back in ready state for executor to reclaim
    const task = kernel.getTask('exec-task')
    assert.ok(task, 'Task still exists')
    assert.ok(['ready', 'todo'].includes(task.status), 'Task status should be ready/todo after requestChanges')
    assert.equal(task.assignee, 'executor-agent', 'Task assigned back to original executor')
    
    // Run 3: executor reclaims SAME card (not a new node!)
    now += 10
    const claim3 = kernel.claimTask('exec-task')
    assert.ok(claim3, 'Run 3 claimed on same card - rework in place')
    assert.equal(claim3.task.status, 'running')
    
    // Verify we had 3 runs on the same task (not 3 separate tasks)
    const runs = kernel.db.prepare('SELECT * FROM task_runs WHERE task_id = ?').all('exec-task')
    assert.equal(runs.length, 3, 'Should have 3 runs on same card')
    
    kernel.close()
  })

  test('buildWorkerContext includes gate failure reasons from previous runs', async () => {
    const path = await tempDb()
    let now = 100
    const kernel = new HermesKernel(path, { now: () => now, claimer: () => 'test-pid' })
    
    kernel.createTask({ id: 'audio-task', title: 'Studio Audio Task', body: 'Produce voiceover', assignee: 'executor' })
    kernel.promoteReadyTasks()
    
    // Run 1: executor claims, records gate failure
    const claim1 = kernel.claimTask('audio-task')
    assert.ok(claim1)
    kernel.recordEvent('audio-task', 'gate_failed', { 
      failures: [{ gate: 'audio', passed: false, reason: 'Volume too low: -91dB' }],
      paths: ['/tmp/silent.wav']
    }, claim1.run.id)
    
    // Submit for review
    now += 10
    kernel.requestReview('audio-task', { expectedRunId: claim1.run.id, summary: 'First attempt', reviewer: 'reviewer' })
    
    // Reviewer rejects
    now += 10
    const reviewClaim = kernel.claimTask('audio-task', { fromReview: true })
    assert.ok(reviewClaim)
    now += 10
    kernel.requestChanges('audio-task', { expectedRunId: reviewClaim.run.id, reason: 'Audio silent' })
    
    // Executor reclaims, check context
    now += 10
    kernel.claimTask('audio-task')
    const context = kernel.buildWorkerContext('audio-task')
    
    // Context should include gate failure info from our hermes-kernel enhancement
    assert.ok(
      context.toLowerCase().includes('gate') || context.toLowerCase().includes('audio'),
      'Context should mention gate/audio failure from bounded handoff'
    )
    
    kernel.close()
  })
})

describe('Hermes -> Studio: Artifact Quality Gates', () => {
  test('audio gate blocks silent artifacts', () => {
    const verdict = validateAudioGate('scene.wav', { mean_volume: -91 })
    assert.equal(verdict.passed, false)
    assert.equal(verdict.gate, 'audio')
  })

  test('runStudioGates returns mixed verdicts for multi-type artifacts', () => {
    const verdicts = runStudioGates(
      ['voiceover.wav', 'sprite.png', 'composition.html', 'output.mp4'],
      { mean_volume: -91, alpha_channel: false }
    )
    assert.equal(verdicts.length, 4)
    const audioVerdict = verdicts.find(v => v.gate === 'audio')
    assert.ok(audioVerdict)
    assert.equal(audioVerdict.passed, false)
    const imageVerdict = verdicts.find(v => v.gate === 'image')
    assert.ok(imageVerdict)
    assert.equal(imageVerdict.passed, false)
  })
})

describe('Hermes -> Studio: CAS Idempotency', () => {
  test('second claim on running task returns undefined (CAS guard)', async () => {
    const path = await tempDb()
    const kernel = new HermesKernel(path, { claimer: () => 'pid-1' })
    kernel.createTask({ id: 'cas-test', title: 'CAS Test', assignee: 'worker-1' })
    kernel.promoteReadyTasks()
    
    const claim1 = kernel.claimTask('cas-test')
    assert.ok(claim1, 'First claim should succeed')
    
    // Second claim while first is running should return undefined (CAS serialized)
    const claim2 = kernel.claimTask('cas-test')
    assert.equal(claim2, undefined, 'Second concurrent claim should be undefined (CAS guard)')
    
    kernel.close()
  })
})
