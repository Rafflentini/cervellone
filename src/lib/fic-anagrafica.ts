/**
 * src/lib/fic-anagrafica.ts — creare un cliente su Fatture in Cloud.
 *
 * Parole di Raffaele, 13 set 2026:
 *   «Se un cliente è nuovo non è in anagrafica: deve andare prima nel reparto
 *    anagrafica e creare l'anagrafica cliente, e poi fare nuova fattura
 *    elettronica e selezionare quel cliente salvato. Sia per una società sia
 *    per l'altra, ma per La Real Estate sono quasi tutti nuovi clienti —
 *    sono affitti brevi, vacanzieri — quindi è importante che lo faccia bene.»
 *
 * ⚠️ **IL RISCHIO QUI NON È SBAGLIARE: È DUPLICARE.**
 *
 * Su Restruktura i clienti sono pochi e ricorrenti. Su La Real Estate è un
 * via-vai di ospiti, e quasi ogni fattura nasce con un'anagrafica nuova. In
 * quelle condizioni l'errore che si accumula non è il nome scritto male — è
 * **lo stesso ospite inserito due volte**, perché la seconda volta nessuno ha
 * guardato se c'era già. Un'anagrafica piena di doppioni non si accorge di
 * esserlo, e il giorno che si cercano le fatture di qualcuno se ne trovano
 * metà.
 *
 * Per questo qui si CERCA sempre prima, su due chiavi indipendenti — il codice
 * fiscale/P.IVA (che è univoco) e il nome — e se qualcosa combacia **non si
 * crea**: si restituisce quello che c'è già, con il suo id, perché la fattura
 * possa puntarlo. Non è un errore, è il lavoro fatto: il cliente esisteva.
 *
 * ⚠️ **Perché NON è fra le `AZIONI_IRREVERSIBILI`.** La distinzione che conta
 * non è «scrive fuori di qui» ma «si può disfare senza conseguenze». Una
 * scheda cliente si corregge o si cancella su Fatture in Cloud e non lascia
 * traccia fiscale; una fattura emessa no. Se fosse marcata irreversibile, la
 * contabile non l'avrebbe in mano (v. `perimetroDiLavoro`) e il flusso che
 * Raffaele ha descritto non potrebbe esistere.
 */
import { ficGet, ficPost, getCompanyId } from './fatture-in-cloud'
import type { CodiceSocieta } from './societa'
import type { ToolDefinition } from './tools/types'

/** Ripulisce e normalizza, restituendo `undefined` per il vuoto. */
function pulisci(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? undefined : s
}

/** CF e P.IVA si confrontano senza spazi e in maiuscolo, o «rssmra…» e «RSSMRA…» sembrerebbero due persone. */
function chiaveFiscale(v: string | undefined): string | undefined {
  return v ? v.replace(/\s+/g, '').toUpperCase() : undefined
}

/**
 * Il nome ridotto all'osso per il confronto: niente accenti, niente
 * punteggiatura, niente doppi spazi, tutto minuscolo.
 *
 * «Sig. Mario Rossi» e «mario rossi» sono la stessa persona, e senza questa
 * normalizzazione la seconda prenotazione creerebbe la seconda scheda.
 */
export function nomeNormalizzato(nome: string): string {
  return nome
    .normalize('NFD')
    // I segni diacritici che `NFD` ha staccato dalle lettere: «Nuñez» e «Nunez»
    // sono lo stesso ospite, e senza questa riga sarebbero due schede.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ClienteEsistente {
  id: number
  nome: string
  codice_fiscale?: string
  partita_iva?: string
}

/**
 * Cerca un cliente già in anagrafica, per chiave fiscale **e** per nome.
 *
 * Due chiavi e non una: il codice fiscale è la prova, ma per un ospite
 * straniero spesso non c'è, e allora l'unica difesa contro il doppione è il
 * nome. Cercare solo per CF lascerebbe passare ogni straniero due volte.
 */
