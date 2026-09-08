/**
 * La conversione HTML → testo piatto usata da `salva_documento_su_drive` per i
 * Google Doc.
 *
 * Estratta e messa sotto test l'8 settembre 2026 per un motivo preciso: la
 * regex che toglie i tag faceva SPARIRE le immagini. Non le lasciava come URL
 * rotto — le cancellava, e il documento consegnato non diceva che mancava
 * qualcosa. Su un tool che il prompt raccomanda per POS, preventivi e perizie.
 *
 * Un Google Doc creato con `insertText` non puo' contenere immagini: quello che
 * si puo' fare e' non farle sparire in silenzio. Resta una riga che dice dov'era
 * la foto e quale, e chi consegna il documento viene avvisato.
 */
import { immaginiDriveNellHtml } from './pdf-generator'

export type TestoPiatto = {
  testo: string
  /** Id (o URL) delle immagini che il Google Doc non puo' contenere. */
  immagini: string[]
}

export function htmlInTestoPiatto(htmlContent: string): TestoPiatto {
  const immagini = immaginiDriveNellHtml(htmlContent)

  /*
    Il segnaposto vale per OGNI immagine, non solo per quelle di Drive: un
    `<img>` che punta altrove veniva cancellato in silenzio, ed era meta' del
    difetto che questo modulo doveva chiudere.

    E l'identificativo si prende dal tag stesso, non da `immagini[i-1]`:
    `immaginiDriveNellHtml` DEDUPLICA per id, il contatore no, e con la stessa
    foto richiamata due volte usciva "[Foto 2 — ...: ]" con l'id vuoto.
  */
  let i = 0
  const conSegnaposto = htmlContent.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const indirizzo = src ? (src[1] ?? src[2] ?? src[3] ?? '') : ''
    const eDrive = /drive\.google\.com|googleusercontent\.com/i.test(indirizzo)
    const quale = eDrive ? (estraiIdDrive(indirizzo) ?? indirizzo) : indirizzo
    return `\n[Foto ${++i} — non inseribile in un Google Doc${quale ? `: ${quale}` : ''}]\n`
  })

  const testo = conSegnaposto
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { testo, immagini }
}

/** L'id Drive da un URL, o null. Stessa logica del generatore documenti. */
function estraiIdDrive(url: string): string | null {
  const pulito = url.replace(/&(?:amp|#38);/gi, '&')
  for (const re of [/[?&]id=([a-zA-Z0-9_-]{10,})/, /\/d\/([a-zA-Z0-9_-]{10,})/]) {
    const m = pulito.match(re)
    if (m) return m[1]
  }
  return null
}
