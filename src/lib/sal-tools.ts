import { calcolaSal, SalReconcileError, type SalCalcInput, type SalResult } from './sal-calc'
import { buildSalHtml, buildSalSheets, type SalMeta } from './sal-render'
import { getOrCreatePathFolders, searchFilesFullText, readPdfFromDrive, uploadBinaryToDrive } from './drive'
import { generatePdfFromHtml, generateXlsxFromData } from './pdf-generator'
import { getSupabaseServer } from './supabase-server'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF_MIME = 'application/pdf'
const CONTAB_FOLDER = '05_Contabilita Lavori'

interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown> }

export const SAL_TOOLS: ToolDefinition[] = [
  {
    name: 'sal_estrai_computo',
    description: 'Trova e legge il computo metrico nella cartella 05_Contabilita Lavori di una commessa, per poi generare un SAL. Ritorna il testo del computo (da cui estrarre le voci e il totale). Passa commessa_folder_id (ID Drive della cartella della commessa, ottenuto cercando la commessa).',
    input_schema: {
      type: 'object' as const,
      properties: {
        commessa_folder_id: { type: 'string', description: 'ID Drive della cartella della commessa' },
      },
      required: ['commessa_folder_id'],
    },
  },
  {
    name: 'sal_calcola',
    description: "Calcola un SAL (Stato Avanzamento Lavori) in modo deterministico e prepara i documenti (anteprima + doppia conferma). Prima raggruppa le voci del computo in gruppi coerenti insieme all'utente, leggi il Contratto d'Appalto per i parametri economici (IVA, ritenuta di garanzia, anticipazione), chiedi la % di avanzamento per ogni gruppo e l'importo del SAL precedente. NON calcolare tu i totali: li calcola questo tool. Se Σ importi gruppi non torna col totale del computo, il tool restituisce un errore.",
    input_schema: {
      type: 'object' as const,
      properties: {
        commessa: { type: 'string', description: 'Codice/nome commessa (es. "C2026-008 Cond. E. Fermi")' },
        commessa_folder_id: { type: 'string', description: 'ID Drive cartella commessa (per salvare il SAL)' },
        oggetto: { type: 'string', description: 'Oggetto dei lavori' },
        data: { type: 'string', description: 'Data del SAL (YYYY-MM-DD)' },
        numero_sal: { type: 'number', description: 'Numero progressivo del SAL' },
        totale_computo: { type: 'number', description: 'Importo totale del computo (imponibile), per la riconciliazione' },
        sal_precedente: { type: 'number', description: 'Importo maturato nei SAL precedenti (0 se è il primo)' },
        gruppi: {
          type: 'array',
          description: 'Gruppi di lavorazione con importo contrattuale (somma delle voci del gruppo) e % di avanzamento',
          items: {
            type: 'object',
            properties: {
              nome: { type: 'string' },
              importo_contrattuale: { type: 'number' },
              percentuale: { type: 'number', description: '0..100' },
            },
            required: ['nome', 'importo_contrattuale', 'percentuale'],
          },
        },
        params: {
          type: 'object',
          description: "Parametri economici letti dal Contratto d'Appalto",
          properties: {
            iva_perc: { type: 'number', description: 'Aliquota IVA (es. 10)' },
            ritenuta_garanzia_perc: { type: 'number', description: 'Ritenuta di garanzia % (0 se non prevista)' },
            anticipazione: { type: 'number', description: 'Importo anticipazione da recuperare (0 se assente)' },
            is_ultimo_sal: { type: 'boolean', description: "true se è il SAL finale (recupera l'anticipazione)" },
          },
          required: ['iva_perc', 'ritenuta_garanzia_perc', 'anticipazione', 'is_ultimo_sal'],
        },
      },
      required: ['commessa', 'commessa_folder_id', 'oggetto', 'data', 'numero_sal', 'totale_computo', 'sal_precedente', 'gruppi', 'params'],
    },
  },
]

const eur = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

interface SalPayload { result: SalResult; meta: SalMeta; commessa_folder_id: string }

