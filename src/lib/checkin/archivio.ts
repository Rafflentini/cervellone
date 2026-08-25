/**
 * src/lib/checkin/archivio.ts
 *
 * Cosa e' ancora lavoro aperto e cosa e' storia.
 *
 * L'archivio qui NON e' un magazzino: le righe non si spostano da nessuna
 * parte, restano sul `Soggiorni` dove sono sempre state. Archiviare vuol dire
 * soltanto non mostrarle finche' non le si cerca. Spostare le righe concluse su
 * un'altra scheda sembrerebbe piu' ordinato e sarebbe una trappola: la
 * prenotazione che poi va corretta — e ce ne sara' una — finirebbe in un posto
 * che il resto del programma non legge.
 *
 * Due proprieta' opposte da tenere insieme:
 *
 *  1. **Niente sparisce perche' e' passato.** Un check-in incompleto o un file
 *     per la Questura mai generato restano sotto gli occhi mesi dopo.
 *  2. **L'elenco non cresce all'infinito.** Con 5 appartamenti e affitti
 *     settimanali sono ~150 prenotazioni l'anno: senza una vista, per vedere
 *     chi arriva domani si scorre sopra a tutta la stagione.
 *
 * Tutto qui dentro e' PURO: nessuna lettura del foglio, nessuna data presa
 * dall'orologio. `oggi` si passa. Cosi' il confine fra "adesso" e "archivio" —
 * che e' l'unica cosa che puo' far sparire una riga dagli occhi — si prova per
 * davvero, compreso il giorno esatto in cui una prenotazione cambia lato.
 */

export type Vista = 'adesso' | 'archivio'

/**
 * Gli stati della fattura, in ordine di avanzamento.
 *
 * COMPILATA ed EMESSA sono due cose diverse e vanno tenute separate: la prima
 * e' la fattura che Cervellone ha preparato su Fatture in Cloud, la seconda e'
 * quella che l'Ingegnere ha davvero inviato. Confonderle vorrebbe dire credere
 * spedito cio' che e' soltanto scritto — e accorgersene dal commercialista.
 */
export const STATI_FATTURA = ['DA FARE', 'COMPILATA', 'EMESSA'] as const
export type StatoFattura = (typeof STATI_FATTURA)[number]

export interface PraticaArchiviabile {
  id: string
  unita: string
  intestatario: string
  codPrenotazione: string
  /** aaaa-mm-gg */
  checkin: string
  /** aaaa-mm-gg */
  checkout: string
  /** Come sta sul foglio: puo' essere scritto a mano. */
  notti: string
  /** Come sta sul foglio: puo' essere scritto a mano, con la virgola. */
  imposta: string
  stato: string
  inviatoAlloggiati: boolean
  statoFattura: StatoFattura
}

/**
 * Lo stato della fattura di una riga del foglio.
 *
 * La colonna `Stato fattura` e' nata dopo `Fattura emessa`: sulle righe
 * scritte prima non c'e'. Invece di chiedere una conversione a mano — che
 * nessuno farebbe, e che lascerebbe meta' foglio in uno stato e meta'
 * nell'altro — si ripiega sul SI/NO che c'era.
 *
 * Uno stato non riconosciuto vale DA FARE: sul foglio ci scrive anche una
 * persona, e "fatta" non e' uno stato. Fra sbagliare per eccesso di prudenza e
 * dare per emessa una fattura che non esiste, non c'e' partita.
 */
export function statoFatturaDi(riga: Record<string, string | undefined>): StatoFattura {
  const scritto = String(riga['Stato fattura'] ?? '').trim().toUpperCase()
  if ((STATI_FATTURA as readonly string[]).includes(scritto)) return scritto as StatoFattura

  return String(riga['Fattura emessa'] ?? '').trim().toUpperCase() === 'SI' ? 'EMESSA' : 'DA FARE'
}

/**
 * Un numero come lo trova sul foglio, dove ci scrive anche una persona.
 *
 * Restituisce 0 su tutto cio' che non si legge, mai NaN: un NaN dentro una
 * somma non sbaglia la riga sua, rende illeggibile l'intera colonna — e questa
 * colonna finisce in una dichiarazione al Comune.
 */
