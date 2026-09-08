/**
 * `downloadFile` non passava `supportsAllDrives: true`.
 *
 * ⭐ Qui c'era scritto che era «l'UNICA» e che «tutte le altre trenta chiamate
 * lo fanno». Era FALSO: la frase era stata verificata guardando drive.ts, non il
 * repo. Un audit avversariale ha poi trovato SETTE chiamate rotte dentro
 * drive.ts e TRE fuori, in file che si costruiscono un client Drive per conto
 * loro. L'invariante su tutte sta in `drive.tutte-le-chiamate.test.ts`.
 *
 * Su un file che vive in un Drive condiviso l'API risponde 404 "File not found",
 * e il chiamante che conta di piu' e' `embedDriveImages` in `pdf-generator.ts`:
 * li' il fallimento viene ingoiato da un catch che lascia l'URL originale, cosi'
 * il PDF esce con la foto ROTTA e nessuno lo dice. E' successo l'8 set 2026 sul
 * Preventivo Extra B della commessa C2026-008: PDF da 178KB, foto assente, e tre
 * "confermato, e' a posto" di fila.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAuthorizedClient = vi.fn()
vi.mock('./google-oauth', () => ({ getAuthorizedClient: mockGetAuthorizedClient }))

const GoogleAuthCtor = vi.fn()
const driveFactory = vi.fn()
const sheetsFactory = vi.fn()
vi.mock('googleapis', () => ({
  google: { auth: { GoogleAuth: GoogleAuthCtor }, drive: driveFactory, sheets: sheetsFactory },
}))
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
  mockGetAuthorizedClient.mockResolvedValue(null)
})

describe('downloadFileBase64 — i file nei Drive condivisi', () => {
  it('chiede i Drive condivisi sia sui metadati sia sui byte', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({ data: { name: 'IMG_5685.jpeg', mimeType: 'image/jpeg', size: '1110262' } })
      .mockResolvedValueOnce({ data: Buffer.from('pixel') })
    driveFactory.mockReturnValue({ files: { get: mockGet } })

    const { downloadFileBase64 } = await import('./drive')
    await downloadFileBase64('1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU')

    // Senza questo su un Drive condiviso l'API risponde 404 e la foto sparisce
    // dal PDF senza un errore visibile.
    expect(mockGet.mock.calls[0][0]).toMatchObject({ supportsAllDrives: true })
    expect(mockGet.mock.calls[1][0]).toMatchObject({ supportsAllDrives: true })
  })

  // CONTROLLO POSITIVO: senza, un `downloadFile` che non scarica niente
  // passerebbe il test qui sopra.
  it('restituisce davvero i byte del file, in base64', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({ data: { name: 'foto.jpg', mimeType: 'image/jpeg', size: '5' } })
      .mockResolvedValueOnce({ data: Buffer.from('pixel') })
    driveFactory.mockReturnValue({ files: { get: mockGet } })

    const { downloadFileBase64 } = await import('./drive')
    const esito = await downloadFileBase64('id-qualsiasi')

    expect(esito.mimeType).toBe('image/jpeg')
    expect(Buffer.from(esito.base64, 'base64').toString()).toBe('pixel')
  })
})
