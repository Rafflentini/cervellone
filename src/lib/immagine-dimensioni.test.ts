import { describe, test, it, expect } from 'vitest'
import {
  dimensioniImmagine, estensioneDocx, riquadroDocx, pianificaAllegato, formatoStampabile,
} from './immagine-dimensioni'

/** JPEG minimo con un SOF0 che dichiara 1200x1600 (verticale, come le foto da telefono). */
function jpegFinto(larghezza: number, altezza: number): Buffer {
  const h = Buffer.from([0xff, 0xd8]) // SOI
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)   // marker SOF0
  sof.writeUInt16BE(9, 2)        // lunghezza segmento
  sof.writeUInt8(8, 4)           // precisione
  sof.writeUInt16BE(altezza, 5)
  sof.writeUInt16BE(larghezza, 7)
  return Buffer.concat([h, sof])
}

/** PNG minimo: firma + IHDR con larghezza/altezza. */
function pngFinto(larghezza: number, altezza: number): Buffer {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(larghezza, 16)
  b.writeUInt32BE(altezza, 20)
  return b
}

describe('dimensioniImmagine', () => {
  // IL DIFETTO (8 set 2026): il DOCX metteva ogni foto a 480x360 fissi. Le foto
  // di cantiere scattate col telefono sono in larga parte VERTICALI: uscivano
  // tutte schiacciate in orizzontale.
  test('legge le dimensioni vere di un JPEG verticale', () => {
    expect(dimensioniImmagine(jpegFinto(1200, 1600))).toEqual({ larghezza: 1200, altezza: 1600 })
  })

  test('legge le dimensioni vere di un PNG', () => {
    expect(dimensioniImmagine(pngFinto(800, 600))).toEqual({ larghezza: 800, altezza: 600 })
  })

  test('su un formato che non sa leggere non inventa', () => {
    expect(dimensioniImmagine(Buffer.from('non sono un immagine'))).toBeNull()
  })
})

describe('estensioneDocx', () => {
  // `docx` vuole il tipo dichiarato. Prima era cablato 'jpg' per tutto: un WEBP
  // (che la chat accetta) o un HEIC dall'iPhone finivano dentro un Word come
  // immagine rotta, e il tool rispondeva "salvato" senza avvisi perche' il
  // DOWNLOAD era riuscito.
  test.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/gif', 'gif'],
    ['image/bmp', 'bmp'],
  ])('%s -> %s', (mime, atteso) => {
    expect(estensioneDocx(mime)).toBe(atteso)
  })

  test.each(['image/webp', 'image/heic', 'application/pdf', ''])(
    'su %s dice di NON saperlo mettere, invece di spacciarlo per jpg',
    (mime) => {
      expect(estensioneDocx(mime)).toBeNull()
    },
  )
})

describe('riquadroDocx', () => {
  test('una foto VERTICALE resta verticale', () => {
    const r = riquadroDocx({ larghezza: 1200, altezza: 1600 })
    expect(r.altezza).toBeGreaterThan(r.larghezza)
    // e le proporzioni restano quelle: 3:4
    expect(r.larghezza / r.altezza).toBeCloseTo(0.75, 2)
  })

  test('una foto orizzontale non sfora la larghezza utile', () => {
    const r = riquadroDocx({ larghezza: 4000, altezza: 3000 })
    expect(r.larghezza).toBe(480)
    expect(r.altezza).toBe(360)
  })

  test('una foto piccola non viene ingrandita e sgranata', () => {
    expect(riquadroDocx({ larghezza: 200, altezza: 150 })).toEqual({ larghezza: 200, altezza: 150 })
  })

  test('senza dimensioni note ripiega su un 4:3, senza rompersi', () => {
    expect(riquadroDocx(null)).toEqual({ larghezza: 480, altezza: 360 })
  })
})

describe('pianificaAllegato', () => {
  const foto = (n: string) => ({ byte: Buffer.from(n), tipo: 'jpg' as const })

  // IL DIFETTO trovato dall'audit: le foto riuscite venivano accodate, quindi
  // una che falliva faceva slittare tutte le successive di un posto.
  test('una foto mancante NON fa slittare le altre', () => {
    const piano = pianificaAllegato(
      ['AAA', 'BBB', 'CCC'],
      [foto('a'), null, foto('c')],
    )

    expect(piano.map((v) => v.tipo)).toEqual(['foto', 'assente', 'foto'])
    // la terza resta la terza
    expect(piano[2]).toMatchObject({ tipo: 'foto', indice: 2 })
    // e il buco e' dichiarato, con l'id per ritrovarlo
    expect(piano[1]).toMatchObject({ tipo: 'assente', id: 'BBB' })
  })

  test('quando ci sono tutte, nessun buco', () => {
    const piano = pianificaAllegato(['A', 'B'], [foto('a'), foto('b')])
    expect(piano.every((v) => v.tipo === 'foto')).toBe(true)
  })
})