export async function executeSalTool(name: string, input: Record<string, unknown>, _conversationId?: string): Promise<string | null> {
  if (name === 'sal_estrai_computo') {
    const folderId = input.commessa_folder_id as string
    const contabId = await getOrCreatePathFolders(folderId, [CONTAB_FOLDER])
    const lista = await searchFilesFullText('computo', contabId)
    const m = lista.match(/\[ID:\s*([^\]]+)\]/)
    if (!m) return `Nessun computo trovato in ${CONTAB_FOLDER}. File presenti:\n${lista}`
    const testo = await readPdfFromDrive(m[1].trim())
    return `Computo trovato. Estrai da qui le voci (codice, descrizione, quantità, prezzo, importo) e il TOTALE, poi raggruppa in gruppi coerenti:\n\n${testo}`
  }

  if (name === 'sal_calcola') {
    const calcInput: SalCalcInput = {
      numero_sal: input.numero_sal as number,
      totale_computo: input.totale_computo as number,
      gruppi: input.gruppi as SalCalcInput['gruppi'],
      sal_precedente: input.sal_precedente as number,
      params: input.params as SalCalcInput['params'],
    }
    let result: SalResult
    try {
      result = calcolaSal(calcInput)
    } catch (err) {
      if (err instanceof SalReconcileError) return `⚠️ ${err.message}`
      throw err
    }
    const meta: SalMeta = {
      commessa: input.commessa as string,
      oggetto: input.oggetto as string,
      data: input.data as string,
      numero_sal: input.numero_sal as number,
    }
    const descrizione =
      `SAL n° ${result.numero_sal} — ${meta.commessa}\n` +
      `Maturato nel periodo: € ${eur(result.maturato_nel_periodo)} — Totale certificato: € ${eur(result.totale_certificato)}`
    const payload: SalPayload = { result, meta, commessa_folder_id: input.commessa_folder_id as string }
    const { data, error } = await getSupabaseServer()
      .from('cervellone_sal_pending')
      .insert({ payload, descrizione, stato: 'in_attesa', conferme: 0 })
      .select('id')
      .single()
    if (error || !data) return `Errore salvataggio SAL pending: ${error?.message ?? 'sconosciuto'}`

    const righe = result.gruppi.map(g => `• ${g.nome}: ${g.percentuale}% → € ${eur(g.maturato_a_oggi)}`).join('\n')
    return (
      `📊 *SAL n° ${result.numero_sal}* — ${meta.commessa}\n\n${righe}\n\n` +
      `Totale maturato a oggi: € ${eur(result.totale_maturato_a_oggi)}\n` +
      `− SAL precedente: € ${eur(result.sal_precedente)}\n` +
      `= Maturato nel periodo: € ${eur(result.maturato_nel_periodo)}\n` +
      (result.ritenuta_periodo ? `− Ritenuta garanzia: € ${eur(result.ritenuta_periodo)}\n` : '') +
      (result.recupero_anticipazione ? `− Recupero anticipazione: € ${eur(result.recupero_anticipazione)}\n` : '') +
      `Imponibile: € ${eur(result.imponibile_certificato)} + IVA € ${eur(result.iva)} = *€ ${eur(result.totale_certificato)}*\n\n` +
      `Per salvare in ${CONTAB_FOLDER}: /sal_ok_${data.id}\nPer annullare: /sal_no_${data.id}`
    )
  }

  return null
}

export async function confirmSalStep1(id: string): Promise<string> {
  const sb = getSupabaseServer()
  const { data } = await sb.from('cervellone_sal_pending')
    .update({ conferme: 1, updated_at: new Date().toISOString() })
    .eq('id', id).eq('stato', 'in_attesa').eq('conferme', 0)
    .select('id')
  if (!data || data.length === 0) return 'SAL non trovato o già confermato/annullato.'
  return `Confermi il salvataggio del SAL? Conferma definitiva con /sal_ok2_${id} (oppure /sal_no_${id} per annullare).`
}

export async function cancelSal(id: string): Promise<string> {
  const sb = getSupabaseServer()
  const { data } = await sb.from('cervellone_sal_pending')
    .update({ stato: 'annullato', updated_at: new Date().toISOString() })
    .eq('id', id).neq('stato', 'creato')
    .select('id')
  if (!data || data.length === 0) return 'SAL non trovato o già creato.'
  return 'SAL annullato.'
}

export async function confirmSalStep2(id: string): Promise<string> {
  const sb = getSupabaseServer()
  const { data: claimed } = await sb.from('cervellone_sal_pending')
    .update({ conferme: 2, updated_at: new Date().toISOString() })
    .eq('id', id).eq('stato', 'in_attesa').eq('conferme', 1)
    .select('payload')
  if (!claimed || claimed.length === 0) return 'SAL non pronto (serve prima /sal_ok_...) o già creato/annullato.'

  const payload = claimed[0].payload as SalPayload
  try {
    const xlsxBuf = await generateXlsxFromData(buildSalSheets(payload.result, payload.meta), `SAL_${payload.result.numero_sal}`)
    const pdfBuf = await generatePdfFromHtml(buildSalHtml(payload.result, payload.meta), `SAL n${payload.result.numero_sal}`)
    const contabId = await getOrCreatePathFolders(payload.commessa_folder_id, [CONTAB_FOLDER])
    const base = `SAL_${payload.result.numero_sal}_${payload.meta.data}`
    const xlsx = await uploadBinaryToDrive(xlsxBuf, `${base}.xlsx`, XLSX_MIME, contabId)
    const pdf = await uploadBinaryToDrive(pdfBuf, `${base}.pdf`, PDF_MIME, contabId)
    await sb.from('cervellone_sal_pending').update({ stato: 'creato', updated_at: new Date().toISOString() }).eq('id', id)
    return `✅ SAL n° ${payload.result.numero_sal} salvato in ${CONTAB_FOLDER}:\n📊 ${xlsx.webViewLink}\n📄 ${pdf.webViewLink}`
  } catch (err) {
    await sb.from('cervellone_sal_pending').update({ conferme: 1, updated_at: new Date().toISOString() }).eq('id', id)
    return `Errore in generazione/salvataggio SAL: ${err instanceof Error ? err.message : String(err)}. Riprova con /sal_ok2_${id}.`
  }
}
