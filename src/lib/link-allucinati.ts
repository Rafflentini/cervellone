/**
 * src/lib/link-allucinati.ts — «ecco il file, lo trova qui» su un id inventato.
 *
 * La guardia stava dentro `agent-job.ts`, cioe' solo sul canale Telegram: sulla
 * chat web la difesa era testo nel system prompt e nient'altro. Ma `extractDriveUrls`
 * lavora su testo: non c'e' niente di specifico del canale. L'Ingegnere dalla
 * chat web si sentiva dire «ho salvato il POS qui: drive.google.com/file/d/...»,
 * cliccava, prendeva un 404, e non aveva modo di sapere se il file c'e' con un
 * altro nome o non c'e' affatto.
 *
 * ⭐ Il commento originale diceva che il validatore era cablato solo in
 * `v19/agent/loop.ts`, «che non e' il path di produzione». La correzione lo
 * cablo' su Telegram e lascio' fuori l'ALTRO path di produzione: la route web.
 */
import { runHallucinationValidator, extractDriveUrls } from '@/v19/agent/hallucination-validator'
import { HallucinationError } from '@/v19/agent/types'

/**
 * Politica deliberata: NON si blocca e NON si ri-prompta. Un re-prompt
 * automatico su un turno gia completato rischia loop e costi; un blocco farebbe
 * sparire una risposta magari corretta al 95%. Si avvisa e basta.
 */
const HALLUCINATION_CHECK_TIMEOUT_MS = 8_000

const HALLUCINATION_WARNING =
  '⚠️ Attenzione: un link a un file Drive citato in questo messaggio non risulta esistente. ' +
  'Non fidarti di quel link.'

const CHECK_TIMED_OUT = Symbol('hallucination-check-timeout')

/**
 * Ritorna il testo da inviare, con l'avviso in testa se un link Drive citato
 * non esiste. Non lancia MAI: la verifica non può far fallire il turno.
 *
 * Perché l'avviso va IN TESTA e non in coda: sopra i 4000 caratteri il testo
 * viene spezzato (edit del placeholder + messaggi successivi). In coda l'avviso
 * finirebbe nell'ultimo spezzone di una cascata che l'utente spesso non scorre;
 * in testa è nel messaggio principale, quello che legge di sicuro.
 */
export async function annotateHallucinatedLinks(text: string): Promise<string> {
  // Costo ZERO senza link Drive: niente timer, niente import, niente rete.
  if (extractDriveUrls(text).length === 0) return text

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Normalizzata a un valore risolto: così una reject tardiva (dopo il
    // timeout) non diventa una unhandled rejection.
    const validation: Promise<unknown> = runHallucinationValidator(text).then(
      () => null,
      (err: unknown) => err,
    )
    const timeout = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(CHECK_TIMED_OUT), HALLUCINATION_CHECK_TIMEOUT_MS)
    })

    const outcome = await Promise.race([validation, timeout])

    if (outcome === CHECK_TIMED_OUT) {
      // maxDuration è 800s ma il turno ha già consumato tempo: meglio un
      // messaggio senza avviso che un turno scaduto.
      console.warn('[link-allucinati] hallucination check: timeout, invio senza verifica')
      return text
    }
    if (outcome instanceof HallucinationError) {
      console.error('[link-allucinati] link Drive ALLUCINATO nella risposta:', outcome.url)
      return `${HALLUCINATION_WARNING}\n\n${text}`
    }
    if (outcome) {
      console.warn('[link-allucinati] hallucination check non concluso (ignorato):', outcome)
    }
    return text
  } catch (err) {
    console.warn('[link-allucinati] hallucination check: errore inatteso (ignorato):', err)
    return text
  } finally {
    if (timer) clearTimeout(timer)
  }
}
