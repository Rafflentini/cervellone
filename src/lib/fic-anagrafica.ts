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
import { ficGet, ficPost, ficPut, getCompanyId } from './fatture-in-cloud'
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
/**
 * Quale dei due elenchi di Fatture in Cloud: `clients` o `suppliers`.
 *
 * ⚠️ 14 settembre 2026. `fic_crea_cliente` creava SOLO fra i clienti, con
 * l'endpoint cablato. Booking.com B.V. e' un FORNITORE: crearlo fra i clienti
 * lo faceva "esistere" in un elenco e mancare nell'altro — e la fattura
 * d'acquisto, che vuole un fornitore, non lo avrebbe trovato.
 */
export type SegmentoAnagrafica = 'clients' | 'suppliers'

export async function cercaCliente(
  societa: CodiceSocieta,
  dati: { nome?: string; codice_fiscale?: string; partita_iva?: string },
  // ⚠️ Su Fatture in Cloud clienti e fornitori sono DUE ELENCHI SEPARATI: un
  // fornitore cercato fra i clienti non si trova MAI, e il doppione che ne
  // nasce e' esattamente cio' che questa funzione esiste per impedire.
  elenco: SegmentoAnagrafica = 'clients',
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
    const r = await ficGet(`/c/${company.id}/entities/${elenco}`, { q: `${campo} = '${valore}'`, per_page: 10 }, societa)
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
        `/c/${company.id}/entities/${elenco}`,
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

/* ------------------------------------------------------------------ *
 *  MODIFICARE un'anagrafica che esiste gia'.
 * ------------------------------------------------------------------ */

/**
 * ⚠️ **PERCHE' ESISTE**, 15 settembre 2026. Parole dell'Ingegnere, una riga:
 * «deve saper anche modificare una anagrafica cliente o fornitore se serve».
 *
 * Fino a stanotte Cervellone sapeva CREARE una scheda (`fic_crea_cliente`) e
 * CERCARLA (`fic_cerca_anagrafica`). Non sapeva CORREGGERLA. Davanti a una
 * scheda con la citta' sbagliata, la P.IVA mancante o il codice destinatario
 * vuoto, l'unica strada praticabile era **crearne un'altra** — cioe'
 * fabbricare esattamente il DOPPIONE che l'intestazione di questo file esiste
 * per impedire. Un buco nella cassetta degli attrezzi non produce inazione:
 * produce la scorciatoia peggiore.
 *
 * 🚨 **LA REGOLA CENTRALE: UN CAMPO NON PASSATO NON SI TOCCA, E UN CAMPO VUOTO
 * NON VUOL DIRE «CANCELLA».** Chi chiama passa SOLO cio' che vuole cambiare.
 *
 * E siccome la documentazione di Fatture in Cloud **non dichiara** se il PUT
 * sia una sostituzione integrale o una modifica parziale (v. l'intestazione di
 * `fic-pagamenti.ts`: lo stesso dubbio, sullo stesso verbo), qui si prende
 * l'unica strada il cui esito e' identico sotto ENTRAMBE le semantiche:
 * **si rilegge la scheda intera, ci si applicano sopra le sole modifiche
 * richieste, e si rispedisce l'oggetto completo.** Se il PUT sostituisse
 * tutto, i campi non toccati arrivano comunque col loro valore di prima; se
 * accettasse un payload parziale, mandarli tutti non cambia nulla.
 *
 * ⚠️ **L'ESITO NON E' LA RISPOSTA DELLA PUT: E' LA RILETTURA.** Dopo la
 * scrittura la scheda si rilegge e si confronta campo per campo. Se un campo
 * che si e' chiesto di cambiare NON risulta cambiato, il tool lo DICE invece
 * di dichiarare successo — un «fatto» che non corrisponde al gestionale e'
 * peggio di un errore, perche' nessuno va a controllare.
 *
 * ⚠️ **Perche' NON e' fra le `AZIONI_IRREVERSIBILI`** (stessa ragione di
 * `fic_crea_cliente`, v. l'intestazione del file): una scheda anagrafica si
 * ricorregge e non lascia traccia fiscale. Se fosse marcata irreversibile, la
 * contabile — che e' chi lavora le anagrafiche — non l'avrebbe in mano.
 */

/**
 * I campi che questo tool sa correggere: la parola italiana di chi chiama →
 * il campo di Fatture in Cloud.
 *
 * E' ESATTAMENTE l'insieme che `fic_crea_cliente` sa scrivere, di proposito:
 * cio' che si sa creare si sa correggere, e niente di piu'. Un campo
 * correggibile ma non creabile (o il contrario) sarebbe una differenza fra i
 * due tool che nessuno si ricorda il giorno che serve.
 */
const CAMPI_ANAGRAFICA = {
  nome: 'name',
  tipo: 'type',
  codice_fiscale: 'tax_code',
  partita_iva: 'vat_number',
  indirizzo: 'address_street',
  cap: 'address_postal_code',
  citta: 'address_city',
  provincia: 'address_province',
  paese: 'country',
  email: 'email',
  codice_destinatario: 'ei_code',
} as const

type CampoAnagrafica = keyof typeof CAMPI_ANAGRAFICA

/**
 * 🚨 Le due CHIAVI con cui si riconosce un soggetto.
 *
 * Cambiare la partita IVA o il codice fiscale non e' come correggere un CAP:
 * sono i campi con cui il gestionale — e il Sistema di Interscambio — dicono
 * «questo e' quel soggetto». Cambiarli di nascosto su una scheda che ne ha
 * gia' uno diverso puo' spostare fatture gia' emesse su un'anagrafica
 * sbagliata, e il danno non si vede finche' qualcuno non cerca le fatture di
 * quel cliente e ne trova meta'.
 */
const CHIAVI_IDENTITA: readonly CampoAnagrafica[] = ['partita_iva', 'codice_fiscale']

/**
 * Campi che NON si rispediscono nel PUT: l'id sta nell'URL, le due date le
 * gestisce il server. Stessa scelta — e stesso motivo — di
 * `CAMPI_NON_SCRIVIBILI` in `fic-pagamenti.ts`.
 */
const NON_SCRIVIBILI_ENTITA = new Set(['id', 'created_at', 'updated_at'])

/** Date di sistema: cambiano da sole a ogni scrittura, non sono un danno. */
const VOLATILI_ENTITA = new Set(['created_at', 'updated_at'])

/**
 * Campi che Fatture in Cloud DERIVA da un altro: se cambia quello, cambiano
 * loro, e segnalarli sarebbe gridare al lupo su una modifica legittima.
 * `country_iso` segue `country`; e' il solo caso dentro l'insieme di campi che
 * questo tool tocca.
 */
const DERIVATI_ENTITA: Record<string, readonly string[]> = { country: ['country_iso'] }

/** Una modifica richiesta: il campo, com'era, come deve diventare. */
export interface ModificaAnagrafica {
  campo: string
  campo_fic: string
  prima: string
  dopo: string
}

/** Il valore FIC del campo `tipo`. `undefined` = non passato, `null` = non valido. */
function tipoFic(v: unknown): string | undefined | null {
  const s = pulisci(v)?.toLowerCase()
  if (!s) return undefined
  if (s === 'privato' || s === 'person') return 'person'
  if (s === 'azienda' || s === 'company') return 'company'
  return null
}

/**
 * Due valori dello stesso campo sono «lo stesso valore»?
 *
 * Sulle chiavi fiscali il confronto e' quello normalizzato (senza spazi, in
 * maiuscolo): «it 123» e «IT123» sono la stessa partita IVA, e trattarle come
 * diverse farebbe scattare la guardia dell'identita' su una non-modifica.
 */
function stessoValore(campo: string, a: string, b: string): boolean {
  if ((CHIAVI_IDENTITA as readonly string[]).includes(campo)) {
    return (chiaveFiscale(a) ?? '') === (chiaveFiscale(b) ?? '')
  }
  return a.trim() === b.trim()
}

/** Il valore di un campo sulla scheda, come stringa; '' se non c'e'. */
function valoreScheda(scheda: Record<string, unknown>, campoFic: string): string {
  return pulisci(scheda[campoFic]) ?? ''
}

/**
 * Cosa cambia davvero, confrontando la richiesta con la scheda VERA.
 *
 * 🚨 Qui vive la regola centrale, e vive in due righe:
 *  - un campo **non passato** non entra nel giro (`hasOwnProperty`);
 *  - un campo passato **vuoto** finisce fra gli `ignorati_vuoti` e NON viene
 *    scritto. Stringa vuota, spazi, `null`: nessuno di questi vuol dire
 *    «cancella». Questo tool non sa svuotare un campo, e lo dichiara.
 */
export function pianoModifica(
  scheda: Record<string, unknown>,
  input: Record<string, unknown>,
):
  | { ok: true; modifiche: ModificaAnagrafica[]; gia_cosi: string[]; ignorati_vuoti: string[] }
  | { ok: false; error: string } {
  const modifiche: ModificaAnagrafica[] = []
  const gia_cosi: string[] = []
  const ignorati_vuoti: string[] = []

  for (const campo of Object.keys(CAMPI_ANAGRAFICA) as CampoAnagrafica[]) {
    if (!Object.prototype.hasOwnProperty.call(input, campo)) continue
    const campo_fic = CAMPI_ANAGRAFICA[campo]
    const voluto = campo === 'tipo' ? tipoFic(input.tipo) : pulisci(input[campo])
    if (voluto === null) {
      return { ok: false, error: "tipo ammette solo 'privato' (persona fisica) o 'azienda': non lo interpreto." }
    }
    if (voluto === undefined) {
      ignorati_vuoti.push(campo)
      continue
    }
    const prima = valoreScheda(scheda, campo_fic)
    if (stessoValore(campo, prima, voluto)) {
      gia_cosi.push(campo)
      continue
    }
    modifiche.push({ campo, campo_fic, prima, dopo: voluto })
  }

  return { ok: true, modifiche, gia_cosi, ignorati_vuoti }
}

/**
 * Le modifiche che toccano l'IDENTITA' FISCALE di una scheda che ne ha gia'
 * una DIVERSA.
 *
 * ⚠️ `m.prima !== ''` non e' un dettaglio: **riempire** una P.IVA vuota non
 * sposta nessuna fattura — e' il caso normale di una scheda incompleta, ed e'
 * proprio il lavoro per cui questo tool e' nato. **Sostituirne** una che c'e'
 * gia' e' un'altra cosa.
 */
export function cambiDiIdentita(modifiche: ModificaAnagrafica[]): ModificaAnagrafica[] {
  return modifiche.filter(
    (m) => (CHIAVI_IDENTITA as readonly string[]).includes(m.campo) && m.prima !== '',
  )
}

/**
 * Il corpo del PUT: la scheda INTERA come riletta, meno i campi non
 * scrivibili, con sopra le sole modifiche richieste.
 *
 * ⚠️ Non e' ridondanza: e' l'unica forma corretta finche' non si sa se il PUT
 * di Fatture in Cloud sostituisca tutto o accetti un payload parziale (v. il
 * commento in testa a questa sezione e quello di `fic-pagamenti.ts`). Se
 * mandassimo solo i campi cambiati e il PUT fosse una sostituzione integrale,
 * tutto il resto della scheda verrebbe azzerato: indirizzo, email, codice
 * destinatario. Sarebbe una cancellazione silenziosa travestita da correzione.
 */
export function corpoAggiornamento(
  scheda: Record<string, unknown>,
  modifiche: ModificaAnagrafica[],
): Record<string, unknown> {
  const corpo: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(scheda)) {
    if (!NON_SCRIVIBILI_ENTITA.has(k)) corpo[k] = v
  }
  for (const m of modifiche) corpo[m.campo_fic] = m.dopo
  return corpo
}

