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

  let i = 0
  const conSegnaposto = htmlContent.replace(
    /<img\b[^>]*>/gi,
    (tag) => (/drive\.google\.com|googleusercontent\.com/i.test(tag)
      ? `\n[Foto ${++i} — non inseribile in un Google Doc: ${immagini[i - 1] ?? ''}]\n`
      : ''),
  )

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
