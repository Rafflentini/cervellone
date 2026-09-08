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

export type TestoPiatto = {
  testo: string
  /** Id (o URL) delle immagini che il Google Doc non puo' contenere. */
  immagini: string[]
}

export function htmlInTestoPiatto(htmlContent: string): TestoPiatto {
  /*
    Un segnaposto per OGNI immagine, e la LISTA che ne tiene il conto esatto.

    Prima i segnaposto erano su ogni `<img>` mentre `immagini` conteneva solo le
    Drive, deduplicate: chi leggeva il Google Doc contava due buchi e il bot ne
    dichiarava uno. Il numero di cose che mancano non e' un dettaglio di forma.

    L'identificativo si prende dal tag: `immaginiDriveNellHtml` deduplica, il
    contatore no, e con la stessa foto richiamata due volte usciva
    "[Foto 2 — ...: ]" con l'id vuoto.
  */
  const immagini: string[] = []
  const conSegnaposto = htmlContent.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const indirizzo = src ? (src[1] ?? src[2] ?? src[3] ?? '') : ''
    immagini.push(descriviImmagine(indirizzo))
    return `\n[Foto ${immagini.length} — non inseribile in un Google Doc${
      immagini[immagini.length - 1] ? `: ${immagini[immagini.length - 1]}` : ''
    }]\n`
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

/**
 * Come chiamare un'immagine nel segnaposto, in poche parole.
 *
 * Un data URI e' GIA' l'immagine: stamparlo riversava migliaia di caratteri di
 * base64 nel Google Doc consegnato al committente. Un URL lunghissimo idem.
 * Qui si dice quanto basta a ritrovarla, non di piu'.
 */
function descriviImmagine(indirizzo: string): string {
  if (!indirizzo) return ''
  if (/^data:/i.test(indirizzo)) return 'immagine incorporata nel documento'
  const id = estraiIdDrive(indirizzo)
  if (id) return id
  return indirizzo.length > 80 ? `${indirizzo.slice(0, 77)}…` : indirizzo
}