export interface EsitoVerifica {
  confermate: Array<{ campo: string; prima: string; dopo: string }>
  non_confermate: Array<{ campo: string; prima: string; chiesto: string; riletto: string }>
  cambiato_anche: string[]
  identita_cambiata_senza_chiederlo: string[]
}

/** Forma canonica minima per il confronto: vuoto, `null` e assente sono la stessa cosa. */
function canonicoCampo(v: unknown): string {
  return JSON.stringify(v === null || v === undefined || v === '' ? null : v)
}

/**
 * Il PRIMA e il DOPO, letti da Fatture in Cloud.
 *
 * Confronta tre cose diverse, e sono diverse apposta:
 *  1. **le modifiche chieste**: risultano davvero applicate nella rilettura?
 *  2. **tutto il resto**: e' rimasto com'era? (la semantica del PUT non e'
 *     documentata: se fosse una sostituzione integrale e la rilettura ci
 *     avesse dato meno campi del necessario, il danno comparirebbe qui);
 *  3. **le chiavi fiscali che NESSUNO aveva chiesto di toccare**: se si sono
 *     mosse, non e' un'avvertenza — e' il danno che la guardia
 *     dell'identita' esiste per impedire, arrivato da un'altra porta.
 */
export function verificaAggiornamento(
  prima: Record<string, unknown>,
  dopo: Record<string, unknown>,
  modifiche: ModificaAnagrafica[],
): EsitoVerifica {
  const confermate: EsitoVerifica['confermate'] = []
  const non_confermate: EsitoVerifica['non_confermate'] = []
  for (const m of modifiche) {
    const riletto = valoreScheda(dopo, m.campo_fic)
    if (stessoValore(m.campo, riletto, m.dopo)) {
      confermate.push({ campo: m.campo, prima: m.prima, dopo: riletto })
    } else {
      non_confermate.push({ campo: m.campo, prima: m.prima, chiesto: m.dopo, riletto })
    }
  }

  const toccati = new Set(modifiche.map((m) => m.campo_fic))
  for (const m of modifiche) for (const d of DERIVATI_ENTITA[m.campo_fic] ?? []) toccati.add(d)

  const cambiato_anche: string[] = []
  const chiavi = new Set(
    [...Object.keys(prima), ...Object.keys(dopo)].filter((k) => !VOLATILI_ENTITA.has(k) && !toccati.has(k)),
  )
  for (const k of [...chiavi].sort()) {
    if (canonicoCampo(prima[k]) !== canonicoCampo(dopo[k])) cambiato_anche.push(k)
  }

  const fiscali = new Set(CHIAVI_IDENTITA.map((c) => CAMPI_ANAGRAFICA[c] as string))
  return {
    confermate,
    non_confermate,
    cambiato_anche,
    identita_cambiata_senza_chiederlo: cambiato_anche.filter((k) => fiscali.has(k)),
  }
}

