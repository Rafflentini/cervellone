// src/lib/document-template-tools.ts — Tool generici "Modelli documento" (binario A, Fase 1)
import {
  createTemplate,
  getTemplate,
  listTemplates,
  setDatiFissi,
  normalizeSlug,
  type CampoModello,
  type DocumentTemplate,
} from './document-templates'
import { validateValues, applyDefaults, riempiHtml } from './template-fill-html'
import { generatePdfFromHtml } from './pdf-generator'
import { uploadBinaryToDrive } from './drive'
import { generaAllegato10Cigo } from '@/v19/tools/cigo'
import type { Allegato10Input } from '@/v19/tools/cigo/types'

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
        metodo: {
          type: 'string',
          enum: ['A_docx', 'B_html', 'builtin_cigo'],
          description: 'A_docx = riempie il file .docx ORIGINALE su Drive, lasciando impaginazione, font e intestazione IDENTICI (richiede master_drive_id). E il metodo da preferire ogni volta che esiste gia un modello Word dello studio. B_html = ricostruisce il documento da un HTML nostro (richiede html_template): usalo SOLO se un file originale non esiste, perche la resa e una nostra imitazione, non il documento dello studio.',
        },
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
      "Genera un documento da un modello insegnato, riempiendo i campi variabili e mantenendo l'impaginazione. Salva il file su Drive e RITORNA IL LINK REALE. NON invia mai nulla. Se mancano campi obbligatori, te li dice: chiedili all'utente, non inventarli. Le chiavi dell'oggetto valori DEVONO essere i nomi-chiave dei campi (es. periodo_dal, azienda_denominazione, beneficiari), NON le etichette: prendi i nomi esatti dal blocco MODELLO DOCUMENTO DISPONIBILE o da ritrova_modello.",
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        valori: { type: 'object', description: 'mappa nome-chiave-campo -> valore (usa i nomi esatti dei campi, non le etichette)' },
        formato: { type: 'string', enum: ['pdf', 'docx'] },
        dove_salvare: { type: 'string', description: 'ID cartella Drive (opzionale)' },
      },
      required: ['slug', 'valori'],
    },
  },
  {
    name: 'imposta_dati_fissi',
    description:
      "Salva i dati fissi riutilizzabili di un modello (es. dati azienda, legale rappresentante, operai abituali per CIGO) in modo che non servano a ogni richiesta. Chiamalo la prima volta che l'utente fornisce questi dati, oppure quando cambia azienda. I dati vengono uniti a quelli gia' presenti: le chiavi passate sovrascrivono, le altre restano. NON invia mai nulla.",
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'slug del modello a cui associare i dati fissi' },
        valori: {
          type: 'object',
          description: 'mappa chiave->valore dei dati fissi da memorizzare (es. azienda_denominazione, lr_nome_cognome, operai_abituali)',
        },
      },
      required: ['slug', 'valori'],
    },
  },
]

function labelOf(campi: CampoModello[], nome: string): string {
  return campi.find((c) => c.nome === nome)?.label ?? nome
}

