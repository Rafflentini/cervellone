import type Anthropic from '@anthropic-ai/sdk'

import { supabase } from '@/lib/supabase'
import { classifyTask } from '@/lib/task-classifier'

export async function shouldUseDurable(
  userText: string,
  fileBlocks: Anthropic.ContentBlockParam[]
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'durable_workflows_enabled')
    .maybeSingle()

  if (error) {
    console.error('[workflow durable] durable_workflows_enabled read failed:', error.message)
    return false
  }

  const enabled = String(data?.value ?? '').replace(/"/g, '') === 'true'
  if (!enabled) return false

  return classifyTask(userText, fileBlocks) === true
}