/** Rilegge UNA scheda dall'elenco dichiarato. */
export async function leggiAnagrafica(
  id: number,
  elenco: SegmentoAnagrafica,
  societa: CodiceSocieta,
): Promise<{ ok: true; scheda: Record<string, unknown> } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(`/c/${company.id}/entities/${elenco}/${id}`, undefined, societa)
  if (!r.ok) {
    // 🚨 Si riporta COM'HA RISPOSTO. La notte del 14 set La Real Estate ha dato
    // «403 No permission» a raffica e il bot ha inventato due spiegazioni
    // diverse, entrambe sbagliate. Qui l'errore vero non si interpreta e non si
    // sostituisce: al massimo gli si ATTACCA una frase, quando lo stato dice
    // una cosa precisa e azionabile come il 404 su questo endpoint.
    const dove = elenco === 'clients' ? 'CLIENTI' : 'FORNITORI'
    const suffisso = r.error.includes('404')
      ? ` — l'id ${id} non e' fra i ${dove} di questa societa'. Clienti e fornitori sono elenchi SEPARATI: `
        + "controlla l'elenco e l'id con fic_cerca_anagrafica, non riprovare a caso."
      : ''
    return { ok: false, error: r.error + suffisso }
  }

  const scheda = (r.data?.data ?? r.data) as Record<string, unknown> | undefined
  if (!scheda || typeof scheda !== 'object' || Array.isArray(scheda)) {
    return {
      ok: false,
      error: `Fatture in Cloud ha risposto senza scheda per l'id ${id}: non so cosa ci sia scritto, quindi non scrivo.`,
    }
  }
  return { ok: true, scheda }
}

