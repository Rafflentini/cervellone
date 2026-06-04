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
        // Recupero NON-clobbering: tentiamo un INSERT minimale con i campi NOT NULL noti.
        // Se la riga è apparsa nel frattempo via createRun (race), l'INSERT viola la PK
        // ('23505' / 'duplicate key'): in quel caso NON facciamo upsert (sovrascriverebbe
        // channel/chat_id/conversation_id già scritti da createRun), ma un semplice UPDATE
        // del solo status — così lo stato viene impostato senza toccare i campi immutabili.
        const { error: insertError } = await getSupabaseServer()
          .from('agent_workflow_runs')
          .insert({
            id,
            status,
            channel: fallback.channel,
            chat_id: fallback.chatId ?? null,
            conversation_id: fallback.conversationId ?? null,
            updated_at: now,
          })

        if (!insertError) {
          console.warn(`[workflow] run ${id} update toccò 0 righe — riga ricreata via INSERT di recupero (race createRun)`)
        } else {
          const isDuplicate =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (insertError as any).code === '23505' ||
            /duplicate key/i.test(insertError.message)

          if (isDuplicate) {
            // La riga è comparsa via createRun tra l'UPDATE (count 0) e l'INSERT:
            // aggiorniamo SOLO lo status, senza clobberare i campi immutabili.
            const { error: statusError } = await getSupabaseServer()
              .from('agent_workflow_runs')
              .update({ status, updated_at: now })
              .eq('id', id)

            if (statusError) {
              console.error('[workflow runs] updateRunStatus recovery status update failed:', statusError.message)
            } else {
              console.warn(`[workflow] run ${id} update toccò 0 righe — riga creata da createRun nel frattempo, aggiornato solo status (no clobber)`)
            }
          } else {
            console.error('[workflow runs] updateRunStatus recovery insert failed:', insertError.message)
          }
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