describe('i casi che l audit ha trovato scoperti', () => {
  // Tutti gli input dei test erano gia' minuscoli: togliere `.toLowerCase()`
  // sopravviveva. Drive restituisce anche mimeType con maiuscole.
  test('il mimeType con maiuscole viene riconosciuto lo stesso', () => {
    expect(estensioneDocx('IMAGE/JPEG')).toBe('jpg')
    expect(estensioneDocx('Image/Png')).toBe('png')
  })

  test("'image/jpg' (la forma non canonica) e comunque un jpg", () => {
    expect(estensioneDocx('image/jpg')).toBe('jpg')
  })

  // Alzare ALTEZZA_MAX_DOCX a 5000 sopravviveva: nessuna asserzione la pinnava.
  // Una foto molto verticale sarebbe uscita piu' alta della pagina A4.
  test('una foto altissima resta dentro la pagina', () => {
    const r = riquadroDocx({ larghezza: 100, altezza: 4000 })
    expect(r.altezza).toBeLessThanOrEqual(620)
    // Precisione 2 e non 3: a proporzioni cosi' estreme l'arrotondamento al
    // pixel intero (15,5 -> 16) sposta il rapporto del 3 per cento. Non e' un
    // difetto, e' che i pixel sono interi.
    expect(r.larghezza / r.altezza).toBeCloseTo(100 / 4000, 2)
  })

  // ⭐ La forma d'ingresso VERA non era coperta: `jpegFinto` metteva il SOF
  // subito dopo il SOI, quindi il ciclo che salta i segmenti non veniva MAI
  // eseguito. Un JPEG da telefono ha APP0/APP1 (EXIF) prima del SOF.
  test('legge le dimensioni di un JPEG con i segmenti EXIF davanti', () => {
    const soi = Buffer.from([0xff, 0xd8])
    // APP1 (EXIF) lungo 100 byte, come in una foto da telefono
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x64]), Buffer.alloc(98)])
    const sof = Buffer.alloc(11)
    sof.writeUInt16BE(0xffc0, 0)
    sof.writeUInt16BE(9, 2)
    sof.writeUInt8(8, 4)
    sof.writeUInt16BE(3024, 5)  // altezza
    sof.writeUInt16BE(4032, 7)  // larghezza
    const jpeg = Buffer.concat([soi, app1, sof])

    expect(dimensioniImmagine(jpeg)).toEqual({ larghezza: 4032, altezza: 3024 })
  })
})

describe('dimensioniImmagine — le forme che arrivano davvero', () => {
  const sof = (l: number, a: number) => {
    const b = Buffer.alloc(11)
    b.writeUInt16BE(0xffc0, 0); b.writeUInt16BE(9, 2); b.writeUInt8(8, 4)
    b.writeUInt16BE(a, 5); b.writeUInt16BE(l, 7)
    return b
  }
  const segmento = (marker: number, lunghezza: number) => {
    const b = Buffer.alloc(2 + lunghezza)
    b.writeUInt16BE(marker, 0)
    b.writeUInt16BE(lunghezza, 2)
    return b
  }
  const SOI = Buffer.from([0xff, 0xd8])

  // ⭐ MISURATO dall'audit: senza l'esclusione di DHT/JPG/DAC dai marker SOF,
  // un JPEG con la tabella di Huffman prima dell'immagine restituiva
  // 4369x4369 invece di 4032x3024 — una foto gonfiata fuori pagina nel Word.
  // I JPEG veri da fotocamera hanno spesso DHT prima del SOF.
  it('un JPEG con la tabella di Huffman (DHT) prima del SOF', () => {
    const dht = segmento(0xffc4, 30)
    expect(dimensioniImmagine(Buffer.concat([SOI, dht, sof(4032, 3024)])))
      .toEqual({ larghezza: 4032, altezza: 3024 })
  })

  it.each([
    ['DAC (0xffcc)', 0xffcc],
    ['JPG riservato (0xffc8)', 0xffc8],
  ])('%s non viene scambiato per un SOF', (_nome, marker) => {
    expect(dimensioniImmagine(Buffer.concat([SOI, segmento(marker, 20), sof(800, 600)])))
      .toEqual({ larghezza: 800, altezza: 600 })
  })

  // Un download interrotto a meta' non deve far esplodere l'intero documento
  // con un RangeError: si rinuncia alle dimensioni e si ripiega.
  it('un JPEG troncato non fa esplodere niente', () => {
    expect(dimensioniImmagine(Buffer.concat([SOI, segmento(0xffe1, 100).subarray(0, 6)]))).toBeNull()
  })

  it('un PNG troncato non fa esplodere niente', () => {
    const png = Buffer.alloc(16)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    expect(dimensioniImmagine(png)).toBeNull()
  })
})