/**
 * 🚨 **LA DECISIONE SULLA REGOLA DELL'IDENTITA': SI FERMA E CHIEDE.**
 *
 * Davanti a un cambio di partita IVA o codice fiscale su una scheda che ne ha
 * gia' uno DIVERSO, questo tool **rifiuta** e restituisce nome vecchio, valore
 * vecchio e valore nuovo, invece di eseguire dichiarandolo. Il perche', per
 * esteso, perche' e' una scelta e non un'ovvieta':
 *
 *  - «eseguire dichiarandolo» dichiara un danno GIA' FATTO. Se la P.IVA nuova
 *    e' quella di un altro soggetto, le fatture di quella scheda sono gia'
 *    intestate a qualcun altro nel momento in cui il messaggio viene scritto —
 *    e un messaggio va letto, mentre una scrittura resta.
 *  - il rifiuto e' **recuperabile a costo zero**: il modello riporta la
 *    domanda all'Ingegnere e richiama lo stesso tool. E' un turno in piu'.
 *  - questo repo ha un difetto di famiglia documentato — «il guasto che invece
 *    di chiudere APRE»: nel dubbio, la strada larga. Qui il dubbio e' sul
 *    campo con cui lo Stato riconosce un soggetto.
 *
 * ⚠️ **Ma la capacita' resta**, altrimenti sarebbe una guardia che blocca il
 * caso normale (correggere una P.IVA sbagliata E' lavoro legittimo, ed e'
 * meta' del motivo per cui questo tool esiste): con
 * `conferma_cambio_identita: true` il cambio si fa — e l'esito lo dice forte
 * lo stesso.
 */