export function numeroIt(valore: string): number {
  const s = String(valore ?? '').trim()
  if (!s) return 0

  // "1.250,00": il punto separa le migliaia e la virgola i decimali. Trattare
  // il punto come decimale darebbe 1,25 al posto di 1250.
  const normale = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
  const n = Number(normale)
  return Number.isFinite(n) ? n : 0
}

/** Somma denaro passando per i centesimi: 0,10 + 0,10 + 0,10 dev'essere 0,30. */
function sommaEuro(valori: number[]): number {
  return Math.round(valori.reduce((t, v) => t + Math.round(v * 100), 0)) / 100
}

/**
 * Da che parte sta una prenotazione.
 *
 * In ADESSO finisce tutto cio' su cui c'e' ancora qualcosa da fare QUI:
 *
 *  - il soggiorno non e' concluso (il giorno del check-out conta come "in
 *    corso": l'ospite e' ancora sulla porta);
 *  - il check-in non e' completo;
 *  - il file per la Questura non e' mai stato generato — l'obbligo dell'art.
 *    109 T.U.L.P.S. e' a 24 ore e il ritardo non si recupera, quindi e'
 *    l'ultima cosa che deve poter sparire da sola.
 *
 * Lo stato della fattura NON entra in questo giudizio, ed e' una scelta:
 * la fattura vive su Fatture in Cloud, mentre l'archivio qui dice se il
 * fascicolo del check-in e' completo. Se entrasse, il giorno che il
 * collegamento con Fatture in Cloud si guasta franerebbe tutto dentro ADESSO
 * in una volta sola. Le fatture mancanti si vedono lo stesso: stanno nei
 * contatori in cima, che sono filtri e valgono su tutte e due le viste.
 */
export function classifica(p: PraticaArchiviabile, oggi: string): Vista {
  const conclusa = Boolean(p.checkout) && p.checkout < oggi
  if (!conclusa) return 'adesso'
  if (String(p.stato ?? '').trim().toUpperCase() !== 'CHECKIN OK') return 'adesso'
  if (!p.inviatoAlloggiati) return 'adesso'
  return 'archivio'
}

/** Il mese d'arrivo, 'aaaa-mm'. Vuoto se la data non si legge. */
export function mesePratica(p: PraticaArchiviabile): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(p.checkin ?? '').trim())
  return m ? `${m[1]}-${m[2]}` : ''
}

export interface MeseArchivio {
  /** 'aaaa-mm', oppure '' per le prenotazioni con la data illeggibile. */
  mese: string
  prenotazioni: number
  notti: number
  imposta: number
}

/**
 * L'indice dei mesi, dal piu' recente.
 *
 * Il raggruppamento e' per mese di ARRIVO. Va detto con precisione, perche' i
 * totali qui somigliano a una dichiarazione ma non lo sono: un soggiorno dal 29
 * settembre al 2 ottobre ha pernottamenti in due mesi, e finisce tutto in
 * settembre. Per la dichiarazione al Comune i pernottamenti andranno spezzati
 * sul mese in cui cadono davvero — quando si costruira' quella, non prima.
 * Questi numeri servono a orientarsi, non a compilare un modulo.
 */
export function indiceMesi(pratiche: PraticaArchiviabile[]): MeseArchivio[] {
  const per = new Map<string, PraticaArchiviabile[]>()
  for (const p of pratiche) {
    const m = mesePratica(p)
    per.set(m, [...(per.get(m) ?? []), p])
  }

  return [...per.entries()]
    .map(([mese, righe]) => ({
      mese,
      prenotazioni: righe.length,
      notti: righe.reduce((t, r) => t + numeroIt(r.notti), 0),
      imposta: sommaEuro(righe.map((r) => numeroIt(r.imposta))),
    }))
    .sort((a, b) => (a.mese < b.mese ? 1 : a.mese > b.mese ? -1 : 0))
}

