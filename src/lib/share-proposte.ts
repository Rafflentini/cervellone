import { getSupabaseServer } from './supabase-server'
import { signShareToken } from './doc-access'

const BASE_URL = process.env.APP_BASE_URL || 'https://cervellone-five.vercel.app'

export async function createShareProposal(
  documentId: string,
  giorni: number,
): Promise<string | { error: string } | null> {
  const g = Math.min(30, Math.max(1, Math.round(giorni || 7)))
  const supabase = getSupabaseServer()

  // Le estrazioni testuali delle foto sono memoria interna (PII): non sono condivisibili.
  const { data: docRow } = await supabase
    .from('documents')
    .select('type')
    .eq('id', documentId)
    .single()
  if (docRow && (docRow as { type: string }).type === 'image-extraction') {
    return { error: 'Questo elemento è memoria interna e non è condivisibile.' }
  }

  const { data, error } = await supabase
    .from('cervellone_share_proposte')
    .insert({ document_id: documentId, giorni: g, stato: 'in_attesa' })
    .select('id').single()
  if (error || !data) return null
  return (data as { id: string }).id
}

export async function confirmShareProposal(proposalId: string): Promise<string | null> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_share_proposte').select('*').eq('id', proposalId).single()
  if (error || !data) return null
  const p = data as { document_id: string; giorni: number; stato: string }
  if (p.stato !== 'in_attesa') return null
  const exp = Math.floor(Date.now() / 1000) + p.giorni * 86400
  const token = signShareToken(p.document_id, exp)
  await supabase.from('cervellone_share_proposte').update({ stato: 'confermata' }).eq('id', proposalId)
  return `${BASE_URL}/doc/${p.document_id}?t=${token}&exp=${exp}`
}