function rifiutoCambioIdentita(
  scheda: Record<string, unknown>,
  cambi: ModificaAnagrafica[],
): Record<string, unknown> {
  return {
    ok: false,
    modificato: false,
    error: "🚨 FERMO: stai cambiando la CHIAVE FISCALE di una scheda che ne ha gia' una diversa, e non lo faccio da solo.",
    scheda: {
      id: scheda.id,
      nome: valoreScheda(scheda, 'name') || '(senza nome)',
    },
    cambi_richiesti: cambi.map((c) => ({ campo: c.campo, valore_attuale: c.prima, valore_nuovo: c.dopo })),
    perche:
      'Partita IVA e codice fiscale sono le chiavi con cui si riconosce un soggetto: cambiarle su una scheda '
      + "che ne ha gia' una diversa puo' spostare fatture gia' emesse su un'anagrafica sbagliata, e il danno "
      + "non si vede finche' qualcuno non cerca le fatture di quel cliente e ne trova meta'.",
    cosa_faccio_adesso:
      "RIPORTA all'Ingegnere il nome della scheda e i due valori qui sopra, e CHIEDI se va cambiata QUESTA scheda "
      + "oppure se il soggetto nuovo e' un'altra persona (allora si crea una scheda nuova con fic_crea_cliente). "
      + 'Se conferma il cambio, richiama questo stesso tool con conferma_cambio_identita: true.',
  }
}

/**
 * Modifica una scheda anagrafica e lo PROVA rileggendola.
 *
 * L'ordine non e' casuale: si legge, si decide cosa cambia sui dati VERI (non
 * su quello che il chiamante crede ci sia), si controlla l'identita', si
 * scrive, si rilegge, si confronta. Ogni passo che ne salta un altro produce
 * un «fatto» che non corrisponde al gestionale.
 */
