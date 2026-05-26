// Gestione conversazionale della policy di accesso in scrittura alle cartelle Drive.
// L'utente, da Telegram o web, può consentire/revocare l'accesso a una cartella.
// Ogni modifica richiede DOPPIA CONFERMA via slash command:
//   1) /accesso_ok_<id>   → prima conferma
//   2) /accesso_ok2_<id>  → conferma definitiva (applica)
//   /accesso_no_<id>      → annulla
// La recinzione vera (assertWriteAllowed) vive in drive.ts; qui si modifica solo la tabella.

import { supabase } from '@/lib/supabase'
import { findFoldersByName, invalidateDrivePolicyCache } from '@/lib/drive'

type ActionResult = { ok: boolean; message: string }

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type PendingRow = {
  id: string
  folder_id: string | null
  folder_name: string | null
  azione: 'consenti' | 'revoca'
  conferme: number
  stato: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function loadPending(id: string): Promise<PendingRow | null> {
  const { data, error } = await supabase
    .from('cervellone_drive_policy_pending')
    .select('id, folder_id, folder_name, azione, conferme, stato')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`Errore lettura richiesta accesso: ${error.message}`)
  return (data as PendingRow | null) ?? null
}

function pendingStatusMessage(stato: string): ActionResult {
  if (stato === 'applicata') return { ok: true, message: 'Questa richiesta di accesso è già stata applicata.' }
  if (stato === 'annullata') return { ok: true, message: 'Questa richiesta di accesso era stata annullata.' }
  return { ok: false, message: `Richiesta non gestibile: stato "${stato}".` }
}

// ── Proposta ─────────────────────────────────────────────────────────────────

export async function listDrivePolicy(): Promise<ActionResult> {
  const { data, error } = await supabase
    .from('cervellone_drive_policy')
    .select('folder_name, can_write')
    .eq('can_write', true)
    .order('folder_name', { ascending: true })
  if (error) return { ok: false, message: `Errore lettura policy: ${error.message}` }
  const rows = (data ?? []) as Array<{ folder_name: string }>
  if (rows.length === 0) {
    return { ok: true, message: 'Nessuna cartella autorizzata in scrittura. Cervellone al momento non può archiviare nulla.' }
  }
  const list = rows.map(r => `• ${r.folder_name}`).join('\n')
  return {
    ok: true,
    message: `Cartelle in cui Cervellone può scrivere (incluse le loro sottocartelle):\n${list}`,
  }
}

