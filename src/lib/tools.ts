/**
 * lib/tools.ts — Registry tool completo con tutti i fix
 * 
 * Fix applicati:
 * - PER-003: cerca_prezziario multi-risultato
 * - FUN-004: ricerca per codice_voce
 * - PER-004: cerca_prezziario_batch per preventivi grandi
 * - NEW: importa_da_url (Opzione B — scarica prezziario da URL)
 * - NEW: cerca_documenti (preventivi/relazioni passate)
 */

import { getSupabaseServer } from './supabase-server'
import type { ToolDefinition } from './tools/types'
import { DRIVE_TOOLS, executeDriveTool } from './drive'
import { GITHUB_TOOLS, executeGithubTool } from './github-tools'
import { WEATHER_TOOLS, executeWeatherTool } from './weather-tool'
import { SCADENZE_TOOLS, executeScadenzeTool } from './scadenze-tools'
import { LEGGI_ALLEGATO_TOOLS, executeLeggiAllegatoTool } from './scadenza-extract'
import { DRIVE_POLICY_TOOLS, executeDrivePolicyTool } from './drive-policy-actions'
import { FOTO_ARCHIVE_TOOLS, executeFotoArchiveTool } from './foto-archive-tools'
import { FIC_READ_TOOLS, executeFicTool } from './fatture-in-cloud'
import { MOVIMENTI_TOOLS, executeMovimentiTool } from './movimenti-extract'
import { RICONCILIAZIONE_TOOLS, executeRiconciliazioneTool } from './riconciliazione-tools'
import { PRIMA_NOTA_TOOLS, executePrimaNotaTool } from './prima-nota-tools'
import { FIC_WRITE_TOOLS, executeFicWriteTool } from './fic-write-tools'
import { SAL_TOOLS, executeSalTool } from './sal-tools'
import { STUDIO_TECNICO_TOOLS, executeStudioTecnico } from './tools/studio-tecnico'
import { CALENDAR_TOOLS, executeCalendarTool } from './calendar-tools'
import { MAIL_TOOL_DEFINITIONS } from '@/v19/tools/email'
import { DOCUMENT_TEMPLATE_TOOLS, executeDocumentTemplateTool } from './document-template-tools'
import { GMAIL_TOOLS, executeGmailWrapper, executeMailWrapper } from './tools/mail'
import { SELF_TOOLS, executeSelfTools } from './tools/self'


// ── IMAGE TOOLS (ri-aggancio pixel immagini caricate) ──

const IMAGE_TOOLS: ToolDefinition[] = [
  {
    name: 'rivedi_immagine',
    description:
      "Ri-aggancia e MOSTRA al modello i pixel REALI di un'immagine caricata in PRECEDENZA in questa conversazione (foto di cantiere, ricevute, allegati). Usalo quando devi ricontrollare visivamente un dettaglio di una foto già caricata (es. una cifra, una targa, una firma) e non basta il testo già estratto. Passa il drive_file_id che trovi nel blocco 'IMMAGINI/DOCUMENTI GIÀ CARICATI' del contesto (campo [drive: ...]); in alternativa il filename. Funziona SOLO su immagini caricate in questa chat.",
    input_schema: {
      type: 'object',
      properties: {
        drive_file_id: { type: 'string', description: "ID Google Drive dell'immagine (dal blocco immagini del contesto, campo [drive: ...])." },
        filename: { type: 'string', description: "Nome file dell'immagine, in alternativa al drive_file_id." },
      },
      required: [],
    },
  },
]

// ── DOCUMENT TOOLS (PDF + DOCX + XLSX) ──

