/**
 * src/lib/checkin/imposta-soggiorno.ts
 *
 * Imposta di soggiorno del Comune di Maratea.
 * Fonte: Regolamento sull'Imposta di soggiorno, da ultimo modificato con
 * D.C.C. n. 03 del 24/02/2026 (letto integralmente il 24/08/2026).
 *
 * Due regole del regolamento che il calcolo di agosto (Codice.gs) non aveva:
 *
 *  - art. 5 lett. c) i minori sono esenti PER LEGGE. Nel form la data di nascita
 *    e' obbligatoria, quindi l'esenzione si DERIVA dai dati. Lasciarla a una
 *    casella da spuntare significa addebitare un bambino ogni volta che chi
 *    compila si distrae — e il totale resta plausibile, quindi non se ne accorge
 *    nessuno.
 *
 *  - art. 3 c.4) il gestore deve CONSERVARE la dichiarazione di esenzione. Un
 *    esente senza motivo scritto e' un ammanco in sede di controllo, quindi si
 *    segnala invece di accettarlo in silenzio.
 *
 * Le anomalie non sono errori: il calcolo restituisce comunque un importo. Ma
 * risalgono fino all'Ingegnere, perche' in questo sottosistema niente puo'
 * fallire in silenzio.
 */

/** Regole tariffarie. Tutte parametriche: cambiano per delibera, non per rilascio. */
export interface RegoleImposta {
  /** Euro per persona e per pernottamento (art. 4 c.1). */
  tariffa: number
  /** Pernottamenti addebitati per persona; oltre, esenti (art. 5 lett. a). */
  maxPernottamenti: number
  /** Eta' massima, in anni compiuti al check-in, per l'esenzione (art. 5 lett. c). */
  esenzioneEtaMax: number
  /** Inizio stagione, 'gg/mm'. */
  stagioneDal: string
  /** Fine stagione, 'gg/mm', inclusa. */
  stagioneAl: string
  /** Prima applicazione, 'gg/mm/aaaa'. Prima di questa data non si tassa. */
  inVigoreDal: string
}

/**
 * ⚠️ `esenzioneEtaMax: 12` e' la lettura adottata di "minori di eta' non
 * superiore al dodicesimo anno": esente fino a 12 anni compiuti, pagante da 13.
 * La formula ammette anche la lettura piu' stretta (esente fino all'11).
 * DA CONFERMARE all'Ufficio Entrate e Tributi del Comune (0973 874111).
 * Non e' una decisione tecnica: e' denaro di terzi.
 */
export const REGOLE_MARATEA: RegoleImposta = {
  tariffa: 2.5,
  maxPernottamenti: 5,
  esenzioneEtaMax: 12,
  stagioneDal: '01/05',
  stagioneAl: '31/10',
  inVigoreDal: '01/05/2026',
}

export interface OspiteImposta {
  /** 'aaaa-mm-gg'. Vuota = non verificabile: si addebita e si segnala. */
  dataNascita: string
  /** Esenzione dichiarata a mano (art. 5 lett. d-j). */
  esente: boolean
  motivoEsenzione?: string
}

export interface EsitoImposta {
  importo: number
  notti: number
  /** Pernottamenti effettivamente tassati, sommati su tutti gli ospiti. */
  pernottamentiTassati: number
  /** Chi non paga e perche'. `indice` e' la posizione nell'array ospiti. */
  esenti: Array<{ indice: number; motivo: string }>
  /** Cose che l'Ingegnere deve sapere: non bloccano il calcolo. */
  anomalie: string[]
}

const MS_GIORNO = 86_400_000

/** 'aaaa-mm-gg' -> Date a mezzanotte UTC. Null se non interpretabile. */
function dataISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return isNaN(d.getTime()) ? null : d
}