export async function proposeConsenti(folderQuery: string, folderId?: string, folderName?: string): Promise<ActionResult> {
  try {
    let id = folderId?.trim()
    let name = folderName?.trim()

    if (!id) {
      const matches = await findFoldersByName(folderQuery)
      if (matches.length === 0) {
        return { ok: false, message: `Nessuna cartella trovata su Drive con nome simile a "${folderQuery}".` }
      }
      if (matches.length > 1) {
        const list = matches.map(m => `• ${m.name} [ID: ${m.id}]`).join('\n')
        return {
          ok: false,
          message: `Ho trovato più cartelle. Dimmi quale indicando l'ID:\n${list}`,
        }
      }
      id = matches[0].id
      name = matches[0].name
    }
    if (!name) name = folderQuery

    const { data, error } = await supabase
      .from('cervellone_drive_policy_pending')
      .insert({ folder_query: folderQuery, folder_id: id, folder_name: name, azione: 'consenti', conferme: 0, stato: 'pending' })
      .select('id')
      .single()
    if (error) return { ok: false, message: `Errore creazione richiesta: ${error.message}` }

    return {
      ok: true,
      message:
        `🔐 Richiesta: DARE a Cervellone accesso in SCRITTURA a «${name}» (e tutte le sue sottocartelle).\n` +
        `Serve la doppia conferma.\n` +
        `1ª conferma → /accesso_ok_${data.id}\n` +
        `Per annullare → /accesso_no_${data.id}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function proposeRevoca(folderQuery: string, folderId?: string): Promise<ActionResult> {
  try {
    let id = folderId?.trim()
    let name = folderQuery

    if (!id) {
      // cerca tra le cartelle già in policy per nome
      const { data, error } = await supabase
        .from('cervellone_drive_policy')
        .select('folder_id, folder_name')
        .ilike('folder_name', `%${folderQuery}%`)
      if (error) return { ok: false, message: `Errore lettura policy: ${error.message}` }
      const rows = (data ?? []) as Array<{ folder_id: string; folder_name: string }>
      if (rows.length === 0) return { ok: false, message: `Nessuna cartella autorizzata corrisponde a "${folderQuery}".` }
      if (rows.length > 1) {
        const list = rows.map(r => `• ${r.folder_name} [ID: ${r.folder_id}]`).join('\n')
        return { ok: false, message: `Più corrispondenze, indica l'ID:\n${list}` }
      }
      id = rows[0].folder_id
      name = rows[0].folder_name
    }

    const { data, error } = await supabase
      .from('cervellone_drive_policy_pending')
      .insert({ folder_query: folderQuery, folder_id: id, folder_name: name, azione: 'revoca', conferme: 0, stato: 'pending' })
      .select('id')
      .single()
    if (error) return { ok: false, message: `Errore creazione richiesta: ${error.message}` }

    return {
      ok: true,
      message:
        `🔓 Richiesta: REVOCARE a Cervellone l'accesso in scrittura a «${name}».\n` +
        `Serve la doppia conferma.\n` +
        `1ª conferma → /accesso_ok_${data.id}\n` +
        `Per annullare → /accesso_no_${data.id}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ── Conferme ───────────────────────────────────────────────────────────────────

export async function confirmStep1(id: string): Promise<ActionResult> {
  try {
    const p = await loadPending(id)
    if (!p) return { ok: false, message: 'Richiesta di accesso non trovata.' }
    if (p.stato !== 'pending') return pendingStatusMessage(p.stato)
    if (p.conferme >= 1) {
      return { ok: true, message: `Prima conferma già data. Conferma DEFINITIVA → /accesso_ok2_${id}` }
    }
    const { data, error } = await supabase
      .from('cervellone_drive_policy_pending')
      .update({ conferme: 1 })
      .eq('id', id)
      .eq('stato', 'pending')
      .eq('conferme', 0)
      .select('id')
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) return { ok: false, message: 'Richiesta già elaborata da un altro canale.' }
    const azione = p.azione === 'consenti' ? 'DARE accesso a' : 'REVOCARE accesso a'
    return {
      ok: true,
      message:
        `✅ Prima conferma registrata (${azione} «${p.folder_name}»).\n` +
        `Conferma DEFINITIVA → /accesso_ok2_${id}\n` +
        `Annulla → /accesso_no_${id}`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function confirmStep2(id: string): Promise<ActionResult> {
  try {
    const p = await loadPending(id)
    if (!p) return { ok: false, message: 'Richiesta di accesso non trovata.' }
    if (p.stato !== 'pending') return pendingStatusMessage(p.stato)
    if (p.conferme < 1) return { ok: false, message: `Manca la prima conferma → /accesso_ok_${id}` }
    if (!p.folder_id) return { ok: false, message: 'Richiesta senza folder_id: impossibile applicare.' }

    // Applica la modifica alla policy
    if (p.azione === 'consenti') {
      const { error } = await supabase
        .from('cervellone_drive_policy')
        .upsert(
          { folder_id: p.folder_id, folder_name: p.folder_name ?? p.folder_id, can_write: true },
          { onConflict: 'folder_id' },
        )
      if (error) throw new Error(`Errore aggiornamento policy: ${error.message}`)
    } else {
      const { error } = await supabase
        .from('cervellone_drive_policy')
        .delete()
        .eq('folder_id', p.folder_id)
      if (error) throw new Error(`Errore revoca policy: ${error.message}`)
    }
    invalidateDrivePolicyCache()

    // Chiudi la richiesta (guard anti doppio-apply)
    const { data, error: closeErr } = await supabase
      .from('cervellone_drive_policy_pending')
      .update({ stato: 'applicata' })
      .eq('id', id)
      .eq('stato', 'pending')
      .select('id')
    if (closeErr) throw new Error(closeErr.message)
    if (!data || data.length === 0) return { ok: true, message: 'Richiesta già applicata da un altro canale.' }

    const verbo = p.azione === 'consenti'
      ? `Cervellone ora PUÒ scrivere in «${p.folder_name}» e nelle sue sottocartelle.`
      : `Accesso in scrittura a «${p.folder_name}» REVOCATO.`
    return { ok: true, message: `🔐 Fatto. ${verbo}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function cancelPending(id: string): Promise<ActionResult> {
  try {
    const p = await loadPending(id)
    if (!p) return { ok: false, message: 'Richiesta di accesso non trovata.' }
    if (p.stato !== 'pending') return pendingStatusMessage(p.stato)
    const { error } = await supabase
      .from('cervellone_drive_policy_pending')
      .update({ stato: 'annullata' })
      .eq('id', id)
      .eq('stato', 'pending')
    if (error) throw new Error(error.message)
    return { ok: true, message: 'Richiesta di accesso annullata.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const DRIVE_POLICY_TOOLS: ToolDefinition[] = [
  {
    name: 'gestisci_accesso_cartelle',
    description:
      'Gestisce QUALI cartelle Drive Cervellone può usare in SCRITTURA (archiviazione/spostamento file). ' +
      'Usa azione="elenca" per dire all\'utente quali cartelle sono autorizzate. ' +
      'Usa azione="consenti" quando l\'utente chiede di dare/abilitare accesso in scrittura a una cartella (passa folder_query col nome). ' +
      'Usa azione="revoca" quando chiede di togliere/bloccare l\'accesso. ' +
      'consenti/revoca NON applicano subito: avviano una richiesta con DOPPIA CONFERMA (l\'utente dovrà inviare /accesso_ok_<id> e poi /accesso_ok2_<id>). Riporta all\'utente il messaggio restituito così com\'è.',
    input_schema: {
      type: 'object',
      properties: {
        azione: { type: 'string', enum: ['elenca', 'consenti', 'revoca'], description: 'Operazione' },
        folder_query: { type: 'string', description: 'Nome (anche parziale) della cartella, per consenti/revoca' },
        folder_id: { type: 'string', description: 'OPZIONALE — ID Drive esatto della cartella, se noto' },
      },
      required: ['azione'],
    },
  },
]

export async function executeDrivePolicyTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'gestisci_accesso_cartelle') return null
  const azione = String(input.azione || '')
  const folderQuery = input.folder_query != null ? String(input.folder_query) : ''
  const folderId = input.folder_id != null ? String(input.folder_id) : undefined
  let res: ActionResult
  if (azione === 'elenca') {
    res = await listDrivePolicy()
  } else if (azione === 'consenti') {
    if (!folderQuery && !folderId) return JSON.stringify({ ok: false, message: 'Serve folder_query o folder_id.' })
    res = await proposeConsenti(folderQuery, folderId)
  } else if (azione === 'revoca') {
    if (!folderQuery && !folderId) return JSON.stringify({ ok: false, message: 'Serve folder_query o folder_id.' })
    res = await proposeRevoca(folderQuery, folderId)
  } else {
    return JSON.stringify({ ok: false, message: `azione non valida: ${azione}` })
  }
  return JSON.stringify(res)
}
