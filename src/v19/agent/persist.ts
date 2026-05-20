/**
 * Cervellone V19 — Container/run persistence (Supabase)
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 12
 *
 * NOTE: Le tabelle agent_runs / sub_agent_jobs sono definite in
 * supabase/migrations/2026-05-09-v19-foundation.sql (NON ancora applicate
 * in prod alla data di creazione di questo file).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AgentArtifact, Intent, SubagentKind } from './types'

let cached: SupabaseClient | null = null

function getSupabase(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase env mancanti per V19 persist (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

export async function loadContainerId(conversationId: string): Promise<string | null> {
  try {
    const sb = getSupabase()
    const { data } = await sb
      .from('agent_runs')
      .select('container_id')
      .eq('conversation_id', conversationId)
      .not('container_id', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data?.container_id ?? null
  } catch (err) {
    console.warn('[v19/persist] loadContainerId failed (table may not exist yet):', err)
    return null
  }
}

export async function saveContainerId(conversationId: string, containerId: string | null): Promise<void> {
  if (!containerId) return
  try {
    const sb = getSupabase()
    await sb.from('agent_runs').insert({
      conversation_id: conversationId,
      kind: 'orchestrator',
      intent: 'chat',
      status: 'completed',
      container_id: containerId,
    })
  } catch (err) {
    console.warn('[v19/persist] saveContainerId failed (table may not exist yet):', err)
  }
}

export async function startAgentRun(args: {
  conversationId: string
  parentRunId?: string | null
  kind: 'orchestrator' | SubagentKind
  intent: Intent
}): Promise<string | null> {
  try {
    const sb = getSupabase()
    const { data } = await sb
      .from('agent_runs')
      .insert({
        conversation_id: args.conversationId,
        parent_run_id: args.parentRunId ?? null,
        kind: args.kind,
        intent: args.intent,
        status: 'running',
      })
      .select('id')
      .maybeSingle()
    return data?.id ?? null
  } catch {
    return null
  }
}

export async function completeAgentRun(args: {
  runId: string | null
  status: 'completed' | 'failed' | 'paused'
  containerId?: string | null
  iterations?: number
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  summary?: string
  errorMessage?: string
}): Promise<void> {
  if (!args.runId) return
  try {
    const sb = getSupabase()
    await sb
      .from('agent_runs')
      .update({
        status: args.status,
        completed_at: new Date().toISOString(),
        container_id: args.containerId ?? null,
        iterations: args.iterations ?? 0,
        tokens_input: args.inputTokens ?? 0,
        tokens_output: args.outputTokens ?? 0,
        thinking_tokens: args.thinkingTokens ?? 0,
        summary: args.summary ?? null,
        error_message: args.errorMessage ?? null,
      })
      .eq('id', args.runId)
  } catch (err) {
    console.warn('[v19/persist] completeAgentRun failed:', err)
  }
}

export async function persistArtifact(
  conversationId: string,
  artifact: AgentArtifact,
): Promise<void> {
  try {
    const sb = getSupabase()
    await sb.from('document_renders').insert({
      conversation_id: conversationId,
      kind: artifact.mimeType?.includes('docx') ? 'docx'
          : artifact.mimeType?.includes('xlsx') ? 'xlsx'
          : artifact.mimeType?.includes('pdf') ? 'pdf'
          : 'other',
      semantic_input: { fileId: artifact.fileId, filename: artifact.filename, bytes: artifact.bytes },
      state: 'draft',
    })
  } catch (err) {
    console.warn('[v19/persist] persistArtifact failed:', err)
  }
}