export async function cercaCliente(
  societa: CodiceSocieta,
  dati: { nome?: string; codice_fiscale?: string; partita_iva?: string },
): Promise<{ ok: true; trovati: ClienteEsistente[] } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const trovati = new Map<number, ClienteEsistente>()
  const aggiungi = (righe: unknown) => {
    if (!Array.isArray(righe)) return
    for (const r of righe as Record<string, unknown>[]) {
      const id = typeof r?.id === 'number' ? r.id : Number(r?.id)
      if (!Number.isFinite(id)) continue
      trovati.set(id, {
        id,
        nome: pulisci(r.name) ?? '',
        codice_fiscale: pulisci(r.tax_code),
        partita_iva: pulisci(r.vat_number),
      })
    }
  }

  // 1) La chiave certa. Se c'e' un CF o una P.IVA uguale, e' la stessa persona,
  //    comunque sia scritto il nome.
  for (const [campo, valore] of [
    ['tax_code', chiaveFiscale(dati.codice_fiscale)],
    ['vat_number', chiaveFiscale(dati.partita_iva)],
  ] as const) {
    if (!valore) continue
    const r = await ficGet(`/c/${company.id}/entities/clients`, { q: `${campo} = '${valore}'`, per_page: 10 }, societa)
    if (!r.ok) return { ok: false, error: r.error }
    aggiungi(r.data?.data)
  }

  // 2) Il nome. FIC non offre una ricerca normalizzata, quindi si chiede
  //    `contains` sulla prima parola significativa e si filtra QUI, dove il
  //    confronto e' quello vero.
  const nome = pulisci(dati.nome)
  if (nome) {
    const parola = nomeNormalizzato(nome).split(' ').sort((a, b) => b.length - a.length)[0] ?? ''
    if (parola.length >= 3) {
      const r = await ficGet(
        `/c/${company.id}/entities/clients`,
        { q: `name contains '${parola.replace(/'/g, "\\'")}'`, per_page: 50 },
        societa,
      )
      if (!r.ok) return { ok: false, error: r.error }
      const atteso = nomeNormalizzato(nome)
      const righe = Array.isArray(r.data?.data) ? (r.data.data as Record<string, unknown>[]) : []
      aggiungi(righe.filter((x) => nomeNormalizzato(pulisci(x.name) ?? '') === atteso))
    }
  }

  return { ok: true, trovati: [...trovati.values()] }
}

export const ANAGRAFICA_TOOLS: ToolDefinition[] = [
  {
    name: 'fic_crea_cliente',
    description:
      "Crea un CLIENTE NUOVO nell'anagrafica di Fatture in Cloud, sulla societa' attiva. " +
      'Serve PRIMA di fatturare a qualcuno che non e\' ancora in anagrafica — il caso normale per gli affitti brevi ' +
      'de La Real Estate, dove quasi ogni ospite e\' nuovo. ' +
      'Dopo averlo creato usa il cliente_id restituito in compila_fattura_emessa, cosi\' la fattura punta ' +
      "l'anagrafica giusta senza cercarla per nome. " +
      'NON crea doppioni: se un cliente con lo stesso codice fiscale, la stessa P.IVA o lo stesso nome esiste gia\', ' +
      "NON ne crea un altro e ti restituisce quello che c'e', con il suo id. Quello non e' un errore: usalo.",
    input_schema: {
      type: 'object',
      properties: {
        nome: {
          type: 'string',
          description: "Nome e cognome della persona, o denominazione dell'azienda. Scrivilo per esteso e corretto: finisce sulla fattura.",
        },
        tipo: {
          type: 'string',
          enum: ['privato', 'azienda'],
          description: "'privato' per una persona fisica (ospite di un affitto breve), 'azienda' per una societa'. Default: privato.",
        },
        codice_fiscale: { type: 'string', description: 'Codice fiscale. Per un privato italiano serve sulla fattura elettronica.' },
        partita_iva: { type: 'string', description: "Partita IVA, se e' un'azienda o un professionista." },
        indirizzo: { type: 'string', description: 'Via e numero civico.' },
        cap: { type: 'string' },
        citta: { type: 'string' },
        provincia: { type: 'string', description: 'Sigla, es. PZ.' },
        paese: { type: 'string', description: "Paese. Default Italia. Per un ospite straniero mettilo: cambia la fattura." },
        email: { type: 'string' },
        codice_destinatario: {
          type: 'string',
          description:
            "Codice destinatario SdI. Per un PRIVATO senza PEC si usa 0000000000. Se non lo sai, non inventarlo: lascialo vuoto.",
        },
      },
      required: ['nome'],
    },
  },
]

