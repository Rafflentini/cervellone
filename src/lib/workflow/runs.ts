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

export async function updateRunStatus(
  id: string,
  status: WorkflowRunStatus,
  // Campi noti opzionali: se passati, in caso di race (UPDATE su 0 righe) consentono
  // un INSERT minimale di recupero così la riga NON viene persa. Se assenti, su 0 righe
  // si logga solo un warning chiaro (vecchio comportamento: fallimento silenzioso).
  fallback?: { channel: WorkflowChannel; chatId?: string | null; conversationId?: string | null },
): Promise<void> {
  try {
    const now = new Date().toISOString()

    // 1) Proviamo l'UPDATE puro (caso normale: la riga esiste già).
    //    count: 'exact' ci dice quante righe sono state toccate.
    const { error, count } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .update({ status, updated_at: now }, { count: 'exact' })
      .eq('id', id)

    if (error) {
      console.error('[workflow runs] updateRunStatus failed:', error.message)
      return
    }

    // 2) Se l'UPDATE non ha toccato righe, la riga non esiste ancora:
    //    possibile race con createRun (markRunStep('running') prima dell'INSERT).
    if (count === 0) {
      if (fallback) {
        // Recupero idempotente: INSERT minimale con i campi NOT NULL noti.
        // onConflict: 'id' rende l'operazione safe anche se createRun arriva nel frattempo.
        const { error: upsertError } = await getSupabaseServer()
          .from('agent_workflow_runs')
          .upsert(
            {
              id,
              status,
              channel: fallback.channel,
              chat_id: fallback.chatId ?? null,
              conversation_id: fallback.conversationId ?? null,
              updated_at: now,
            },
            { onConflict: 'id' },
          )

        if (upsertError) {
          console.error('[workflow runs] updateRunStatus recovery upsert failed:', upsertError.message)
        } else {
          console.warn(`[workflow] run ${id} update toccò 0 righe — riga ricreata via upsert di recupero (race createRun)`)
        }
      } else {
        console.warn(`[workflow] run ${id} update toccò 0 righe — possibile race createRun`)
      }
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