const PDF_TOOLS: ToolDefinition[] = [
  {
    name: 'genera_pdf',
    description: "Genera un PDF binario da contenuto HTML/testo formattato. Output: file PDF salvato in cartella Drive specifica e link cliccabile. Usalo SEMPRE quando l'Ingegnere chiede \"PDF da stampare\" o \"documento per stampa\". NON dire mai \"PDF allegato\" senza aver invocato questo tool.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nome file PDF (senza estensione, max 100 char)' },
        html_content: { type: 'string', description: 'Contenuto HTML del documento (verrà convertito in PDF A4)' },
        folder_id: { type: 'string', description: 'OPZIONALE — folder Drive di destinazione. Se omesso, salva in /BOZZE_PDF/' },
      },
      required: ['title', 'html_content'],
    },
  },
  {
    name: 'genera_docx',
    description: "Genera un file Word .docx editabile da contenuto HTML semplice (h1/h2/h3/p). Output: file DOCX salvato su Drive + link. Usalo quando l'Ingegnere chiede 'Word', 'documento editabile', 'lettera', 'relazione modificabile', 'checklist', 'verbale'. Per CME/quantità/prezziari usa invece genera_xlsx (Excel è migliore per dati tabellari numerici).",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nome file DOCX (senza estensione, max 100 char)' },
        html_content: { type: 'string', description: 'Contenuto HTML semplice. h1/h2/h3 → headings Word, p/div/li → paragrafi. Niente tabelle complesse né CSS.' },
        folder_id: { type: 'string', description: 'OPZIONALE — folder Drive di destinazione. Default /BOZZE_PDF/' },
      },
      required: ['title', 'html_content'],
    },
  },
  {
    name: 'genera_xlsx',
    description: "Genera un file Excel .xlsx da dati strutturati (NON HTML). Output: file XLSX salvato su Drive + link. Usalo SEMPRE per CME, computi, registri quantità, SAL, prezziari, tabelle con dati numerici. Prima riga di ogni foglio è automaticamente formattata come header (grassetto bianco su blu Restruktura, freeze).",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nome file XLSX (senza estensione, max 100 char)' },
        sheets: {
          type: 'array',
          description: 'Array di fogli. Ogni foglio ha name (max 31 char) e rows (array di array — prima riga = header, righe successive = dati). Numeri come number JSON, NON come stringa.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nome foglio Excel (max 31 char)' },
              rows: {
                type: 'array',
                description: 'Righe della tabella. Prima riga = header (intestazioni colonne). Righe seguenti = dati. Tipo cella: string | number | null.',
                items: { type: 'array' },
              },
            },
            required: ['name', 'rows'],
          },
        },
        folder_id: { type: 'string', description: 'OPZIONALE — folder Drive di destinazione. Default /BOZZE_PDF/' },
      },
      required: ['title', 'sheets'],
    },
  },
]

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function executePdfTools(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name !== 'genera_pdf' && name !== 'genera_docx' && name !== 'genera_xlsx') return null

  try {
    const title = ((input.title as string) || 'Documento').slice(0, 100)
    const folderId = input.folder_id as string | undefined
    const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_')
    const { uploadBinaryToDrive } = await import('./drive')

    if (name === 'genera_pdf') {
      const htmlContent = input.html_content as string
      if (!htmlContent) return 'Errore: html_content è richiesto.'
      const { generatePdfFromHtml } = await import('./pdf-generator')
      const buffer = await generatePdfFromHtml(htmlContent, title)
      const fileName = `${safeTitle}.pdf`
      const { webViewLink } = await uploadBinaryToDrive(buffer, fileName, 'application/pdf', folderId)
      return `📄 **${fileName}** salvato su Drive.\n👉 ${webViewLink}`
    }

    if (name === 'genera_docx') {
      const htmlContent = input.html_content as string
      if (!htmlContent) return 'Errore: html_content è richiesto.'
      const { generateDocxFromHtml } = await import('./pdf-generator')
      const buffer = await generateDocxFromHtml(htmlContent, title)
      const fileName = `${safeTitle}.docx`
      const { webViewLink } = await uploadBinaryToDrive(buffer, fileName, DOCX_MIME, folderId)
      return `📝 **${fileName}** salvato su Drive.\n👉 ${webViewLink}`
    }

    // genera_xlsx
    const sheets = input.sheets as unknown
    if (!Array.isArray(sheets) || sheets.length === 0) {
      return 'Errore: sheets è richiesto e deve essere un array non vuoto.'
    }
    const { generateXlsxFromData } = await import('./pdf-generator')
    const buffer = await generateXlsxFromData(sheets as { name: string; rows: (string | number | null)[][] }[], title)
    const fileName = `${safeTitle}.xlsx`
    const { webViewLink } = await uploadBinaryToDrive(buffer, fileName, XLSX_MIME, folderId)
    return `📊 **${fileName}** salvato su Drive.\n👉 ${webViewLink}`
  } catch (err) {
    return `Errore ${name}: ${err instanceof Error ? err.message : err}`
  }
}


// ── EXECUTORS ──