export async function executeAnagraficaTool(
  name: string,
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string | null> {
  if (name !== 'fic_crea_cliente') return null

  const nome = pulisci(input.nome)
  if (!nome) return JSON.stringify({ ok: false, error: 'nome richiesto' })

  const codiceFiscale = pulisci(input.codice_fiscale)
  const partitaIva = pulisci(input.partita_iva)

  // ⚠️ SEMPRE prima di creare. V. l'intestazione del file: su un via-vai di
  // ospiti il difetto che si accumula e' il doppione, non il refuso.
  const gia = await cercaCliente(societa, { nome, codice_fiscale: codiceFiscale, partita_iva: partitaIva })
  if (!gia.ok) return JSON.stringify({ ok: false, error: gia.error })
  if (gia.trovati.length > 0) {
    return JSON.stringify({
      ok: true,
      creato: false,
      motivo: 'Esiste gia\' in anagrafica: NON ne ho creato un altro.',
      clienti: gia.trovati,
      cliente_id: gia.trovati[0].id,
      cosa_faccio_adesso:
        gia.trovati.length === 1
          ? 'Usa questo cliente_id in compila_fattura_emessa.'
          : `Ce ne sono ${gia.trovati.length} che combaciano: scegli quello giusto e usa il suo id. Se non sei sicuro, CHIEDI all'Ingegnere invece di indovinare.`,
    })
  }

  const company = await getCompanyId(societa)
  if (!company.ok) return JSON.stringify({ ok: false, error: company.error })

  const corpo: Record<string, unknown> = {
    name: nome,
    type: input.tipo === 'azienda' ? 'company' : 'person',
  }
  if (codiceFiscale) corpo.tax_code = codiceFiscale
  if (partitaIva) corpo.vat_number = partitaIva
  const mappa: Array<[string, string | undefined]> = [
    ['address_street', pulisci(input.indirizzo)],
    ['address_postal_code', pulisci(input.cap)],
    ['address_city', pulisci(input.citta)],
    ['address_province', pulisci(input.provincia)],
    ['country', pulisci(input.paese)],
    ['email', pulisci(input.email)],
    ['ei_code', pulisci(input.codice_destinatario)],
  ]
  for (const [campo, valore] of mappa) if (valore) corpo[campo] = valore

  const r = await ficPost(`/c/${company.id}/entities/clients`, corpo, societa)
  if (!r.ok) return JSON.stringify({ ok: false, error: r.error })

  const creato = (r.data?.data ?? r.data) as Record<string, unknown> | undefined
  const id = typeof creato?.id === 'number' ? creato.id : Number(creato?.id)
  if (!Number.isFinite(id)) {
    // ⚠️ Non si dice «creato» senza l'id: il cliente potrebbe esserci davvero,
    // e dirlo con un id inventato manderebbe la fattura sull'anagrafica
    // sbagliata. Meglio dichiarare l'incertezza.
    return JSON.stringify({
      ok: false,
      error: "Fatture in Cloud ha risposto senza id: non so se il cliente sia stato creato. Controlla l'anagrafica prima di rifare.",
    })
  }

  return JSON.stringify({
    ok: true,
    creato: true,
    cliente_id: id,
    nome: pulisci(creato?.name) ?? nome,
    cosa_faccio_adesso: 'Usa questo cliente_id in compila_fattura_emessa.',
  })
}