export async function aggiornaAnagrafica(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  // 🚨 SERVE L'ID. Non si cerca per nome per poi modificare il primo che
  // capita: quello e' il modo di riscrivere la scheda sbagliata — e su
  // un'anagrafica con doppioni (che e' il nostro caso) il «primo che capita»
  // e' quasi sempre quello morto.
  const id = typeof input.id === 'number' ? input.id : Number(pulisci(input.id))
  if (!Number.isFinite(id) || id <= 0) {
    return JSON.stringify({
      ok: false,
      modificato: false,
      error: "serve l'id dell'anagrafica da modificare (parametro id), e non lo indovino dal nome.",
      cosa_faccio_adesso:
        "Cerca la scheda con fic_cerca_anagrafica (per codice fiscale, partita IVA o nome), prendi l'id GIUSTO "
        + "e richiama questo tool con quell'id. Se la ricerca ne restituisce piu' di una, CHIEDI all'Ingegnere quale, non scegliere tu.",
    })
  }

  // 🚨 SERVE L'ELENCO, e non ha un predefinito. Su Fatture in Cloud clienti e
  // fornitori sono due elenchi separati: indovinare vuol dire, nel caso
  // migliore, un 404 — e nel peggiore riscrivere la scheda sbagliata.
  const tipoElenco = pulisci(input.elenco)?.toLowerCase()
  if (tipoElenco !== 'cliente' && tipoElenco !== 'fornitore') {
    return JSON.stringify({
      ok: false,
      modificato: false,
      error:
        "serve elenco: 'cliente' o 'fornitore'. Su Fatture in Cloud sono due elenchi SEPARATI e non indovino in quale sta l'id.",
      cosa_faccio_adesso:
        'Se non lo sai, guardalo con fic_cerca_anagrafica (che vuole lo stesso tipo) invece di tirare a indovinare.',
    })
  }
  const elenco: SegmentoAnagrafica = tipoElenco === 'fornitore' ? 'suppliers' : 'clients'

  const prima = await leggiAnagrafica(id, elenco, societa)
  if (!prima.ok) return JSON.stringify({ ok: false, modificato: false, error: prima.error })

  const piano = pianoModifica(prima.scheda, input)
  if (!piano.ok) return JSON.stringify({ ok: false, modificato: false, error: piano.error })

  const nome = valoreScheda(prima.scheda, 'name') || '(senza nome)'
  const nota_vuoti = piano.ignorati_vuoti.length > 0
    ? `Questi campi li hai passati VUOTI e NON li ho toccati: ${piano.ignorati_vuoti.join(', ')}. `
      + 'Un campo vuoto non vuol dire «cancella»: questo tool non sa svuotare un campo, si fa a mano su Fatture in Cloud.'
    : undefined

  if (piano.modifiche.length === 0) {
    // Non si manda un PUT «a vuoto»: una scrittura senza modifiche e' un
    // rischio senza contropartita, e dire «fatto» senza aver fatto niente e'
    // la bugia piu' facile da raccontare.
    return JSON.stringify({
      ok: piano.gia_cosi.length > 0 || piano.ignorati_vuoti.length > 0,
      modificato: false,
      elenco: tipoElenco,
      id,
      nome,
      motivo: piano.gia_cosi.length > 0
        ? `Non ho scritto niente: ${piano.gia_cosi.join(', ')} ${piano.gia_cosi.length === 1 ? 'era' : 'erano'} gia' cosi' su Fatture in Cloud.`
        : 'Non ho scritto niente: non mi hai detto nessun campo da cambiare (con un valore non vuoto).',
      campi_ignorati_perche_vuoti: piano.ignorati_vuoti.length > 0 ? piano.ignorati_vuoti : undefined,
      nota: nota_vuoti,
    })
  }

  const cambi = cambiDiIdentita(piano.modifiche)
  if (cambi.length > 0 && input.conferma_cambio_identita !== true) {
    return JSON.stringify(rifiutoCambioIdentita(prima.scheda, cambi))
  }

  const company = await getCompanyId(societa)
  if (!company.ok) return JSON.stringify({ ok: false, modificato: false, error: company.error })

  const scritto = await ficPut(
    `/c/${company.id}/entities/${elenco}/${id}`,
    corpoAggiornamento(prima.scheda, piano.modifiche),
    societa,
  )
  // L'errore di Fatture in Cloud si riporta COM'E' — stato HTTP e testo veri —
  // e non si interpreta: `ficPut` ci mette dentro tutti e due.
  if (!scritto.ok) {
    return JSON.stringify({
      ok: false,
      modificato: false,
      elenco: tipoElenco,
      id,
      nome,
      error: `Fatture in Cloud ha RIFIUTATO la modifica: ${scritto.error}`,
      cosa_faccio_adesso:
        "Riporta all'Ingegnere questa risposta COM'E', senza spiegarla: e' Fatture in Cloud che parla. Non ho scritto niente.",
    })
  }

  // 🚨 La risposta della PUT NON e' la prova: si rilegge.
  const dopo = await leggiAnagrafica(id, elenco, societa)
  if (!dopo.ok) {
    return JSON.stringify({
      ok: false,
      modificato: null,
      elenco: tipoElenco,
      id,
      nome,
      error: `l'API ha risposto ok ma NON riesco a rileggere la scheda per verificarlo (${dopo.error}).`,
      cosa_faccio_adesso: 'Non so se la modifica sia passata: controlla la scheda su Fatture in Cloud prima di rifarla.',
    })
  }

  const v = verificaAggiornamento(prima.scheda, dopo.scheda, piano.modifiche)
  const avvertenze: string[] = []
  if (nota_vuoti) avvertenze.push(nota_vuoti)
  if (cambi.length > 0) {
    avvertenze.push(
      "🚨 HO CAMBIATO UNA CHIAVE FISCALE (l'Ingegnere l'aveva confermato): "
      + cambi.map((c) => `${c.campo} di "${nome}" da "${c.prima}" a "${c.dopo}"`).join('; ')
      + ". Diglielo esplicitamente: le fatture gia' emesse a questa scheda ora portano la chiave nuova.",
    )
  }
  if (v.cambiato_anche.length > 0) {
    avvertenze.push(
      `⚠️ Rileggendo la scheda risulta cambiato anche cio' che NON avevo chiesto di cambiare: ${v.cambiato_anche.join(', ')}. `
      + 'Controlla la scheda su Fatture in Cloud.',
    )
  }

  // Una chiave fiscale che si muove senza che nessuno l'abbia chiesto non e'
  // un'avvertenza: e' esattamente il danno che la guardia sopra impedisce,
  // entrato da un'altra porta. Qui l'esito e' NEGATIVO.
  const identitaFuoriControllo = v.identita_cambiata_senza_chiederlo.length > 0
  const ok = v.non_confermate.length === 0 && !identitaFuoriControllo

  return JSON.stringify({
    ok,
    modificato: v.confermate.length > 0,
    elenco: tipoElenco,
    id,
    nome: valoreScheda(dopo.scheda, 'name') || nome,
    // PRIMA e DOPO, e sono i valori VERI letti da Fatture in Cloud DOPO la
    // scrittura: non quelli che avevamo chiesto.
    modifiche: v.confermate,
    non_confermate: v.non_confermate.length > 0 ? v.non_confermate : undefined,
    campi_non_passati: 'non toccati: restano come sono su Fatture in Cloud.',
    campi_ignorati_perche_vuoti: piano.ignorati_vuoti.length > 0 ? piano.ignorati_vuoti : undefined,
    campi_gia_cosi: piano.gia_cosi.length > 0 ? piano.gia_cosi : undefined,
    avvertenze: avvertenze.length > 0 ? avvertenze : undefined,
    error: identitaFuoriControllo
      ? `🚨 rileggendo la scheda la CHIAVE FISCALE e' cambiata senza che io l'avessi chiesto (${v.identita_cambiata_senza_chiederlo.join(', ')}): controlla SUBITO la scheda su Fatture in Cloud.`
      : v.non_confermate.length > 0
        ? "l'API ha risposto ok ma rileggendo la scheda NON tutte le modifiche risultano applicate (vedi non_confermate): NON dire che e' fatto."
        : undefined,
    cosa_faccio_adesso: ok
      ? "Riferisci all'Ingegnere cosa e' cambiato, campo per campo, con il prima e il dopo."
      : "NON dichiarare la modifica fatta: riporta cosa non risulta cambiato e di' di controllare la scheda su Fatture in Cloud.",
  })
}