describe('formatoStampabile — l elenco, voce per voce', () => {
  // Non era nemmeno importata dai test: era coperta solo di rimbalzo dal caso
  // HEIC, quindi togliere 'image/png' dall'elenco sopravviveva e ogni PNG
  // sarebbe stato dichiarato mancante.
  it.each(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp'])(
    '%s si stampa', (m) => expect(formatoStampabile(m)).toBe(true),
  )

  it.each(['image/heic', 'image/heif', 'image/tiff', 'application/pdf', 'application/octet-stream', ''])(
    '%s NON si stampa', (m) => expect(formatoStampabile(m)).toBe(false),
  )

  // Drive restituisce anche `image/jpeg; charset=binary`: il confronto sulla
  // stringa intera lo scartava come formato sconosciuto.
  it('i parametri del mime non fanno scartare una foto buona', () => {
    expect(formatoStampabile('image/jpeg; charset=binary')).toBe(true)
    expect(estensioneDocx('image/jpeg; charset=binary')).toBe('jpg')
  })

  // ⭐ L'INVARIANTE che tiene insieme i due formati: se uno accetta e l'altro
  // no, dallo stesso HTML il PDF mostra la foto e il Word scrive
  // "[Foto N non disponibile]".
  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/avif', 'image/svg+xml', 'image/heic'])(
    'PDF e Word sono d accordo su %s', (m) => {
      expect(formatoStampabile(m)).toBe(estensioneDocx(m) !== null)
    },
  )
})

describe('GIF e BMP: senza dimensioni finivano nel 4:3 forzato', () => {
  // `estensioneDocx` li accetta, ma `dimensioniImmagine` non li leggeva:
  // `riquadroDocx(null)` ripiega su 480x360, cioe' la squadratura orizzontale
  // che questo lavoro esiste per eliminare — ancora viva su due formati.
  it('legge un GIF verticale', () => {
    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(600, 6)
    gif.writeUInt16LE(800, 8)
    expect(dimensioniImmagine(gif)).toEqual({ larghezza: 600, altezza: 800 })
  })

  it('legge un BMP, anche scritto dall alto (altezza negativa)', () => {
    const bmp = Buffer.alloc(26)
    bmp.write('BM', 0, 'latin1')
    bmp.writeInt32LE(1024, 18)
    bmp.writeInt32LE(-768, 22)   // bitmap top-down: altezza negativa
    expect(dimensioniImmagine(bmp)).toEqual({ larghezza: 1024, altezza: 768 })
  })

  it('un GIF verticale resta verticale nel documento', () => {
    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(600, 6)
    gif.writeUInt16LE(800, 8)
    const r = riquadroDocx(dimensioniImmagine(gif))
    expect(r.altezza).toBeGreaterThan(r.larghezza)
  })
})

describe('riquadroDocx — le proporzioni estreme', () => {
  // Senza `Math.max(1, ...)` una panoramica 4000x1 usciva con altezza ZERO:
  // un'immagine invisibile dentro il documento, che e' peggio di una assente
  // perche' nessuno se ne accorge.
  test('una panoramica estrema non esce con altezza zero', () => {
    const r = riquadroDocx({ larghezza: 4000, altezza: 1 })
    expect(r.altezza).toBeGreaterThanOrEqual(1)
    expect(r.larghezza).toBeGreaterThanOrEqual(1)
  })

  test('una colonna estrema non esce con larghezza zero', () => {
    const r = riquadroDocx({ larghezza: 1, altezza: 4000 })
    expect(r.larghezza).toBeGreaterThanOrEqual(1)
  })

  test('dimensioni assurde (zero o negative) ripiegano invece di rompere', () => {
    expect(riquadroDocx({ larghezza: 0, altezza: 0 })).toEqual({ larghezza: 480, altezza: 360 })
    expect(riquadroDocx({ larghezza: -5, altezza: 100 })).toEqual({ larghezza: 480, altezza: 360 })
  })
})
