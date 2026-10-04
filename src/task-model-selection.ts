import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** The route frozen for one Task worker, not the host's mutable default. */
export interface TaskModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

/** AgentOptions does not carry reasoningEffort; the scoped request seam does. */
export function taskAgentOptions(selection: TaskModelSelection): AgentOptions {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
  }
}

/**
 * Install before preset mounting and before the first assembly. The SDK snapshots
 * this detached selection during assembly and applies that same route/effort to
 * the prepared request. Omitted effort keeps the adapter's normal defaults;
 * maxTokens remains an AgentOption. Registrations belong only to agentCtx.
 */
export function installTaskModelSelection(agentCtx: Context, selection: TaskModelSelection): () => void {
  const ref: ModelSelectionRef = {
    current: Object.freeze({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
    }),
    assembled: undefined,
  }
  const dispose = installModelSelection(agentCtx, ref)
  let active = true
  return () => { if (active) { active = false; dispose() } }
}