async function executeImageTools(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  if (name !== 'rivedi_immagine') return null
  const out = (o: Record<string, unknown>) => JSON.stringify(o)
  try {
    const driveIdIn = typeof input.drive_file_id === 'string' ? input.drive_file_id.trim() : ''
    const filenameIn = typeof input.filename === 'string' ? input.filename.trim() : ''
    if (!driveIdIn && !filenameIn) return out({ ok: false, message: 'Specifica drive_file_id o filename.' })
    if (!conversationId) return out({ ok: false, message: 'Conversazione non disponibile.' })

    // SICUREZZA: ri-aggancia SOLO immagini di QUESTA conversazione (righe image-extraction).
    const supabase = getSupabaseServer()
    const { data } = await supabase
      .from('documents')
      .select('metadata')
      .eq('conversation_id', conversationId)
      .eq('type', 'image-extraction')
      .order('created_at', { ascending: false })
      .limit(20)

    let resolvedId = ''
    let resolvedName = filenameIn
    for (const row of (data ?? []) as Array<{ metadata?: unknown }>) {
      const meta = (row.metadata ?? {}) as { filenames?: unknown; drive_file_ids?: unknown }
      const ids = Array.isArray(meta.drive_file_ids) ? (meta.drive_file_ids as string[]) : []
      const names = Array.isArray(meta.filenames) ? (meta.filenames as string[]) : []
      if (driveIdIn && ids.includes(driveIdIn)) {
        resolvedId = driveIdIn
        const i = ids.indexOf(driveIdIn)
        if (names[i]) resolvedName = names[i]
        break
      }
      if (!driveIdIn && filenameIn) {
        const i = names.indexOf(filenameIn)
        if (i >= 0 && ids[i]) { resolvedId = ids[i]; resolvedName = filenameIn; break }
      }
    }
    if (!resolvedId) {
      return out({ ok: false, message: `Non trovo "${driveIdIn || filenameIn}" tra le immagini caricate in questa chat. Se serve, chiedi all'utente di ricaricarla.` })
    }

    const { downloadFileBase64 } = await import('./drive')
    const { base64, mimeType, name: fileName } = await downloadFileBase64(resolvedId)
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if (!supported.includes(mimeType)) {
      return out({ ok: false, message: `Il file "${fileName}" non è un'immagine ri-agganciabile (${mimeType}). Supportati: JPG, PNG, GIF, WEBP.` })
    }
    // Limite API immagine (~5MB base64): rifiuta pulito invece di errore API.
    if (base64.length > 4_500_000) {
      return out({ ok: false, message: `Immagine troppo grande da ri-agganciare (~${Math.round(base64.length / 1_000_000)}MB).` })
    }
    return out({ ok: true, base64, mimeType, filename: resolvedName || fileName })
  } catch (err) {
    return out({ ok: false, message: `Errore nel recupero immagine: ${err instanceof Error ? err.message : String(err)}` })
  }
}


// ── Registry ──

// FIX W1.3: wrapper per DRIVE_TOOLS che combacia signature con altri executor.
// Ritorna null se il tool non è un drive_*/sheets_*, altrimenti delega a executeDriveTool.
async function executeDriveWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (
    !name.startsWith('drive_') &&
    !name.startsWith('sheets_') &&
    name !== 'salva_documento_su_drive' &&
    name !== 'archivia_documento'
  ) return null
  // executeDriveTool aspetta Record<string, string>; serializzo se necessario.
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeDriveTool(name, stringInput)
}

// Self-healing 2026-05-04: wrapper per i tool GitHub + Vercel deploy status.
async function executeGithubWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'github_read_file' && name !== 'github_propose_fix' && name !== 'vercel_deploy_status' && name !== 'github_merge_pr') return null
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeGithubTool(name, stringInput)
}

// 2026-05-05: wrapper per il tool meteo (Open-Meteo, no API key).
async function executeWeatherWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'weather_now') return null
  const stringInput: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    stringInput[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return executeWeatherTool(name, stringInput)
}

// 2026-05-25: wrapper per scadenzario documenti/mezzi/cantieri.
async function executeScadenzeWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  return executeScadenzeTool(name, input)
}