export const ANAGRAFICA_TOOLS: ToolDefinition[] = [
  {
    name: 'fic_crea_cliente',
    description:
      "Crea un CLIENTE o un FORNITORE nuovo nell'anagrafica di Fatture in Cloud, sulla societa' attiva. " +
      "Con elenco: 'fornitore' lo crea fra i FORNITORI — serve per chi emette fatture verso di noi, come Booking.com B.V. o Airbnb: " +
      "su Fatture in Cloud clienti e fornitori sono elenchi SEPARATI, e un fornitore creato fra i clienti non si trova poi sulla fattura d acquisto. " +
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
        elenco: {
          type: 'string',
          enum: ['cliente', 'fornitore'],
          description: "In quale dei due elenchi di Fatture in Cloud. 'fornitore' per chi EMETTE una fattura verso di noi (Booking.com, Airbnb, un fornitore estero): clienti e fornitori sono elenchi SEPARATI e un fornitore creato fra i clienti non si trova poi sulla fattura d acquisto. Default: cliente.",
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
  {
    // ⚠️ Una capacita' che non e' nello SCHEMA, per il modello NON ESISTE. Qui
    // la descrizione deve dire tre cose, e le dice tutte e tre: quando usarlo,
    // che NON cancella niente, e che vuole l'id (non il nome).
    name: 'fic_aggiorna_anagrafica',
    description:
      "MODIFICA una scheda anagrafica che esiste GIA' su Fatture in Cloud — un cliente o un fornitore — correggendo "
      + 'solo i campi che gli passi. '
      + "USALO quando una scheda ha un dato sbagliato o incompleto: indirizzo, CAP, citta', email, codice destinatario SdI, "
      + "partita IVA o codice fiscale mancanti. NON creare una scheda nuova per correggere una vecchia: quello fabbrica un "
      + "DOPPIONE, e un'anagrafica piena di doppioni non si accorge di esserlo — il giorno che si cercano le fatture di "
      + "qualcuno se ne trovano meta'. "
      + "VUOLE L'ID e VUOLE L'ELENCO, e non li indovina: prendi l'id con fic_cerca_anagrafica (o dalla risposta di "
      + "fic_crea_cliente) e di' se e' un cliente o un fornitore, che su Fatture in Cloud sono elenchi SEPARATI. "
      + "Se la ricerca restituisce piu' di una scheda, CHIEDI all'Ingegnere quale, non scegliere tu. "
      + 'COSA NON FA: (1) NON CANCELLA NIENTE. Un campo che non passi resta com\'e\', e un campo passato VUOTO non vuol dire '
      + '«cancella»: viene ignorato. Per SVUOTARE un campo si fa a mano su Fatture in Cloud; '
      + '(2) non sposta una scheda da clienti a fornitori e non ne unisce due; '
      + '(3) non tocca fatture ne\' documenti: cambia solo la scheda. '
      + "🚨 PARTITA IVA e CODICE FISCALE: se la scheda ne ha gia' uno DIVERSO, il tool si FERMA e ti dice nome vecchio, "
      + 'valore vecchio e valore nuovo. Sono le chiavi con cui si riconosce un soggetto e cambiarle puo\' spostare fatture '
      + "su un'anagrafica sbagliata: riporta la cosa all'Ingegnere e CHIEDI. Se conferma, richiama con "
      + 'conferma_cambio_identita: true. (Riempire una partita IVA VUOTA non richiede nessuna conferma.) '
      + "L'ESITO VIENE DA UNA RILETTURA della scheda su Fatture in Cloud, non dalla risposta della scrittura: ti restituisce "
      + "il PRIMA e il DOPO di ogni campo. Se un campo risulta in non_confermate, NON dire che e' fatto.",
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description:
            "Id della scheda su Fatture in Cloud. OBBLIGATORIO: te lo da' fic_cerca_anagrafica o fic_crea_cliente. "
            + 'Non si modifica «il cliente che si chiama X»: si modifica un id.',
        },
        elenco: {
          type: 'string',
          enum: ['cliente', 'fornitore'],
          description:
            "OBBLIGATORIO, senza predefinito: clienti e fornitori sono due elenchi SEPARATI su Fatture in Cloud e non "
            + "indovino in quale sta l'id. 'fornitore' per chi EMETTE fatture verso di noi (Booking.com, Airbnb).",
        },
        nome: { type: 'string', description: "Nuovo nome o denominazione. Passalo SOLO se va cambiato: finisce sulle fatture." },
        tipo: { type: 'string', enum: ['privato', 'azienda'], description: 'Persona fisica o societa\'.' },
        codice_fiscale: {
          type: 'string',
          description: "🚨 Chiave fiscale: se la scheda ne ha gia' uno diverso il tool si ferma e chiede. Riempirlo se e' vuoto va bene.",
        },
        partita_iva: {
          type: 'string',
          description: "🚨 Chiave fiscale: se la scheda ne ha gia' una diversa il tool si ferma e chiede. Riempirla se e' vuota va bene.",
        },
        indirizzo: { type: 'string', description: 'Via e numero civico.' },
        cap: { type: 'string' },
        citta: { type: 'string' },
        provincia: { type: 'string', description: 'Sigla, es. PZ.' },
        paese: { type: 'string', description: 'Paese.' },
        email: { type: 'string' },
        codice_destinatario: {
          type: 'string',
          description: "Codice destinatario SdI. Per un PRIVATO senza PEC si usa 0000000000. Se non lo sai, non inventarlo: non passarlo.",
        },
        conferma_cambio_identita: {
          type: 'boolean',
          description:
            "SOLO dopo che l'Ingegnere ha confermato a voce il cambio di partita IVA o codice fiscale su una scheda che ne "
            + 'ha gia\' uno diverso. Non metterlo di tua iniziativa per «far passare» il tool: e\' la conferma di una persona, non un flag tecnico.',
        },
      },
      required: ['id', 'elenco'],
    },
  },
]

