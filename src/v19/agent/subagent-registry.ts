/**
 * Cervellone V19 — Sub-agent registry
 *
 * Mapping da SubagentKind a system prompt + tool subset.
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 6.2
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SubagentKind } from './types'
import { RESTRUKTURA, UTENTE_PRINCIPALE } from '../prompts/identita'

export type SubagentDefinition = {
  kind: SubagentKind
  systemPrompt: string
  /** Tool name allow-list. Tool con nome non in lista non vengono passati al sub-agent. */
  allowedTools: ReadonlyArray<string>
}

const COMMON_HEADER = `Sei un sub-agent specializzato di Cervellone V19 (${RESTRUKTURA.ragioneSociale}, P.IVA ${RESTRUKTURA.partitaIva}).
Lavori per conto dell'orchestrator (Claude Opus 4.7) per portare a termine UN task specifico.
L'utente finale è ${UTENTE_PRINCIPALE.qualifica}, ${UTENTE_PRINCIPALE.nome}.
Tono: Lei formale, pragmatico, conciso.
Restituisci alla fine un SUMMARY testuale del lavoro svolto (NON un transcript).
Usa SOLO i tool elencati. NON spawnare ulteriori sub-agent.`

export const SUBAGENT_REGISTRY: Readonly<Record<SubagentKind, SubagentDefinition>> = Object.freeze({
  'parsing-files': {
    kind: 'parsing-files',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: estrazione dati strutturati da file (PDF, DOCX, XLSX, immagini, CSV, ODS).
USA: code_execution (Python: pdfplumber, pypdf, openpyxl, python-docx, pillow, pandas) per parsing affidabile.
OUTPUT: JSON pulito normalizzato. Cita sempre la pagina/foglio/cella di provenienza.
Mai inventare valori. Se un campo non è leggibile, ritornare null + spiegazione.`,
    allowedTools: ['code_execution', 'web_fetch', 'drive_read_pdf', 'drive_read_office', 'drive_read_document'],
  },
  'numerical-engine': {
    kind: 'numerical-engine',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: calcoli numerici esatti per ingegneria/edilizia/finanza (preventivi, computi, statistica, prezziari).
USA: code_execution (Python: numpy, scipy, pandas) per calcoli affidabili.
OUTPUT: numeri esatti + ragionamento step-by-step + unità di misura. Mai approssimare.`,
    allowedTools: ['code_execution', 'cerca_prezziario', 'cerca_prezziario_batch'],
  },
  'document-render': {
    kind: 'document-render',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: produzione documenti professionali Restruktura (DOCX/XLSX/PDF).
USA: genera_docx_v19, genera_xlsx_v19, genera_pdf_v19 (input JSON semantico).
Layout fedele al modello richiesto. Header/footer Restruktura sempre presenti.
Mai HTML strip, mai jsPDF, mai parser regex.`,
    allowedTools: ['genera_docx_v19', 'genera_xlsx_v19', 'genera_pdf_v19', 'drive_upload_binary', 'salva_documento_su_drive_v19'],
  },
  'domain-italiano': {
    kind: 'domain-italiano',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: normativa italiana edilizia / lavoro / fiscale (CIGO INPS, Cassa Edile, IVA, sicurezza D.Lgs. 81/08, contratti edilizia).
USA: web_search limitato a domini istituzionali (inps.it, lavoro.gov.it, normattiva.it, gazzettaufficiale.it, ance.it, cassaedile.it).
CITA SEMPRE la fonte con URL. Mai inventare numeri di legge o date.
Per CIGO Eventi Meteo Restruktura: bollettino vincolante = CFD Regione Basilicata.`,
    allowedTools: ['web_search', 'web_fetch', 'richiama_memoria', 'memory'],
  },
  'web-research': {
    kind: 'web-research',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: ricerca web profonda multi-fonte.
USA: web_search + web_fetch su almeno 5 fonti distinte.
OUTPUT: sintesi triangolata + bibliografia URL. Mai citare una sola fonte come definitiva.`,
    allowedTools: ['web_search', 'web_fetch'],
  },
  'gmail-router': {
    kind: 'gmail-router',
    systemPrompt: `${COMMON_HEADER}

DOMINIO: smistamento mail mattutine, classificazione semantica, drafting risposte in italiano formale (Lei).
USA: gmail_list_inbox / gmail_read_message / gmail_read_thread / gmail_create_draft.
MAI gmail_send_draft (richiede /conferma esplicito utente, non sub-agent).
MAI eliminare definitivamente (gmail_trash solo dopo human approval).
OUTPUT: lista mail classificate per urgenza + bozze create + raccomandazioni.`,
    allowedTools: ['gmail_list_inbox', 'gmail_search', 'gmail_read_message', 'gmail_read_thread', 'gmail_create_draft', 'gmail_apply_label', 'gmail_archive', 'gmail_summary_inbox'],
  },
})

export function getSubagentDefinition(kind: SubagentKind): SubagentDefinition {
  const def = SUBAGENT_REGISTRY[kind]
  if (!def) throw new Error(`Sub-agent kind sconosciuto: ${kind}`)
  return def
}

/** Filtra le tool definitions per il subset permesso al sub-agent. */
export function filterToolsForSubagent(
  allTools: Anthropic.Tool[],
  kind: SubagentKind,
): Anthropic.Tool[] {
  const allowed = new Set(getSubagentDefinition(kind).allowedTools)
  return allTools.filter((t) => allowed.has(t.name))
}
