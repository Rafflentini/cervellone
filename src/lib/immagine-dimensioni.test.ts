import { describe, test, expect } from 'vitest'
import { dimensioniImmagine, estensioneDocx, riquadroDocx, pianificaAllegato } from './immagine-dimensioni'

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