// 2026-05-07 Memoria persistente cross-sessione (sub-progetto B): 4 tool
const MEMORIA_TOOLS: ToolDefinition[] = [
  {
    name: 'ricorda',
    description: 'Salva in memoria persistente una decisione, contesto o fatto importante. Usare quando l\'Ingegnere dice esplicitamente di voler ricordare qualcosa, o quando si prende una decisione che dovrà essere recuperata in sessioni future. NON usare per fatti generici già presenti nella conversazione corrente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        testo: { type: 'string', description: 'Testo da salvare in memoria. Essere precisi e auto-contenuti: includere chi, cosa, quando se rilevante.' },
        tag: { type: 'string', description: 'Etichetta opzionale (es: "cliente", "scadenza", "cantiere", "decisione").' },
      },
      required: ['testo'],
    },
  },
  {
    name: 'richiama_memoria',
    description: 'Cerca nella memoria persistente (3 livelli: esplicita → summary giornaliero → entità). Usare quando l\'Ingegnere chiede di ricordare qualcosa, o quando serve contesto storico.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Testo della ricerca. Usare parole chiave significative.' },
        tipo_filtro: { type: 'string', enum: ['esplicita', 'summary', 'entita', 'tutto'], description: 'Filtra il livello di ricerca. Default "tutto".' },
        limit: { type: 'number', description: 'Numero massimo risultati per livello. Default 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'riepilogo_giorno',
    description: 'Recupera il summary di una giornata specifica. Usare per query temporali esplicite: "cosa abbiamo fatto ieri", "lunedì scorso", "il 5 maggio".',
    input_schema: {
      type: 'object' as const,
      properties: {
        data: { type: 'string', description: 'Data: "oggi", "ieri", "YYYY-MM-DD", "lunedi-scorso", "martedi-scorso", "mercoledi-scorso", "giovedi-scorso", "venerdi-scorso".' },
      },
      required: ['data'],
    },
  },
  {
    name: 'lista_entita',
    description: 'Elenca clienti/cantieri/fornitori conosciuti estratti dalle conversazioni. Usare quando l\'Ingegnere chiede "quali clienti abbiamo" o simili.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tipo: { type: 'string', enum: ['cliente', 'cantiere', 'fornitore'], description: 'Filtra per tipo. Se omesso, ritorna tutti.' },
        limit: { type: 'number', description: 'Numero massimo entità ritornate. Default 20.' },
      },
      required: [],
    },
  },
]

async function executeMemoriaWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!['ricorda', 'richiama_memoria', 'riepilogo_giorno', 'lista_entita'].includes(name)) return null
  try {
    const mod = await import('./memoria-tools')
    let result: unknown
    switch (name) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case 'ricorda': result = await mod.ricorda(input as any); break
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case 'richiama_memoria': result = await mod.richiama_memoria(input as any); break
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case 'riepilogo_giorno': result = await mod.riepilogo_giorno(input as any); break
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      case 'lista_entita': result = await mod.lista_entita(input as any); break
    }
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  } catch (err) {
    return `Errore memoria: ${err instanceof Error ? err.message : err}`
  }
}

// 2026-06-04 FASE 1 Memoria procedurale: tool per registrare apprendimenti permanenti
// su COME si fa un certo tipo di documento (dopo correzione + conferma dell'Ingegnere).
// 2026-06-06 GAP 2: aggiunto crea_procedura per tipi di documento NUOVI (non ancora noti).
const WORKING_MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: 'registra_apprendimento',
    description: "Registra in modo PERMANENTE un apprendimento su COME si fa un certo tipo di documento, dopo che l'Ingegnere ti ha corretto e ha confermato. Es: per i POS i nomi RSPP/medico stanno nel DVR. Chiamalo SOLO dopo conferma esplicita dell'utente.",
    input_schema: {
      type: 'object' as const,
      properties: {
        task_type: {
          type: 'string',
          description: 'Tipo di documento a cui si riferisce l\'apprendimento (es. "pos", "cigo", "ddt"). Deve essere una procedura GIA\' esistente.',
        },
        lesson: {
          type: 'string',
          description: 'L\'apprendimento da memorizzare, conciso e auto-contenuto (es: "I nomi RSPP, medico competente e RLS vanno letti dal DVR Restruktura su Drive, non chiesti all\'utente").',
        },
      },
      required: ['task_type', 'lesson'],
    },
  },
  {
    name: 'crea_procedura',
    description: "Crea una procedura NUOVA per un tipo di documento/lavoro che Cervellone non conosce ancora. Usalo quando l'Ingegnere ti spiega come si fa un lavoro nuovo e CONFERMA di volerlo salvare. Per aggiungere lezioni a procedure esistenti usa registra_apprendimento.",
    input_schema: {
      type: 'object' as const,
      properties: {
        taskType: {
          type: 'string',
          description: 'Slug minuscolo del tipo (es. "cigo", "ddt", "durc"). Solo lettere minuscole, cifre, trattini e underscore.',
        },
        title: {
          type: 'string',
          description: 'Titolo esteso della procedura (es. "CIGO — Cassa Integrazione Guadagni Ordinaria").',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Alias e varianti per il riconoscimento automatico (es. ["cigo", "cassa integrazione", "ammortizzatore sociale"]).',
        },
        checklist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Passi obbligatori da seguire per questo tipo di documento (possono crescere con registra_apprendimento).',
        },
        outputSpec: {
          type: 'string',
          description: 'Descrizione del formato/output atteso (es. "Modulo INPS SR41 compilato + lettera di autorizzazione").',
        },
        saveLocation: {
          type: 'string',
          description: 'Dove salvare il documento su Drive (es. "cantiere/05_Amministrativo/CIGO").',
        },
      },
      required: ['taskType', 'title'],
    },
  },
]

