import { describe, it, expect } from 'vitest'
import { isRaffica, RAFFICA_THRESHOLD, shouldSendRafficaAck, isPhotoLikeDocument, photoMimeFromFilename } from './upload-flow'

describe('isRaffica', () => {
  it('1-3 file → NON raffica (si analizza)', () => {
    expect(isRaffica(1)).toBe(false)
    expect(isRaffica(2)).toBe(false)
    expect(isRaffica(3)).toBe(false)
  })
  it('4+ file → raffica (cataloga e basta)', () => {
    expect(isRaffica(4)).toBe(true)
    expect(isRaffica(10)).toBe(true)
    expect(isRaffica(30)).toBe(true)
  })
  it('soglia di default = 4', () => {
    expect(RAFFICA_THRESHOLD).toBe(4)
  })
  it('valori non validi → false (safe: si comporta come prima = analizza)', () => {
    expect(isRaffica(NaN)).toBe(false)
    expect(isRaffica(0)).toBe(false)
    expect(isRaffica(-5)).toBe(false)
  })
  it('soglia personalizzabile', () => {
    expect(isRaffica(3, 3)).toBe(true)
    expect(isRaffica(2, 3)).toBe(false)
  })
})

describe('shouldSendRafficaAck (throttle 30s)', () => {
  it('primo avviso → true; entro 30s → false; dopo 30s → true', () => {
    const k = 'chat-A-' + Math.random()
    const t0 = 1_000_000
    expect(shouldSendRafficaAck(k, t0)).toBe(true)
    expect(shouldSendRafficaAck(k, t0 + 5_000)).toBe(false)    // entro cooldown
    expect(shouldSendRafficaAck(k, t0 + 61_000)).toBe(true)    // oltre cooldown (60s)
  })
  it('chat diverse non interferiscono', () => {
    const t = 2_000_000
    expect(shouldSendRafficaAck('chat-X', t)).toBe(true)
    expect(shouldSendRafficaAck('chat-Y', t)).toBe(true)
  })
})

// Dal cantiere si usa spesso "Invia come file" (iPhone) per non comprimere: la foto arriva
// come message.document e finiva su Drive SENZA riga cervellone_foto_pending → archivia_foto
// non l'avrebbe mai vista.
describe('isPhotoLikeDocument', () => {
  it('image/jpeg + IMG_4821.JPG → true', () => {
    expect(isPhotoLikeDocument({ mime_type: 'image/jpeg', file_name: 'IMG_4821.JPG' })).toBe(true)
  })
  it('image/heic → true', () => {
    expect(isPhotoLikeDocument({ mime_type: 'image/heic', file_name: 'IMG_4821.HEIC' })).toBe(true)
  })
  it('application/pdf + DVR.pdf → false', () => {
    expect(isPhotoLikeDocument({ mime_type: 'application/pdf', file_name: 'DVR.pdf' })).toBe(false)
  })
  it('application/octet-stream + IMG_4821.jpg → true (mime indovinato male, estensione decide)', () => {
    expect(isPhotoLikeDocument({ mime_type: 'application/octet-stream', file_name: 'IMG_4821.jpg' })).toBe(true)
  })
  it('octet-stream senza estensione immagine → false', () => {
    expect(isPhotoLikeDocument({ mime_type: 'application/octet-stream', file_name: 'archivio.zip' })).toBe(false)
    expect(isPhotoLikeDocument({ mime_type: 'application/octet-stream', file_name: 'senza-estensione' })).toBe(false)
  })
  it('mime assente → decide l\'estensione', () => {
    expect(isPhotoLikeDocument({ file_name: 'foto.jfif' })).toBe(true)
    expect(isPhotoLikeDocument({ file_name: 'contratto.docx' })).toBe(false)
    expect(isPhotoLikeDocument({})).toBe(false)
  })
})

describe('photoMimeFromFilename', () => {
  it('deduce il mime immagine dall\'estensione', () => {
    expect(photoMimeFromFilename('IMG_4821.JPG')).toBe('image/jpeg')
    expect(photoMimeFromFilename('a.heic')).toBe('image/heic')
    expect(photoMimeFromFilename('a.jfif')).toBe('image/jpeg')
  })
  it('non-immagine → null', () => {
    expect(photoMimeFromFilename('DVR.pdf')).toBeNull()
    expect(photoMimeFromFilename('senza-estensione')).toBeNull()
    expect(photoMimeFromFilename(null)).toBeNull()
  })
})
