import { getSupabaseServer } from '@/lib/supabase-server'

export type WorkflowChannel = 'telegram' | 'web'
export type WorkflowRunStatus = 'running' | 'paused' | 'done' | 'error'

export type WorkflowRun = {
  id: string
  channel: WorkflowChannel
  chat_id: string | null
  conversation_id: string | null
  status: WorkflowRunStatus
}

export async function createRun(input: {
  id: string
  channel: WorkflowChannel
  chatId?: string | null
  conversationId?: string | null
}): Promise<void> {
  try {
    const { error } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .insert({
        id: input.id,
        channel: input.channel,
        chat_id: input.chatId ?? null,
        conversation_id: input.conversationId ?? null,
      })

    if (error) {
      console.error('[workflow runs] createRun failed:', error.message)
    }
  } catch (err) {
    console.error('[workflow runs] createRun unexpected error:', err instanceof Error ? err.message : String(err))
  }
}

export async function updateRunStatus(id: string, status: WorkflowRunStatus): Promise<void> {
  try {
    const { error } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      console.error('[workflow runs] updateRunStatus failed:', error.message)
    }
  } catch (err) {
    console.error('[workflow runs] updateRunStatus unexpected error:', err instanceof Error ? err.message : String(err))
  }
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  try {
    const { data, error } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .select('id, channel, chat_id, conversation_id, status')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      console.error('[workflow runs] getRun failed:', error.message)
      return null
    }

    return (data as WorkflowRun | null) ?? null
  } catch (err) {
    console.error('[workflow runs] getRun unexpected error:', err instanceof Error ? err.message : String(err))
    return null
  }
}