async function executeWorkingMemoryWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name === 'registra_apprendimento') {
    try {
      const taskType = String(input.task_type || '').trim()
      const lesson = String(input.lesson || '').trim()
      if (!taskType || !lesson) {
        return 'Errore: task_type e lesson sono entrambi richiesti.'
      }
      const { addLesson } = await import('./working-memory')
      const ok = await addLesson(taskType, lesson)
      if (ok) {
        return 'Apprendimento registrato per i "' + taskType + '". Da ora lo seguiro come regola: "' + lesson + '"'
      }
      return 'Non sono riuscito a registrare l\'apprendimento per "' + taskType + '" (procedura non trovata o errore di salvataggio). L\'Ingegnere puo verificare la procedura.'
    } catch (err) {
      return 'Errore registra_apprendimento: ' + (err instanceof Error ? err.message : String(err))
    }
  }

  if (name === 'crea_procedura') {
    try {
      const taskType = String(input.taskType || '').trim()
      const title = String(input.title || '').trim()
      if (!taskType || !title) {
        return 'Errore: taskType e title sono entrambi richiesti.'
      }
      const keywords = Array.isArray(input.keywords)
        ? (input.keywords as unknown[]).map((k) => String(k))
        : []
      const checklist = Array.isArray(input.checklist)
        ? (input.checklist as unknown[]).map((c) => String(c))
        : []
      const outputSpec = input.outputSpec ? String(input.outputSpec) : undefined
      const saveLocation = input.saveLocation ? String(input.saveLocation) : undefined

      const { createProcedure } = await import('./working-memory')
      const ok = await createProcedure({ taskType, title, keywords, checklist, outputSpec, saveLocation })
      if (ok) {
        return 'Procedura "' + title + '" (tipo: ' + taskType.toLowerCase().replace(/[^a-z0-9_-]/g, '') + ') creata con successo. Da ora la riconoscero automaticamente e potrò imparare da Lei con registra_apprendimento.'
      }
      return 'La procedura "' + taskType + '" esiste gia. Per aggiungere conoscenza usa registra_apprendimento.'
    } catch (err) {
      return 'Errore crea_procedura: ' + (err instanceof Error ? err.message : String(err))
    }
  }

  return null
}

