import type { CompactionReplacement, CompactionResult } from '@/agent/context/compaction'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import type { CompactionReason, ContextCheckpoint } from '@/agent/context/types'
import type { AgentMessage, ModelRef, ModelRequest } from '@/agent/core/types'
import type { BranchSummarySource } from '@/agent/session/branch'

export interface BeforeCompactionHookContext {
  request: ModelRequest
  reason: CompactionReason
  checkpoint: ContextCheckpoint | null
  summaryInstructions?: SummaryInstructionOptions
  signal: AbortSignal
}

export interface BeforeCompactionHookResult {
  cancel?: boolean
  replacement?: CompactionReplacement
}

export interface AfterCompactionHookContext extends BeforeCompactionHookContext {
  result: CompactionResult
  replaced: boolean
}

export type BeforeCompactionHook = (
  context: BeforeCompactionHookContext,
) => BeforeCompactionHookResult | undefined | Promise<BeforeCompactionHookResult | undefined>

export type AfterCompactionHook = (
  context: AfterCompactionHookContext,
) => void | Promise<void>

export interface BeforeBranchSummaryHookContext {
  sessionId: string
  messages: AgentMessage[]
  model: ModelRef
  summaryInstructions?: SummaryInstructionOptions
  signal: AbortSignal
}

export interface BeforeBranchSummaryHookResult extends SummaryInstructionOptions {
  cancel?: boolean
  /** Narrative only. Axiom derives source boundaries and file facts. */
  replacement?: { content: string }
}

export interface AfterBranchSummaryHookContext extends BeforeBranchSummaryHookContext {
  result: BranchSummarySource
  replaced: boolean
}

export type BeforeBranchSummaryHook = (
  context: BeforeBranchSummaryHookContext,
) => BeforeBranchSummaryHookResult | undefined | Promise<BeforeBranchSummaryHookResult | undefined>

export type AfterBranchSummaryHook = (
  context: AfterBranchSummaryHookContext,
) => void | Promise<void>

export interface SummaryRuntimeHooks {
  beforeCompaction?: BeforeCompactionHook
  afterCompaction?: AfterCompactionHook
  beforeBranchSummary?: BeforeBranchSummaryHook
  afterBranchSummary?: AfterBranchSummaryHook
}

export const summaryHookCancelled = (operation: 'compaction' | 'branch-summary'): DOMException =>
  new DOMException(`${operation} cancelled by runtime hook`, 'AbortError')
