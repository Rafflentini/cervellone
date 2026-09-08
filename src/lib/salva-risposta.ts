/**
 * src/lib/salva-risposta.ts — la risposta del turno finisce in `messages`.
 *
 * Una regola sola per i due canali, perche' ce n'erano tre copie divergenti e
 * quella di Telegram sbagliava in quattro modi (nessuna attesa, embedding nella
 * stessa promessa, `.catch` su una funzione che non rigetta mai, nessun
 * timestamp).
 *
 * Le due cose che questa funzione garantisce:
 * - si ASPETTA che la riga arrivi, ma con un tetto: su serverless quel che parte
 *   dopo la chiusura della risposta non e' garantito che arrivi in fondo, e un
 *   Supabase lento non deve tenere appeso il turno. Scaduto il tetto, la
 *   scrittura prosegue in `waitUntil`.
 * - l'embedding e' una chiamata SEPARATA e solo se la riga e' entrata davvero:
 *   un embedding senza il suo messaggio resta recuperabile da `searchMemory`
 *   senza niente a cui appartenere.
 */
import { saveMessageOnly, saveEmbeddingOnly } from './memory'
import { conTetto } from './tetto-attesa'
import { waitUntil } from '@vercel/functions'

/** Quanto si aspetta la scrittura prima di passarla allo sfondo. */
export const ATTESA_MASSIMA_SCRITTURA_MS = 5_000

export async function salvaRispostaTurno(opzioni: {
  conversationId: string
  testo: string
  /**
   * Turno non consegnato (errore API, turno muto, budget esaurito). Entra nella
   * STORIA — l'Ingegnere l'ha letto, e senza il modello rifarebbe da capo il
   * lavoro parziale — ma NON nella memoria semantica: un "non sono riuscito a
   * sintetizzare" supera la soglia di embedding e diventerebbe recuperabile
   * come se fosse conoscenza.
   */
  turnoFallito: boolean
  /**
   * Istante da attribuire alla riga: l'inizio del turno, non quello della
   * scrittura. Se la connessione e' caduta e il server finisce molto dopo, la
   * riga si infilerebbe DOPO la domanda successiva — nella conversazione e nel
   * contesto del modello.
   */
  istante: string
  /** Solo per i log: 'chat' o 'tg'. */
  tag: string
}): Promise<void> {
  const { conversationId, testo, turnoFallito, istante, tag } = opzioni
  if (!conversationId || !testo.trim()) return

  const scrittura = saveMessageOnly(conversationId, 'assistant', testo, istante)
  const salvato = await conTetto(scrittura, ATTESA_MASSIMA_SCRITTURA_MS, 'in-corso' as const)
  if (salvato === 'in-corso') {
    console.warn(`[${tag}] scrittura lenta: prosegue in background`)
    waitUntil(scrittura)
  } else if (salvato === false) {
    console.error(`[${tag}] RISPOSTA NON SALVATA: la riga non e' finita in messages`)
  }

  if (!turnoFallito && salvato === true) {
    waitUntil(saveEmbeddingOnly(conversationId, 'assistant', testo).catch(() => {}))
  }
}