// 2026-06-04 FASE 2 Memoria di progetto: tool per registrare il progetto/lavoro
// attivo (vale per QUALSIASI documento o pratica), così il bot non perde il filo.
const PROJECT_TOOLS: ToolDefinition[] = [
  {
    name: 'imposta_progetto_attivo',
    description: "Memorizza il progetto/lavoro su cui stiamo lavorando ORA (vale per QUALSIASI documento o pratica), così non perdi il filo tra i messaggi. Chiamalo all'inizio di un lavoro.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project_name: { type: 'string', description: 'Nome del progetto/lavoro (es. "POS cantiere Via Roma", "Preventivo ristrutturazione Bianchi").' },
        cliente: { type: 'string', description: 'Cliente, se applicabile.' },
        cantiere: { type: 'string', description: 'Cantiere/commessa, se applicabile.' },
        task_type: { type: 'string', description: 'Tipo di documento/lavoro (pos, preventivo, cme, perizia, relazione, ddt, pratica, ...).' },
        pending: { type: 'array', items: { type: 'string' }, description: 'Elenco di cosa manca / cosa resta da fare.' },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'aggiorna_progetto',
    description: 'Aggiorna lo stato del progetto attivo man mano che procedi.',
    input_schema: {
      type: 'object' as const,
      properties: {
        done: { type: 'array', items: { type: 'string' }, description: 'Cosa è stato completato.' },
        pending: { type: 'array', items: { type: 'string' }, description: 'Cosa manca ancora.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisioni prese da ricordare.' },
        key_files: { type: 'object', description: 'File chiave del progetto, es {dvr, psc, contratto} con link/id Drive.' },
      },
    },
  },
  {
    name: 'chiudi_progetto',
    description: 'Segna il progetto attivo come completato.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

async function executeProjectWrapper(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  if (name !== 'imposta_progetto_attivo' && name !== 'aggiorna_progetto' && name !== 'chiudi_progetto') {
    return null
  }
  try {
    if (!conversationId) return 'Contesto conversazione non disponibile.'
    const { setActiveProject, closeActiveProject } = await import('./working-memory')

    if (name === 'imposta_progetto_attivo') {
      const ok = await setActiveProject(conversationId, {
        project_name: input.project_name !== undefined ? String(input.project_name) : undefined,
        cliente: input.cliente !== undefined ? String(input.cliente) : undefined,
        cantiere: input.cantiere !== undefined ? String(input.cantiere) : undefined,
        task_type: input.task_type !== undefined ? String(input.task_type) : undefined,
        pending: Array.isArray(input.pending) ? (input.pending as unknown[]).map((v) => String(v)) : undefined,
      })
      return ok
        ? `✅ Progetto attivo memorizzato: "${String(input.project_name ?? '')}". Continuerò questo lavoro senza ripartire da zero.`
        : '⚠️ Non sono riuscito a memorizzare il progetto attivo.'
    }

    if (name === 'aggiorna_progetto') {
      const ok = await setActiveProject(conversationId, {
        done: Array.isArray(input.done) ? (input.done as unknown[]).map((v) => String(v)) : undefined,
        pending: Array.isArray(input.pending) ? (input.pending as unknown[]).map((v) => String(v)) : undefined,
        decisions: Array.isArray(input.decisions) ? (input.decisions as unknown[]).map((v) => String(v)) : undefined,
        key_files: input.key_files && typeof input.key_files === 'object' && !Array.isArray(input.key_files)
          ? (input.key_files as Record<string, unknown>)
          : undefined,
      })
      return ok ? '✅ Stato del progetto aggiornato.' : '⚠️ Non sono riuscito ad aggiornare il progetto.'
    }

    // chiudi_progetto
    const ok = await closeActiveProject(conversationId)
    return ok ? '✅ Progetto segnato come completato.' : '⚠️ Non sono riuscito a chiudere il progetto.'
  } catch (err) {
    return `Errore progetto: ${err instanceof Error ? err.message : err}`
  }
}

// 2026-06-04 FASE 2 Gestione bozze/documenti: ritrovare, modificare in-place e
// salvare su Drive un documento già generato (per QUALSIASI tipo), senza rigenerare.
const DRAFT_TOOLS: ToolDefinition[] = [
  {
    name: 'lista_bozze',
    description: 'Elenca i documenti/bozze già generati in questa conversazione (per QUALSIASI tipo: POS, preventivo, CME, perizia, relazione, DDT...). USALO per RITROVARE un documento invece di rigenerarlo da zero.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'ritrova_bozza',
    description: "Recupera il CONTENUTO di un documento già generato (per id), così puoi modificarlo o salvarlo. Restituisce l'HTML del documento.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'id del documento (come mostrato da lista_bozze).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'aggiorna_bozza',
    description: "Modifica IN-PLACE un documento esistente (stesso documento, stesso link): passi il contenuto COMPLETO aggiornato. USALO quando l'Ingegnere chiede di aggiungere/cambiare una parte (es. 'aggiungi un paragrafo') SENZA rigenerare tutto: prima ritrova_bozza, applica SOLO la modifica richiesta preservando il resto, poi aggiorna_bozza col contenuto completo modificato.",
    input_schema: {
      type: 'object' as const,
      properties: {
        doc_id: { type: 'string', description: 'id del documento da modificare.' },
        nuovo_contenuto: { type: 'string', description: 'Contenuto HTML COMPLETO aggiornato del documento.' },
      },
      required: ['doc_id', 'nuovo_contenuto'],
    },
  },
  {
    name: 'salva_bozza_pdf',
    description: 'Genera il PDF di un documento esistente e lo salva nella cartella Drive indicata. USALO per archiviare/consegnare: NON cercare il file su Drive, NON salvare testo piatto.',
    input_schema: {
      type: 'object' as const,
      properties: {
        doc_id: { type: 'string', description: 'id del documento.' },
        folder_id: { type: 'string', description: 'id della cartella Drive di destinazione.' },
      },
      required: ['doc_id', 'folder_id'],
    },
  },
  {
    name: 'genera_link_condivisione',
    description: "Prepara un link CONDIVISIBILE (a scadenza) per un documento/bozza, da dare a un cliente/ente esterno. NON genera subito: crea una proposta che l'utente DEVE confermare. Usalo SOLO se l'utente chiede esplicitamente di condividere.",
    input_schema: {
      type: 'object' as const,
      properties: {
        doc_id: { type: 'string', description: 'id del documento (come da lista_bozze/ritrova_bozza).' },
        giorni: { type: 'number', description: 'Giorni di validità del link (default 7, max 30).' },
      },
      required: ['doc_id'],
    },
  },
]

async function executeDraftWrapper(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  if (name !== 'lista_bozze' && name !== 'ritrova_bozza' && name !== 'aggiorna_bozza' && name !== 'salva_bozza_pdf' && name !== 'genera_link_condivisione') {
    return null
  }
  try {
    if (name === 'genera_link_condivisione') {
      const { createShareProposal } = await import('./share-proposte')
      const docId = String(input.doc_id || '').trim()
      if (!docId) return 'Errore: doc_id richiesto.'
      const giorni = typeof input.giorni === 'number' ? input.giorni : 7
      const propResult = await createShareProposal(docId, giorni)
      if (propResult && typeof propResult === 'object') return propResult.error
      if (!propResult) return 'Non sono riuscito a preparare la condivisione (documento non trovato o errore).'
      return `Sto per creare un link CONDIVISIBILE valido ${Math.min(30, Math.max(1, Math.round(giorni)))} giorni per questo documento. Chi avrà il link potrà vederlo. Confermi rispondendo: /condividi_ok_${propResult}`
    }

    const { listRecentDrafts, getDraft, updateDraft, saveDraftPdfToDrive } = await import('./draft-tools')

    if (name === 'lista_bozze') {
      if (!conversationId) return 'Contesto conversazione non disponibile.'
      return await listRecentDrafts(conversationId)
    }

    if (name === 'ritrova_bozza') {
      const d = await getDraft(String(input.id))
      if (!d.ok) return `Documento non trovato: ${d.error ?? String(input.id)}`
      return `Documento "${d.name}" (${d.url}):\n\n${d.content}`
    }

    if (name === 'aggiorna_bozza') {
      return await updateDraft(String(input.doc_id), String(input.nuovo_contenuto))
    }

    // salva_bozza_pdf
    return await saveDraftPdfToDrive(String(input.doc_id), String(input.folder_id))
  } catch (err) {
    return `Errore bozze: ${err instanceof Error ? err.message : err}`
  }
}

const ALL_TOOLS: ToolDefinition[] = [
  ...STUDIO_TECNICO_TOOLS,
  ...SAL_TOOLS, // 2026-08-13: SAL da computo (sal_estrai_computo, sal_calcola) con doppia conferma
  ...IMAGE_TOOLS, // 2026-06-12: rivedi_immagine — ri-aggancia i pixel di un'immagine già caricata
  ...SELF_TOOLS,
  ...DRIVE_TOOLS, // W1.3: 10 tool Drive/Sheets registrati + drive_upload_binary
  ...GITHUB_TOOLS, // Self-healing 2026-05-04 + 2026-05-08: read_file, propose_fix, deploy_status, merge_pr
  ...WEATHER_TOOLS, // 2026-05-05: weather_now via Open-Meteo
  ...SCADENZE_TOOLS, // 2026-05-25: scadenzario documenti/mezzi/cantieri
  ...LEGGI_ALLEGATO_TOOLS, // 2026-05-25 SP-1: leggi allegato mail → estrai scadenza
  ...DRIVE_POLICY_TOOLS, // 2026-05-26: governance accesso cartelle Drive (doppia conferma)
  ...FOTO_ARCHIVE_TOOLS, // 2026-05-26: archiviazione foto cantiere/progetto
  ...FIC_READ_TOOLS, // 2026-05-26 Contabilità A: Fatture in Cloud read-only
  ...MOVIMENTI_TOOLS, // 2026-05-26 Contabilità B: ingest estratti conto
  ...RICONCILIAZIONE_TOOLS, // 2026-05-26 Contabilita C: riconciliazione incassi/fatture
  ...PRIMA_NOTA_TOOLS, // 2026-05-26 Contabilita D: Prima Nota Google Sheet
  ...FIC_WRITE_TOOLS, // 2026-05-26 Contabilita F: compilazione bozze FIC con doppia conferma
  ...GMAIL_TOOLS, // 2026-05-05 Gmail R+W: 16 tool (account restruktura.drive@gmail.com via Google API)
  ...CALENDAR_TOOLS, // 2026-07-22 Google Calendar R+W: 5 tool (stesso account/OAuth, richiede ri-consent scope calendar)
  ...MEMORIA_TOOLS, // 2026-05-07 Memoria persistente sub-progetto B: 4 tool
  ...WORKING_MEMORY_TOOLS, // 2026-06-04 FASE 1 Memoria procedurale: registra_apprendimento
  ...PROJECT_TOOLS, // 2026-06-04 FASE 2 Memoria di progetto: imposta/aggiorna/chiudi progetto attivo
  ...DRAFT_TOOLS, // 2026-06-04 FASE 2 Gestione bozze: lista/ritrova/aggiorna/salva_pdf documenti
  ...PDF_TOOLS, // 2026-05-07 Pipeline PDF: genera_pdf
  ...(DOCUMENT_TEMPLATE_TOOLS as unknown as ToolDefinition[]), // 2026-06-11 Modelli documento Fase 1: insegna/compila/lista/ritrova
  ...(MAIL_TOOL_DEFINITIONS as unknown as ToolDefinition[]), // 2026-05-24 V19 Mail TopHost IMAP/SMTP: 5 tool (info@/raffaele.lentini@)
]

/** Nomi di tutti i tool registrati. Esposto per moduli (es. tools/self) che
 *  altrimenti importerebbero ALL_TOOLS creando un ciclo. Stesso set di ALL_TOOLS. */
export function getAllToolNames(): string[] {
  return ALL_TOOLS.map(t => t.name)
}

/**
 * Gli strumenti contabili hanno bisogno di sapere PER QUALE SOCIETÀ operano.
 * Oggi dichiarano esplicitamente Restruktura: nel Task 4 la società verrà
 * risolta dalla conversazione (società attiva) e passata qui.
 *
 * L'esplicito è deliberato: un valore di default nella firma renderebbe
 * possibile chiamare senza dichiarare l'azienda, che è il difetto appena
 * rimosso — una chiamata futura finirebbe in silenzio sull'account sbagliato.
 */
const SOCIETA_PROVVISORIA = 'restruktura' as const

const executeFicWrapper = (name: string, input: Record<string, unknown>) =>
  executeFicTool(name, input, SOCIETA_PROVVISORIA)
const executeFicWriteWrapper = (name: string, input: Record<string, unknown>) =>
  executeFicWriteTool(name, input, SOCIETA_PROVVISORIA)
const executeRiconciliazioneWrapper = (name: string, input: Record<string, unknown>) =>
  executeRiconciliazioneTool(name, input, SOCIETA_PROVVISORIA)

const EXECUTORS = [executeStudioTecnico, executeSalTool, executeImageTools, executeSelfTools, executePdfTools, executeDriveWrapper, executeGithubWrapper, executeWeatherWrapper, executeScadenzeWrapper, executeLeggiAllegatoTool, executeDrivePolicyTool, executeFotoArchiveTool, executeFicWrapper, executeMovimentiTool, executeRiconciliazioneWrapper, executePrimaNotaTool, executeFicWriteWrapper, executeGmailWrapper, executeCalendarTool, executeMemoriaWrapper, executeWorkingMemoryWrapper, executeProjectWrapper, executeDraftWrapper, executeDocumentTemplateTool, executeMailWrapper]

export function getToolDefinitions() {
  return [
    { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 },
    { type: 'code_execution_20260120' as const, name: 'code_execution' },
    ...ALL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  ]
}

export async function executeTool(name: string, input: Record<string, unknown>, conversationId?: string): Promise<string> {
  for (const executor of EXECUTORS) {
    const result = await executor(name, input, conversationId)
    if (result !== null) return result
  }
  return `Tool "${name}" non riconosciuto.`
}