/** 'gg/mm/aaaa' -> Date a mezzanotte UTC. */
function dataIT(s: string): Date | null {
  const p = String(s || '').trim().split('/')
  if (p.length !== 3) return null
  const d = new Date(Date.UTC(Number(p[2]), Number(p[1]) - 1, Number(p[0])))
  return isNaN(d.getTime()) ? null : d
}

/** Anni compiuti a una data di riferimento. */
function anniCompiuti(nascita: Date, riferimento: Date): number {
  let anni = riferimento.getUTCFullYear() - nascita.getUTCFullYear()
  const meseDiff = riferimento.getUTCMonth() - nascita.getUTCMonth()
  if (meseDiff < 0 || (meseDiff === 0 && riferimento.getUTCDate() < nascita.getUTCDate())) anni--
  return anni
}

/** La notte del `giorno` ricade nel periodo di applicazione? */
function notteInStagione(giorno: Date, regole: RegoleImposta): boolean {
  const vigore = dataIT(regole.inVigoreDal)
  if (vigore && giorno < vigore) return false

  const [gDal, mDal] = regole.stagioneDal.split('/').map(Number)
  const [gAl, mAl] = regole.stagioneAl.split('/').map(Number)
  const anno = giorno.getUTCFullYear()
  const dal = new Date(Date.UTC(anno, mDal - 1, gDal))
  const al = new Date(Date.UTC(anno, mAl - 1, gAl, 23, 59, 59))
  return giorno >= dal && giorno <= al
}

export function calcolaImpostaSoggiorno(params: {
  checkin: string
  checkout: string
  ospiti: OspiteImposta[]
  regole: RegoleImposta
}): EsitoImposta {
  const { ospiti, regole } = params
  const anomalie: string[] = []
  const esenti: Array<{ indice: number; motivo: string }> = []

  const ci = dataISO(params.checkin)
  const co = dataISO(params.checkout)
  if (!ci || !co) {
    anomalie.push('Date di soggiorno mancanti o non valide.')
    return { importo: 0, notti: 0, pernottamentiTassati: 0, esenti, anomalie }
  }

  let notti = Math.round((co.getTime() - ci.getTime()) / MS_GIORNO)
  if (notti < 0) {
    anomalie.push('Check-out precedente al check-in.')
    notti = 0
  }

  // Art. 5 lett. a): oltre il quinto pernottamento consecutivo si e' esenti.
  const daConteggiare = Math.min(notti, regole.maxPernottamenti)

  // Quante di quelle notti ricadono nel periodo di applicazione.
  let nottiTassabili = 0
  for (let i = 0; i < daConteggiare; i++) {
    if (notteInStagione(new Date(ci.getTime() + i * MS_GIORNO), regole)) nottiTassabili++
  }

  let paganti = 0
  ospiti.forEach((o, i) => {
    const etichetta = `Ospite ${i + 1}`

    if (o.esente) {
      const motivo = String(o.motivoEsenzione || '').trim()
      if (!motivo) anomalie.push(`${etichetta}: esenzione senza motivo dichiarato (art. 3 c.4).`)
      esenti.push({ indice: i, motivo: motivo || 'esenzione dichiarata senza motivo' })
      return
    }

    const nascita = dataISO(o.dataNascita)
    if (!nascita) {
      // Nel dubbio si addebita: un ospite non conteggiato e' imposta non
      // versata, e chi ne risponde e' il gestore (art. 3 c.3).
      anomalie.push(`${etichetta}: data di nascita mancante, esenzione per eta non verificabile.`)
      paganti++
      return
    }

    if (anniCompiuti(nascita, ci) <= regole.esenzioneEtaMax) {
      esenti.push({ indice: i, motivo: 'minore (art. 5 lett. c)' })
      return
    }

    paganti++
  })

  const pernottamentiTassati = nottiTassabili * paganti
  const importo = Math.round(regole.tariffa * pernottamentiTassati * 100) / 100

  return { importo, notti, pernottamentiTassati, esenti, anomalie }
}