export async function executeAnagraficaTool(
  name: string,
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string | null> {
  if (name === 'fic_aggiorna_anagrafica') return aggiornaAnagrafica(input, societa)
  if (name !== 'fic_crea_cliente') return null

  const nome = pulisci(input.nome)
  if (!nome) return JSON.stringify({ ok: false, error: 'nome richiesto' })

  const codiceFiscale = pulisci(input.codice_fiscale)
  const partitaIva = pulisci(input.partita_iva)

  // ⚠️ SEMPRE prima di creare. V. l'intestazione del file: su un via-vai di
  // ospiti il difetto che si accumula e' il doppione, non il refuso.
  // Il fornitore va nel SUO elenco: su FIC clienti e fornitori non si vedono
  // fra loro. Il predefinito resta `cliente` perche' e' il caso normale (gli
  // ospiti degli affitti brevi), ma un fornitore estero come Booking.com B.V.
  // deve arrivare qui con elenco: 'fornitore'.
  const elenco: SegmentoAnagrafica = input.elenco === 'fornitore' ? 'suppliers' : 'clients'
  const gia = await cercaCliente(societa, { nome, codice_fiscale: codiceFiscale, partita_iva: partitaIva }, elenco)
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

  const r = await ficPost(`/c/${company.id}/entities/${elenco}`, corpo, societa)
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