export interface Numeri {
  inArrivo: number
  inCasa: number
  daCompletare: number
  daFatturare: number
  daInviare: number
  alloggiatiMancante: number
}

/**
 * I numeri in cima alla pagina.
 *
 * Si contano su TUTTE le prenotazioni, non su quelle della vista aperta: un
 * contatore che cambia perche' hai cambiato pagina non e' un contatore.
 *
 * `daFatturare` e `daInviare` restano separati apposta. Sono due gesti di due
 * persone diverse: la prima la deve preparare Cervellone, la seconda la deve
 * spedire l'Ingegnere da Fatture in Cloud. Sommarli direbbe "5 cose da fare"
 * senza dire di chi.
 */
export function contaNumeri(pratiche: PraticaArchiviabile[], oggi: string): Numeri {
  const n: Numeri = {
    inArrivo: 0, inCasa: 0, daCompletare: 0,
    daFatturare: 0, daInviare: 0, alloggiatiMancante: 0,
  }

  for (const p of pratiche) {
    if (p.checkin > oggi) n.inArrivo += 1
    else if (p.checkin <= oggi && p.checkout >= oggi) n.inCasa += 1

    if (String(p.stato ?? '').trim().toUpperCase() !== 'CHECKIN OK') n.daCompletare += 1
    if (!p.inviatoAlloggiati) n.alloggiatiMancante += 1
    if (p.statoFattura === 'DA FARE') n.daFatturare += 1
    if (p.statoFattura === 'COMPILATA') n.daInviare += 1
  }

  return n
}

/** Minuscolo e senza accenti: "Müller" si deve trovare scrivendo "muller". */
function normalizza(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    // Scritto in \u.... e non con i segni veri: sono caratteri invisibili, e
    // una riscrittura del file che li mangiasse lascerebbe la ricerca a
    // funzionare "quasi sempre" — cioe' a fallire solo sui nomi con accento.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

export interface Criteri {
  vista: Vista
  /** aaaa-mm-gg */
  oggi: string
  /** aaaa-mm */
  mese?: string
  unita?: string
  /** Nome, codice prenotazione o identificativo. */
  q?: string
  fattura?: StatoFattura
  /** Un adempimento che manca: nasce dal contatore in cima con lo stesso nome. */
  manca?: 'checkin' | 'questura'
}

/**
 * Cosa mostrare, dato quello che si sta guardando.
 *
 * Due filtri SCAVALCANO la vista, e non e' una svista:
 *
 *  - la **ricerca**: chi cerca un nome vuole quella prenotazione, non "quella
 *    prenotazione purche' sia nella meta' che stavi guardando". Una ricerca che
 *    risponde "nessun risultato" mentre la riga esiste e' peggio di nessuna
 *    ricerca — si conclude che il dato non c'e';
 *  - il filtro sulla **fattura**: nasce da un contatore in cima, e chi lo
 *    clicca vuole tutte quelle in quello stato.
 */
export function selezionaPratiche(
  pratiche: PraticaArchiviabile[],
  c: Criteri,
): PraticaArchiviabile[] {
  const q = normalizza(c.q ?? '')
  const scavalcaLaVista = Boolean(q) || Boolean(c.fattura) || Boolean(c.manca)

  return pratiche
    .filter((p) => scavalcaLaVista || classifica(p, c.oggi) === c.vista)
    .filter((p) => !c.mese || mesePratica(p) === c.mese)
    .filter((p) => !c.unita || p.unita === c.unita)
    .filter((p) => !c.fattura || p.statoFattura === c.fattura)
    .filter((p) => {
      if (c.manca === 'checkin') return String(p.stato ?? '').trim().toUpperCase() !== 'CHECKIN OK'
      if (c.manca === 'questura') return !p.inviatoAlloggiati
      return true
    })
    .filter((p) => !q || [p.intestatario, p.codPrenotazione, p.id, p.unita]
      .some((campo) => normalizza(campo).includes(q)))
    .sort((a, b) => (a.checkin < b.checkin ? 1 : a.checkin > b.checkin ? -1 : 0))
}