// Formatta YYYY-MM-DD in DD/MM/YYYY; restituisce la stringa invariata se non parsabile.
function isoToItDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y}`
}

// Mappa i valori "piatti" del modello CIGO sull'Allegato10Input del builder esistente.
// Tutti i dati vengono letti da valori: nessun valore hardcodato.
export function mapCigoInput(valori: Record<string, unknown>): Allegato10Input {
  // Azienda
  const azienda: Allegato10Input['azienda'] = {
    denominazione: String(valori.azienda_denominazione ?? ''),
    codice_fiscale: String(valori.azienda_cf ?? ''),
    matricola_inps: String(valori.azienda_matricola_inps ?? ''),
  }
  if (valori.azienda_unita_produttiva) {
    azienda.unita_produttiva = String(valori.azienda_unita_produttiva)
  }
  if (valori.azienda_data_inizio_attivita) {
    azienda.data_inizio_attivita = String(valori.azienda_data_inizio_attivita)
  }

  // Legale rappresentante
  const lr: Allegato10Input['legale_rappresentante'] = {
    nome_cognome: String(valori.lr_nome_cognome ?? ''),
  }
  const qualifica = valori.lr_qualifica
  if (qualifica === 'titolare' || qualifica === 'legale_rappresentante') {
    lr.qualifica = qualifica
  }
  if (valori.lr_luogo_nascita) lr.luogo_nascita = String(valori.lr_luogo_nascita)
  if (valori.lr_data_nascita) lr.data_nascita = String(valori.lr_data_nascita)
  if (valori.lr_residenza) lr.residenza = String(valori.lr_residenza)
  if (valori.lr_telefono) lr.telefono = String(valori.lr_telefono)

  // Beneficiari: prima guarda beneficiari, poi fallback a operai_abituali
  const beneficiariRaw = Array.isArray(valori.beneficiari) && valori.beneficiari.length > 0
    ? valori.beneficiari
    : Array.isArray(valori.operai_abituali)
      ? valori.operai_abituali
      : []

  const beneficiari: Allegato10Input['beneficiari'] = beneficiariRaw.map((b) => {
    const row = b as Record<string, unknown>
    // Le ore di stop totali per operaio finiscono in OreCIG del CSV INPS
    // (build-beneficiari-csv somma ore_perse_settimana_1..4). Mettiamo il totale in settimana_1.
    const oreNum = Number(row.ore ?? 0)
    return {
      cognome: String(row.cognome ?? ''),
      nome: String(row.nome ?? ''),
      codice_fiscale: String(row.codice_fiscale ?? ''),
      qualifica: row.qualifica ? String(row.qualifica) : undefined,
      ore_perse_settimana_1: Number.isFinite(oreNum) ? oreNum : 0,
    }
  })

  // Cantiere: fold comune, indirizzo e data apertura in attivita_svolta
  // so they appear in the generated relazione (they are collected but were never used before).
  const cantiere_comune = valori.cantiere_comune ? String(valori.cantiere_comune) : ''
  const cantiere_indirizzo = valori.cantiere_indirizzo ? String(valori.cantiere_indirizzo) : ''
  const cantiere_data_apertura = valori.cantiere_data_apertura ? String(valori.cantiere_data_apertura) : ''
  const lavorazioni = String(valori.lavorazioni ?? '')

  let attivita_svolta: string
  if (cantiere_comune || cantiere_indirizzo) {
    let cantierePart = `Cantiere sito in ${[cantiere_comune, cantiere_indirizzo].filter(Boolean).join(', ')}`
    if (cantiere_data_apertura) {
      cantierePart += `, aperto il ${isoToItDate(cantiere_data_apertura)}`
    }
    cantierePart += '.'
    attivita_svolta = lavorazioni ? `${cantierePart} ${lavorazioni}` : cantierePart
  } else {
    attivita_svolta = lavorazioni
  }

  return {
    azienda,
    legale_rappresentante: lr,
    periodo: { data_inizio: String(valori.periodo_dal ?? ''), data_fine: String(valori.periodo_al ?? '') },
    attivita_svolta,
    evento_meteo: String(valori.evento_meteo ?? ''),
    conseguenze: String(valori.conseguenze ?? ''),
    ulteriori_annotazioni:
      valori.giornate_stop ? `Giornate di sospensione: ${String(valori.giornate_stop)}.` : undefined,
    beneficiari,
    pagamento_diretto: Boolean(valori.pagamento_diretto ?? false),
  }
}

function todayTag(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

async function compila(input: Record<string, unknown>): Promise<string> {
  const slug = normalizeSlug(String(input.slug ?? ''))
  const valoriRaw = (input.valori as Record<string, unknown>) ?? {}
  const tpl: DocumentTemplate | null = await getTemplate(slug)
  if (!tpl) return `Modello "${slug}" non trovato. Usa lista_modelli per vedere quelli disponibili, oppure insegnamelo con insegna_modello.`

  // Merge: dati_fissi come base, valori per-richiesta sovrascrivono, poi i default del modello
  const merged = applyDefaults(tpl.campi, { ...(tpl.dati_fissi ?? {}), ...valoriRaw })

  const validation = validateValues(tpl.campi, merged)
  if (!validation.ok) {
    const etichette = validation.missing.map((n) => `- ${n} (${labelOf(tpl.campi, n)})`).join('\n')
    return `Per generare "${tpl.titolo}" mi servono questi dati. Chiedili all'utente e richiama compila_modello usando ESATTAMENTE queste chiavi nel parametro valori:\n${etichette}\n\n(Non inventare valori. Non dire che il documento e' pronto: non lo e' finche' non hai un link reale.)`
  }

  const valori = merged
  const folderId = (input.dove_salvare as string) || tpl.dove_salvare || undefined

  if (tpl.metodo === 'builtin_cigo') {
    const mapped = mapCigoInput(valori)
    // FIX 2: zero-workers guard — do not call the builder with no beneficiari
    if (mapped.beneficiari.length === 0) {
      return 'Per il CIGO mi servono gli operai coinvolti (cognome, nome, codice fiscale, qualifica, ore TOTALI di stop). Forniscili nella richiesta, oppure salvali una volta come operai abituali con imposta_dati_fissi.'
    }
    // Zero ore per TUTTI: succede quando i beneficiari arrivano dal fallback
    // `operai_abituali` dei dati fissi, dove le ore non si salvano — sono
    // variabili per periodo. La guardia sopra conta le persone, non le ore:
    // senza questa, il CSV per l'INPS esce con OreCIG=0 su ogni riga, cioe' una
    // domanda di integrazione salariale che non chiede niente. E nessuno lo dice.
    if (mapped.beneficiari.every((b) => !b.ore_perse_settimana_1)) {
      return `Ho ${mapped.beneficiari.length} operai ma NESSUNA ora di sospensione: il pacchetto per l'INPS uscirebbe con zero ore richieste per tutti. Dimmi le ore TOTALI di stop nel periodo per ciascun operaio (le ore cambiano a ogni periodo, per questo non stanno nei dati fissi). Il pacchetto NON e' stato generato.`
    }
    const out = await generaAllegato10Cigo(mapped, {})
    const zip = (out as { zipBuffer?: Buffer }).zipBuffer
    if (!zip) return 'Non sono riuscito a generare il pacchetto CIGO (ZIP mancante).'
    // FIX 3: filename uses periodo, sanitize slashes
    const dal = mapped.periodo.data_inizio.replace(/\//g, '-')
    const al = mapped.periodo.data_fine.replace(/\//g, '-')
    const fileName = `CIGO_Allegato10_${dal}_${al}.zip`
    const { webViewLink } = await uploadBinaryToDrive(zip, fileName, 'application/zip', folderId)
    const warnings = (out as { warnings?: string[] }).warnings ?? []
    // FIX 4: include worker count in success message
    let msg = `Pacchetto CIGO generato per ${mapped.beneficiari.length} operai: ${fileName}\n${webViewLink}\n(Relazione Allegato 10 + CSV beneficiari + bollettino, dove disponibile. Non ho inviato nulla.)`
    if (warnings.length) msg += `\n\nAvvertenze: ${warnings.join('\n')}`
    return msg
  }

  // metodo A_docx — riempie il .docx ORIGINALE, senza reimpaginarlo.
  //
  // È la differenza che conta: B_html ricostruisce il documento da un HTML
  // nostro (font, margini, intestazione rifatti a occhio), A_docx apre il file
  // dell'Ingegnere e tocca SOLO i segnaposto. Quello che non è un segnaposto
  // esce identico perché non viene mai riscritto.
  if (tpl.metodo === 'A_docx') {
    if (!tpl.master_drive_id) return `Il modello "${slug}" è di tipo A_docx ma non ha un file master su Drive: non c'è niente da riempire.`
    const { downloadFileBase64 } = await import('./drive')
    const { riempiDocx } = await import('./template-fill-docx')

    let master: { base64: string; name: string }
    try {
      master = await downloadFileBase64(tpl.master_drive_id)
    } catch (err) {
      return `Non riesco a scaricare il modello originale da Drive (${err instanceof Error ? err.message : err}). Il documento NON è stato generato.`
    }

    const esito = riempiDocx(Buffer.from(master.base64, 'base64'), valori)
    if (!esito.ok || !esito.buffer) {
      return `Non sono riuscito a riempire il modello "${tpl.titolo}": ${esito.error ?? 'errore sconosciuto'}. Il documento NON è stato generato.`
    }

    const fileName = `${slug}_${todayTag()}.docx`
    const { webViewLink } = await uploadBinaryToDrive(
      esito.buffer,
      fileName,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      folderId,
    )
    // I campi rimasti vuoti si DICONO. Un documento consegnato come "pronto" con
    // dentro dei buchi è il modo piu' veloce per mandarlo a un committente cosi'.
    const avviso = esito.mancanti?.length
      ? `\n\n⚠️ Questi campi sono rimasti VUOTI nel documento: ${esito.mancanti.join(', ')}. Vanno completati prima di inviarlo.`
      : ''
    return `Documento generato dal Suo modello originale: ${fileName}\n${webViewLink}\n(Impaginazione del file "${master.name}" invariata: ho sostituito solo i campi. Non ho inviato nulla.)${avviso}`
  }

  // metodo B_html
  if (!tpl.html_template) return `Il modello "${slug}" non ha un template HTML configurato.`
  const html = riempiHtml(tpl.html_template, valori)
  const pdfBuffer = await generatePdfFromHtml(html, tpl.titolo)
  const romeDate = todayTag()
  const fileName = `${slug}_${romeDate}.pdf`
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
        .map((c) => `- ${c.nome}${c.obbligatorio ? '*' : ''} (${c.label}) [${c.tipo}]`)
        .join('\n')
      const datiFissi = Object.keys(tpl.dati_fissi ?? {})
      const datiFissiStr = datiFissi.length ? datiFissi.join(', ') : 'nessuno'
      return `Modello: ${tpl.titolo} (slug: ${tpl.slug})\nMetodo: ${tpl.metodo}\nNel parametro valori di compila_modello usa il nome-chiave (prima parola di ogni riga, * = obbligatorio), NON l'etichetta tra parentesi.\nCampi:\n${campi}\nDati fissi gia' memorizzati: ${datiFissiStr}`
    }

    if (name === 'insegna_modello') {
      const metodo = (input.metodo as DocumentTemplate['metodo']) ?? 'B_html'
      // `campi` arriva dal modello e lo schema del tool non ne valida la forma:
      // un array di stringhe, o un oggetto, non devono far esplodere il tool con
      // "campi.map is not a function". Se non è un array lo si lascia passare
      // com'è: `createTemplate` ha già il messaggio giusto ("campi deve essere
      // un array"), e sovrappporgliene un altro peggiora la diagnosi.
      const campiInput = input.campi
      let campi = (Array.isArray(campiInput) ? campiInput : []) as CampoModello[]
      const masterIdPulito = String(input.master_drive_id ?? '').trim()
      let avvisoCampi = ''

      // A_docx: il master si APRE prima di registrarlo. Senza questo controllo
      // bastava un master_drive_id non vuoto per rispondere "Modello salvato,
      // da ora puoi chiedermi di riprodurlo" — anche puntando a un PDF, o a un
      // Word senza un solo segnaposto. La registrazione sembrava riuscita e la
      // compilazione restituiva una copia intatta del master, vuota di dati.
      if (metodo === 'A_docx') {
        if (!masterIdPulito) return "Il metodo A_docx richiede master_drive_id: l'id del file .docx originale su Drive."

        const { downloadFileBase64 } = await import('./drive')
        const { verificaMasterDocx } = await import('./template-fill-docx')

        let master: { base64: string; name: string }
        try {
          master = await downloadFileBase64(masterIdPulito)
        } catch (err) {
          return `Non riesco a scaricare il file master da Drive (${err instanceof Error ? err.message : err}). Il modello NON è stato registrato.`
        }

        const verifica = verificaMasterDocx(
          Buffer.from(master.base64, 'base64'),
          campi.map((c) => c?.nome).filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
        )
        if (!verifica.ok) return verifica.error ?? 'Il file master non è utilizzabile. Il modello NON è stato registrato.'

        // Se nessuno ha dichiarato i campi, li dichiara il documento stesso:
        // è il modo previsto perché nessuno debba trascriverli a mano.
        if (campi.length === 0) {
          campi = (verifica.campi ?? []).map((nome) => ({ nome, tipo: 'testo', label: nome, obbligatorio: false } as CampoModello))
        }

        // I campi dichiarati che nel documento non compaiono si DICONO: verrebbero
        // chiesti all'utente e poi non finirebbero da nessuna parte.
        if (verifica.dichiaratiAssenti?.length) {
          avvisoCampi = `\n\n⚠️ Questi campi sono dichiarati ma nel documento non compaiono: ${verifica.dichiaratiAssenti.join(', ')}. Verrebbero chiesti e poi persi. Segnaposto trovati nel master: ${(verifica.campi ?? []).join(', ')}.`
        }
      }

      const res = await createTemplate({
        slug: String(input.slug ?? ''),
        titolo: String(input.titolo ?? ''),
        parole_chiave: (input.parole_chiave as string[]) ?? [],
        tipo_sorgente: String(input.tipo_sorgente ?? 'html'),
        metodo,
        // L'id si registra RIPULITO, lo stesso che è stato verificato. Un id
        // incollato con uno spazio o un a-capo passava il controllo e poi
        // falliva per sempre in compilazione: proprio la divergenza fra "ciò
        // che si verifica" e "ciò che si usa" che questa guardia deve chiudere.
        master_drive_id: masterIdPulito || null,
        html_template: (input.html_template as string) ?? null,
        campi: Array.isArray(campiInput) ? campi : (campiInput as CampoModello[]),
        formati_output: (input.formati_output as string[]) ?? ['pdf'],
        dove_salvare: (input.dove_salvare as string) ?? null,
        mai_inviare: input.mai_inviare === undefined ? true : Boolean(input.mai_inviare),
      })
      if (!res.ok) return `Non sono riuscito a salvare il modello: ${res.error}`
      return `Modello salvato (slug: ${res.slug}). Da ora puoi chiedermi di riprodurlo: ti chiedo solo i dati variabili.${avvisoCampi}`
    }

    if (name === 'compila_modello') {
      return await compila(input)
    }

    if (name === 'imposta_dati_fissi') {
      const slug = String(input.slug ?? '')
      const valori = (input.valori as Record<string, unknown>) ?? {}
      const res = await setDatiFissi(slug, valori)
      if (!res.ok) return `Non sono riuscito a salvare i dati fissi: ${res.error}`
      return `Dati fissi salvati per il modello "${normalizeSlug(slug)}". Da ora li riuso automaticamente: non dovrai ridarmeli ogni volta. Per cambiare azienda, richiama questo comando con i nuovi dati.`
    }

    return null
  } catch (err) {
    return `Errore nello strumento modelli: ${err instanceof Error ? err.message : String(err)}`
  }
}
