// src/lib/document-template-tools.ts — Tool generici "Modelli documento" (binario A, Fase 1)
import {
  createTemplate,
  getTemplate,
  listTemplates,
  normalizeSlug,
  type CampoModello,
  type DocumentTemplate,
} from './document-templates'
import { validateValues, applyDefaults, riempiHtml } from './template-fill-html'
import { generatePdfFromHtml } from './pdf-generator'
import { uploadBinaryToDrive } from './drive'
import { generaAllegato10Cigo } from '@/v19/tools/cigo'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const DOCUMENT_TEMPLATE_TOOLS: ToolDefinition[] = [
  {
    name: 'lista_modelli',
    description:
      "Elenca i modelli di documento che hai imparato (riutilizzabili). Usalo quando l'utente chiede \"quali modelli conosci\" o per verificare se un documento richiesto esiste gia' come modello.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ritrova_modello',
    description:
      "Restituisce la scheda di un modello (campi richiesti compresi). Usalo PRIMA di compilare, per sapere quali dati chiedere all'utente.",
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'identificativo del modello' } },
      required: ['slug'],
    },
  },
  {
    name: 'insegna_modello',
    description:
      "Salva (o aggiorna) un modello di documento riutilizzabile, come DATO. Chiamalo quando l'utente dice \"questo e' un modello / ricordatelo / da ora riproducimelo\". Per i modelli HTML (metodo B_html) fornisci html_template con segnaposto {{campo}} e blocchi {{#tabella}}...{{/tabella}}. Identifica i campi variabili e CONFERMALI con l'utente prima di salvare.",
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        titolo: { type: 'string' },
        parole_chiave: { type: 'array', items: { type: 'string' } },
        tipo_sorgente: { type: 'string', enum: ['docx', 'pdf_form', 'pdf_flat', 'html', 'builtin'] },
        metodo: { type: 'string', enum: ['B_html', 'builtin_cigo'] },
        master_drive_id: { type: 'string' },
        html_template: { type: 'string' },
        campi: { type: 'array', items: { type: 'object' } },
        formati_output: { type: 'array', items: { type: 'string', enum: ['pdf', 'docx'] } },
        dove_salvare: { type: 'string', description: 'ID cartella Drive dove salvare i documenti generati' },
        mai_inviare: { type: 'boolean' },
      },
      required: ['slug', 'titolo', 'tipo_sorgente', 'metodo', 'campi'],
    },
  },
  {
    name: 'compila_modello',
    description:
      "Genera un documento da un modello insegnato, riempiendo i campi variabili e mantenendo l'impaginazione. Salva il file su Drive e RITORNA IL LINK REALE. NON invia mai nulla. Se mancano campi obbligatori, te li dice: chiedili all'utente, non inventarli.",
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        valori: { type: 'object', description: 'mappa campo->valore secondo la scheda del modello' },
        formato: { type: 'string', enum: ['pdf', 'docx'] },
        dove_salvare: { type: 'string', description: 'ID cartella Drive (opzionale)' },
      },
      required: ['slug', 'valori'],
    },
  },
]

function labelOf(campi: CampoModello[], nome: string): string {
  return campi.find((c) => c.nome === nome)?.label ?? nome
}

// Mappa i valori "piatti" del modello CIGO sull'Allegato10Input del builder esistente.
function mapCigoInput(valori: Record<string, unknown>): Record<string, unknown> {
  const beneficiari = Array.isArray(valori.beneficiari) ? valori.beneficiari : []
  return {
    azienda: {
      denominazione: 'RESTRUKTURA S.R.L.',
      codice_fiscale: '02087420762',
      matricola_inps: '6405924990',
      unita_produttiva: "Villa d'Agri - Via Enrico Mattei 5",
    },
    legale_rappresentante: { nome_cognome: 'Lentini Raffaele', qualifica: 'legale_rappresentante' },
    periodo: { data_inizio: String(valori.periodo_dal ?? ''), data_fine: String(valori.periodo_al ?? '') },
    attivita_svolta: String(valori.lavorazioni ?? ''),
    evento_meteo: String(valori.evento_meteo ?? ''),
    conseguenze: String(valori.conseguenze ?? ''),
    ulteriori_annotazioni:
      valori.giornate_stop ? `Giornate di sospensione: ${String(valori.giornate_stop)}.` : undefined,
    beneficiari: beneficiari.map((b) => {
      const row = b as Record<string, unknown>
      return {
        cognome: String(row.cognome ?? ''),
        nome: String(row.nome ?? ''),
        codice_fiscale: String(row.codice_fiscale ?? ''),
        qualifica: row.qualifica ? String(row.qualifica) : undefined,
      }
    }),
    pagamento_diretto: Boolean(valori.pagamento_diretto ?? false),
  }
}

