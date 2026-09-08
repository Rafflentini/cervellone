/**
 * src/lib/compressione-documenti.ts — i documenti vecchi si accorciano, l'ultimo no.
 *
 * Un blocco `~~~document` porta l'HTML intero: dieci preventivi in una
 * conversazione riempiono il contesto di roba gia' consegnata. Ma l'ULTIMO e'
 * proprio quello su cui si sta lavorando: schiacciare anche quello significa
 * che «togli la voce ponteggi e rifai il totale» arriva a un modello che il
 * documento non ce l'ha piu'.
 *
 * La regola stava su Telegram e nel client web. Il SERVER web faceva l'opposto
 * — comprimeva tutti, ultimo compreso, con uno stub che non conservava nemmeno
 * il titolo — quindi disfaceva la cura del suo stesso client. Qui sta scritta
 * una volta sola.
 */

const RE_DOCUMENTO = /~~~document\n[\s\S]*?~~~(?:\n|$)/g
const TAGLIO = 3000

export interface MessaggioStoria {
  role: string
  content: unknown
}

/** Accorcia un blocco documento tenendo il titolo, cosi' resta riconoscibile. */
export function comprimiBloccoDocumento(blocco: string): string {
  if (blocco.length <= TAGLIO) return blocco
  const titolo = blocco.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim().slice(0, 80) ?? 'senza titolo'
  const testa = blocco.slice(0, TAGLIO)
  const restanti = blocco.length - TAGLIO
  return `${testa}\n[...documento "${titolo}" troncato — ${restanti} char omessi per economia di contesto]\n~~~\n`
}

/**
 * Comprime in-place i documenti della storia, TRANNE l'ultimo.
 * Guarda solo i messaggi `assistant` con contenuto testuale: un `~~~document`
 * scritto dall'Ingegnere non e' un documento generato.
 */
export function comprimiDocumentiNellaStoria(storia: MessaggioStoria[]): void {
  let ultimo = -1
  for (let i = storia.length - 1; i >= 0; i--) {
    const m = storia[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('~~~document')) {
      ultimo = i
      break
    }
  }
  for (let i = 0; i < storia.length; i++) {
    const m = storia[i]
    if (i === ultimo) continue
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue
    m.content = m.content.replace(RE_DOCUMENTO, (blocco) => comprimiBloccoDocumento(blocco))
  }
}
