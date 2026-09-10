/**
 * src/lib/conferma-fic.ts — «confermo», «procedi», «vai» sulle bozze FIC.
 *
 * Il 10 set 2026 l'Ingegnere era da cellulare e doveva emettere il saldo SAL
 * n.1 del Condominio Fermi. La bozza si sbloccava solo con `/fic_ok_<uuid>` e
 * `/fic_ok2_<uuid>`: ha scritto «confermo», «procedi», «Confermato a procedi
 * compila» — tre volte — e ogni volta la riga e' rimasta a `conferme: 1`,
 * perche' il dispatch legge SOLO il comando. Il documento non e' nato.
 *
 * Qui la conferma si puo' dire a parole. Ma la doppia conferma NON viene
 * indebolita: restano DUE passaggi, e la creazione di un documento contabile
 * resta legata a cio' che l'Ingegnere ha DAVVERO scritto o dettato — non a
 * un'interpretazione del modello, che potrebbe confermare da se'.
 *
 * Stessa forma di `conferma-invio.ts` per le mail: la regola sta scritta una
 * volta sola, e vale su tutti i canali che la importano.
 */

import { supabase } from './supabase'
import { getSocieta, type CodiceSocieta } from './societa'
import { confirmFicStep1, confirmFicStep2 } from './fic-write-tools'

/**
 * Oltre questa finestra una bozza non e' piu' «quella di cui stiamo
 * parlando». Serve contro il caso peggiore: un «ok» detto domani, a proposito
 * di altro, che risveglia la bozza dimenticata di oggi e crea una fattura.
 */
const FINESTRA_MS = 60 * 60 * 1000

/**
 * Ripara gli artefatti tipici della dettatura, e solo quelli.
 * «con fermo» → «confermo»; «pro cedi» → «procedi».
 */
export function normalizzaPerConfermaFic(testo: string): string {
  return testo
    .trim()
    .replace(/\bcon\s+fermo\b/gi, 'confermo')
    .replace(/\bpro\s+cedi\b/gi, 'procedi')
    .replace(/\bva\s+bene\b/gi, 'vabene')
}

/**
 * Vera SOLO per una frase-conferma SECCA, ancorata a inizio e fine stringa.
 *
 * «ok» da solo conferma; «ok, allora rifai la riga» no, perche' c'e' altro
 * testo — ed e' proprio quella la differenza fra un assenso e un'istruzione
 * nuova. Nessuna scorciatoia su frasi lunghe: qui in fondo nasce una fattura.
 */
const RE_CONFERMA_FIC =
  /^\s*(s[iì])?[,.\s]*(conferm[oai]|confermato|confermiamo|procedi|procediamo|proceda|vai|vabene|ok(ay)?|d'?\s*accordo)([,.\s]+(pure|tu|adesso|ora|cosi|così|grazie))*\s*[.!…]*\s*$/i

export function eConfermaFic(testo: string): boolean {
  return RE_CONFERMA_FIC.test(normalizzaPerConfermaFic(testo))
}

interface RigaPending {
  id: string
  conferme: number
  descrizione: string | null
  created_at: string
}

export interface EsitoConfermaFic {
  /** false = non era una conferma per una bozza FIC: il messaggio va al modello. */
  intercettato: boolean
  message: string
}

const NON_INTERCETTATO: EsitoConfermaFic = { intercettato: false, message: '' }

function primaRiga(descrizione: string | null): string {
  if (!descrizione) return 'bozza senza descrizione'
  const righe = descrizione.split('\n').filter(Boolean)
  const cliente = righe.find((r) => r.startsWith('Cliente:'))
  const totale = righe.find((r) => r.startsWith('Totale netto:'))
  return [righe[0], cliente, totale].filter(Boolean).join(' — ')
}

/**
 * Avanza di UN passo la bozza FIC in attesa della societa indicata.
 *
 * Non decide niente al posto dell'Ingegnere: se le bozze in attesa sono piu'
 * di una NON si indovina quale documento fiscale creare — si elencano e si
 * chiede. E se non ce n'e' nessuna recente non si intercetta nulla, cosi' un
 * «ok» generico continua ad arrivare al modello come prima.
 */
export async function confermaFicPiuRecente(societa: CodiceSocieta): Promise<EsitoConfermaFic> {
  const dal = new Date(Date.now() - FINESTRA_MS).toISOString()

  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .select('id, conferme, descrizione, created_at')
    .eq('societa', societa)
    .eq('stato', 'in_attesa')
    .gte('created_at', dal)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    // Il database non risponde: NON si intercetta. Meglio che la frase arrivi
    // al modello che una conferma persa in silenzio.
    console.error('[CONFERMA-FIC] lettura pending fallita:', error.message)
    return NON_INTERCETTATO
  }

  const righe = (data ?? []) as RigaPending[]
  if (righe.length === 0) return NON_INTERCETTATO

  if (righe.length > 1) {
    const elenco = righe
      .map((r) => `• ${primaRiga(r.descrizione)}\n  → /fic_ok_${r.id}`)
      .join('\n')
    return {
      intercettato: true,
      message:
        `⚠️ Ci sono *${righe.length} bozze in attesa*: non indovino quale documento creare.\n\n${elenco}\n\n`
        + 'Mi dica quale, oppure tocchi il comando della bozza giusta.',
    }
  }

  const riga = righe[0]
  const conferme = Number(riga.conferme)
  const s = getSocieta(societa)

  if (conferme >= 2) {
    return {
      intercettato: true,
      message: '⏳ Questa bozza è già in elaborazione su Fatture in Cloud: attenda l\'esito, non la ritento.',
    }
  }

  if (conferme === 0) {
    const message = await confirmFicStep1(riga.id)
    // Se il primo passaggio non e' andato a buon fine il testo va riportato
    // com'e': non si finge di aver registrato niente.
    if (!message.includes('/fic_ok2_')) return { intercettato: true, message }
    return {
      intercettato: true,
      message:
        `${message}\n\n⚠️ *Conferma DEFINITIVA*: creo il documento su Fatture in Cloud per `
        + `*${s.denominazione}*? Mi risponda «confermo» un'ultima volta.`,
    }
  }

  return { intercettato: true, message: await confirmFicStep2(riga.id) }
}
