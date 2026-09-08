/**
 * Quel poco che serve sapere di un'immagine per infilarla in un .docx senza
 * rovinarla: quanto e' grande davvero, e come va dichiarata.
 *
 * Nasce da due difetti dell'8 settembre 2026, trovati dall'audit sul commit
 * stesso che aggiungeva le foto ai Word:
 *
 * - ogni foto veniva messa a 480x360 fissi. Le foto di cantiere scattate col
 *   telefono sono in larga parte VERTICALI: uscivano tutte schiacciate.
 * - ogni foto veniva dichiarata 'jpg'. Un WEBP (formato che la chat accetta) o
 *   un HEIC dall'iPhone finiva nel Word come immagine rotta, e il tool
 *   rispondeva "salvato" senza avvisi, perche' il download era riuscito.
 */

export type Dimensioni = { larghezza: number; altezza: number }

/**
 * Legge larghezza e altezza dai byte, senza decodificare l'immagine.
 * `null` se il formato non e' fra quelli che sappiamo leggere: meglio non
 * saperlo che inventare una proporzione.
 */
export function dimensioniImmagine(byte: Buffer): Dimensioni | null {
  // PNG: firma di 8 byte, poi IHDR con larghezza e altezza a offset 16 e 20.
  if (byte.length >= 24 && byte.readUInt32BE(0) === 0x89504e47) {
    return { larghezza: byte.readUInt32BE(16), altezza: byte.readUInt32BE(20) }
  }

  // JPEG: si scorrono i segmenti fino a un SOF, che porta altezza e larghezza.
  if (byte.length >= 4 && byte.readUInt16BE(0) === 0xffd8) {
    let i = 2
    while (i + 9 < byte.length) {
      if (byte[i] !== 0xff) { i++; continue }
      const marker = byte.readUInt16BE(i)
      // SOF0..SOF15, saltando DHT (c4), JPG (c8) e DAC (cc) che non sono SOF.
      const eSof = marker >= 0xffc0 && marker <= 0xffcf
        && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc
      if (eSof) {
        return { altezza: byte.readUInt16BE(i + 5), larghezza: byte.readUInt16BE(i + 7) }
      }
      const lunghezza = byte.readUInt16BE(i + 2)
      if (lunghezza < 2) return null
      i += 2 + lunghezza
    }
  }

  return null
}

/**
 * Il tipo che `docx` sa mettere dentro un Word. `null` per tutto il resto: chi
 * chiama deve trattarlo come immagine NON inserita e dirlo, invece di
 * impacchettare byte WEBP dentro una parte dichiarata JPEG.
 */
export function estensioneDocx(mimeType: string): 'jpg' | 'png' | 'gif' | 'bmp' | null {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/bmp':
      return 'bmp'
    default:
      return null
  }
}

/** Riquadro massimo di una foto su A4 con i margini, in punti. */
export const LARGHEZZA_MAX_DOCX = 480
export const ALTEZZA_MAX_DOCX = 620

/**
 * Scala mantenendo le proporzioni, dentro il riquadro. Senza dimensioni note si
 * ripiega su un 4:3 orizzontale, che e' l'assunzione meno dannosa quando non si
 * sa nulla.
 */
export function riquadroDocx(dim: Dimensioni | null): Dimensioni {
  if (!dim || dim.larghezza <= 0 || dim.altezza <= 0) {
    return { larghezza: LARGHEZZA_MAX_DOCX, altezza: Math.round(LARGHEZZA_MAX_DOCX * 0.75) }
  }
  const scala = Math.min(
    LARGHEZZA_MAX_DOCX / dim.larghezza,
    ALTEZZA_MAX_DOCX / dim.altezza,
    1,
  )
  return {
    larghezza: Math.max(1, Math.round(dim.larghezza * scala)),
    altezza: Math.max(1, Math.round(dim.altezza * scala)),
  }
}

/** Cosa mettere nel documento al posto di ciascuna immagine richiamata. */
export type VoceAllegato =
  | { tipo: 'foto'; indice: number; byte: Buffer; formato: 'jpg' | 'png' | 'gif' | 'bmp' }
  | { tipo: 'assente'; indice: number; id: string }

/**
 * La sequenza dell'allegato fotografico, nell'ordine del documento.
 *
 * Una foto che non si e' potuta scaricare NON viene saltata: lascia il suo
 * posto occupato da una voce 'assente'. Prima le riuscite venivano accodate e
 * basta, quindi se la seconda di sei falliva la terza scivolava al secondo
 * posto: nella perizia consegnata al committente la foto del balcone finiva
 * sotto la didascalia del cornicione.
 *
 * Un documento che attribuisce la foto sbagliata al degrado sbagliato e' peggio
 * di un documento senza foto.
 */
export function pianificaAllegato(
  idImmagini: string[],
  scaricate: Array<{ byte: Buffer; tipo: 'jpg' | 'png' | 'gif' | 'bmp' } | null>,
): VoceAllegato[] {
  return idImmagini.map((id, i) => {
    const s = scaricate[i]
    return s
      ? { tipo: 'foto' as const, indice: i, byte: s.byte, formato: s.tipo }
      : { tipo: 'assente' as const, indice: i, id }
  })
}

/**
 * Il formato si vede in un PDF stampato da Chromium?
 *
 * HEIC (le foto dell'iPhone) e TIFF non li decodifica: incorporarli lascerebbe
 * un riquadro vuoto nel documento senza che nessuno lo dica, perche' il
 * download da Drive E' riuscito. WebP e AVIF invece li mostra.
 */
export function formatoStampabile(mimeType: string): boolean {
  return ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']
    .includes((mimeType || '').toLowerCase())
}
