/**
 * src/lib/checkin/avvisi.ts
 *
 * I messaggi che partono quando si apre una prenotazione: all'ospite, perche'
 * compili, e a chi consegna le chiavi, perche' sappia chi arriva.
 *
 * Due destinatari, due strade diverse, e non per scelta tecnica:
 *  - all'OSPITE si puo' scrivere per email, perche' un indirizzo lo lascia
 *    quasi sempre; il pulsante WhatsApp resta comunque;
 *  - a chi CONSEGNA LE CHIAVI si scrive solo su WhatsApp: quelle ragazze una
 *    casella di posta non ce l'hanno.
 *
 * Perche' l'email e non WhatsApp automatico: mandare messaggi WhatsApp da un programma
 * richiede le API ufficiali di Meta — account business verificato, numero
 * dedicato, modelli di messaggio approvati in anticipo. E' una pratica di
 * settimane, non una riga di codice. L'email invece Cervellone la manda gia'
 * oggi, senza autorizzazioni e senza costi.
 *
 * Il link su WhatsApp resta, ma come GESTO: un pulsante che apre la chat gia'
 * con la persona giusta e il messaggio scritto. Un tocco, e nessun rischio di
 * mandarlo al contatto sbagliato.
 *
 * ⚠️ Un avviso che non parte non deve MAI far fallire la creazione della
 * prenotazione. La prenotazione e' il dato; l'avviso e' una cortesia.
 */

import { sendEmailWithAttachments } from '@/v19/tools/email'

/** 'aaaa-mm-gg' -> 'gg/mm/aaaa'. */
function gg(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '—')
}

/** Solo cifre: WhatsApp vuole il numero senza spazi, punti o parentesi. */
export function numeroPerWhatsApp(telefono: string): string {
  const n = String(telefono || '').replace(/\D/g, '')
  if (!n) return ''
  // Un numero italiano scritto senza prefisso comincia per 3 ed e' di 10 cifre.
  if (n.length === 10 && n.startsWith('3')) return `39${n}`
  return n
}

/**
 * Il collegamento che apre WhatsApp gia' sulla persona giusta.
 * Senza numero apre comunque, chiedendo a chi mandarlo: meglio di niente.
 */
export function linkWhatsApp(telefono: string, testo: string): string {
  const n = numeroPerWhatsApp(telefono)
  return `https://wa.me/${n}?text=${encodeURIComponent(testo)}`
}

export function messaggioOspite(p: { link: string; unita: string; checkin: string }): string {
  return [
    'Buongiorno, siamo LA REAL ESTATE.',
    `Per il vostro soggiorno in ${p.unita} dal ${gg(p.checkin)} le chiediamo di completare`,
    'il check-in a questo collegamento — servono i dati per la Questura, come da obbligo di legge:',
    p.link,
    '',
    'Puo compilare anche per gli altri ospiti, oppure mandare a ciascuno il proprio collegamento',
    'direttamente dalla pagina. Grazie.',
  ].join('\n')
}

export function messaggioConsegnaChiavi(p: {
  linkGestione: string
  unita: string
  checkin: string
  checkout: string
  ospiti: number
  intestatario: string
}): string {
  return [
    `Nuova prenotazione: ${p.unita}, dal ${gg(p.checkin)} al ${gg(p.checkout)}.`,
    `${p.intestatario || 'Nome non indicato'} — ${p.ospiti} ${p.ospiti === 1 ? 'ospite' : 'ospiti'}.`,
    '',
    'Qui vedi tutte le prenotazioni e cosa manca a ciascuna, e da qui puoi completare',
    'i dati mancanti al momento della consegna delle chiavi:',
    p.linkGestione,
  ].join('\n')
}

/**
 * Chi consegna le chiavi: nome e numero, presi dal Config.
 *
 * Le ragazze che fanno la consegna NON hanno un indirizzo email — l'ha detto
 * l'Ingegnere, e vale piu' di qualunque comodita' di implementazione: un
 * avviso spedito a un indirizzo che non esiste non e' un avviso, e' un
 * passaggio che sembra fatto. A loro si scrive su WhatsApp, e basta.
 *
 * Nel Config i valori si scrivono separati da "|", nomi e numeri nello stesso
 * ordine. Se uno dei due elenchi e' piu' corto, la parte che manca resta vuota
 * invece di far slittare l'accoppiamento — che vorrebbe dire il messaggio di
 * una persona mandato al numero di un'altra.
 */
export interface ConsegnaChiavi {
  nome: string
  telefono: string
}

export function chiConsegnaLeChiavi(nomi: string, telefoni: string): ConsegnaChiavi[] {
  const taglia = (s: string) =>
    String(s || '').split('|').map((v) => v.trim()).filter((v) => v.length > 0)
  const n = taglia(nomi)
  const t = taglia(telefoni)
  const quante = Math.max(n.length, t.length)
  return Array.from({ length: quante }, (_, i) => ({
    nome: n[i] ?? '',
    telefono: t[i] ?? '',
  }))
}

export interface EsitoAvvisi {
  ospite: 'inviata' | 'senza indirizzo' | 'non riuscita'
}

/**
 * Manda le email, se gli indirizzi ci sono.
 *
 * Non lancia MAI: restituisce cosa e' successo. Chi la chiama sta creando una
 * prenotazione, e una prenotazione creata con l'avviso non partito e' molto
 * meglio di una prenotazione non creata.
 */
export async function inviaAvvisi(p: {
  emailOspite: string
  testoOspite: string
  oggettoOspite: string
}): Promise<EsitoAvvisi> {
  const manda = async (a: string, oggetto: string, testo: string) => {
    if (!a.trim()) return 'senza indirizzo' as const
    try {
      await sendEmailWithAttachments({
        from_account: 'info',
        to: [a.trim()],
        subject: oggetto,
        body_text: testo,
        auto_send_if_internal: true,
      })
      return 'inviata' as const
    } catch (err) {
      // Nel log l'esito, non il contenuto: dentro c'e' il nome di un ospite.
      console.error('[CHECKIN] avviso non inviato:', err instanceof Error ? err.message : 'errore')
      return 'non riuscita' as const
    }
  }

  return { ospite: await manda(p.emailOspite, p.oggettoOspite, p.testoOspite) }
}