function todayTag(): string {
  return new Date().toISOString().slice(0, 10)
}

async function compila(input: Record<string, unknown>): Promise<string> {
  const slug = normalizeSlug(String(input.slug ?? ''))
  const valoriRaw = (input.valori as Record<string, unknown>) ?? {}
  const tpl: DocumentTemplate | null = await getTemplate(slug)
  if (!tpl) return `Modello "${slug}" non trovato. Usa lista_modelli per vedere quelli disponibili, oppure insegnamelo con insegna_modello.`

  const validation = validateValues(tpl.campi, valoriRaw)
  if (!validation.ok) {
    const etichette = validation.missing.map((n) => `- ${labelOf(tpl.campi, n)}`).join('\n')
    return `Per generare "${tpl.titolo}" mi servono questi dati:\n${etichette}\n\nDammeli e procedo. (Non li invento.)`
  }

  const valori = applyDefaults(tpl.campi, valoriRaw)
  const folderId = (input.dove_salvare as string) || tpl.dove_salvare || undefined

  if (tpl.metodo === 'builtin_cigo') {
    const out = await generaAllegato10Cigo(mapCigoInput(valori) as never, {} as never)
    const zip = (out as { zipBuffer?: Buffer }).zipBuffer
    if (!zip) return 'Non sono riuscito a generare il pacchetto CIGO (ZIP mancante).'
    const fileName = `CIGO_Allegato10_${todayTag()}.zip`
    const { webViewLink } = await uploadBinaryToDrive(zip, fileName, 'application/zip', folderId)
    const warnings = (out as { warnings?: string[] }).warnings ?? []
    let msg = `Pacchetto CIGO generato: ${fileName}\n${webViewLink}\n(Relazione Allegato 10 + CSV beneficiari + bollettino, dove disponibile. Non ho inviato nulla.)`
    if (warnings.length) msg += `\n\nAvvertenze: ${warnings.join('\n')}`
    return msg
  }

  // metodo B_html
  if (!tpl.html_template) return `Il modello "${slug}" non ha un template HTML configurato.`
  const html = riempiHtml(tpl.html_template, valori)
  const pdfBuffer = await generatePdfFromHtml(html, tpl.titolo)
  const fileName = `${slug}_${todayTag()}.pdf`
  const { webViewLink } = await uploadBinaryToDrive(pdfBuffer, fileName, 'application/pdf', folderId)
  return `Documento generato: ${fileName}\n${webViewLink}\n(Impaginazione del modello "${tpl.titolo}". Non ho inviato nulla.)`
}

export async function executeDocumentTemplateTool(
  name: string,
  input: Record<string, unknown>,
  _conversationId?: string,
): Promise<string | null> {
  try {
    if (name === 'lista_modelli') {
      const list = await listTemplates()
      if (!list.length) return 'Non ho ancora imparato nessun modello. Insegnamene uno: caricami il documento e dimmi quali parti cambiano.'
      return 'Modelli che conosco:\n' + list.map((m) => `- ${m.titolo} (slug: ${m.slug})`).join('\n')
    }

    if (name === 'ritrova_modello') {
      const tpl = await getTemplate(String(input.slug ?? ''))
      if (!tpl) return `Modello "${input.slug}" non trovato.`
      const campi = tpl.campi
        .map((c) => `- ${c.label}${c.obbligatorio ? ' (obbligatorio)' : ''} [${c.tipo}]`)
        .join('\n')
      return `Modello: ${tpl.titolo} (slug: ${tpl.slug})\nMetodo: ${tpl.metodo}\nCampi:\n${campi}`
    }

    if (name === 'insegna_modello') {
      const res = await createTemplate({
        slug: String(input.slug ?? ''),
        titolo: String(input.titolo ?? ''),
        parole_chiave: (input.parole_chiave as string[]) ?? [],
        tipo_sorgente: String(input.tipo_sorgente ?? 'html'),
        metodo: (input.metodo as DocumentTemplate['metodo']) ?? 'B_html',
        master_drive_id: (input.master_drive_id as string) ?? null,
        html_template: (input.html_template as string) ?? null,
        campi: (input.campi as CampoModello[]) ?? [],
        formati_output: (input.formati_output as string[]) ?? ['pdf'],
        dove_salvare: (input.dove_salvare as string) ?? null,
        mai_inviare: input.mai_inviare === undefined ? true : Boolean(input.mai_inviare),
      })
      if (!res.ok) return `Non sono riuscito a salvare il modello: ${res.error}`
      return `Modello salvato (slug: ${res.slug}). Da ora puoi chiedermi di riprodurlo: ti chiedo solo i dati variabili.`
    }

    if (name === 'compila_modello') {
      return await compila(input)
    }

    return null
  } catch (err) {
    return `Errore nello strumento modelli: ${err instanceof Error ? err.message : String(err)}`
  }
}
