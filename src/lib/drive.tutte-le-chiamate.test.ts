/**
 * Un'invariante sola, per tutte le chiamate: OGNI `files.*` di scrittura o
 * lettura deve chiedere i Drive condivisi, e ogni `files.list` deve anche
 * chiedere di includerne gli elementi.
 *
 * Il fix `9fccc55` aveva corretto `downloadFile` e scritto in tre punti del
 * codice che era «l'unica» — frase verificata guardando drive.ts, non il repo.
 * Un audit avversariale ha poi trovato SETTE chiamate rotte dentro drive.ts
 * (una a quattro righe dal commento che la descrive) e tre fuori, in file che
 * si costruiscono un client Drive per conto loro.
 *
 * Un test per funzione le avrebbe chiuse una per una e avrebbe lasciato
 * scoperta la prossima. Questo muore su OGNUNA delle mutazioni e resta valido
 * per le chiamate che verranno.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAuthorizedClient = vi.fn()
vi.mock('./google-oauth', () => ({ getAuthorizedClient: mockGetAuthorizedClient }))

const GoogleAuthCtor = vi.fn()
const driveFactory = vi.fn()
const sheetsFactory = vi.fn()
const docsFactory = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: GoogleAuthCtor },
    drive: driveFactory,
    sheets: sheetsFactory,
    docs: docsFactory,
  },
}))

const RADICE = '1PAXIQwW4opTJtJPZA0JCApZKYVJr63eq' // DOC_IMPRESA
vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [{ folder_id: RADICE }], error: null }),
      }),
    }),
  },
}))

type Chiamata = { metodo: string; params: Record<string, unknown> }
let chiamate: Chiamata[] = []

function spia(metodo: string, risposta: unknown) {
  return vi.fn(async (params: Record<string, unknown>) => {
    chiamate.push({ metodo, params })
    return risposta
  })
}

function drivFinto(opzioni: { listVuota?: boolean } = {}) {
  const files = opzioni.listVuota
    ? { data: { files: [] } }
    : { data: { files: [{ id: 'TROVATO', name: 'cartella' }] } }
  return {
    files: {
      list: spia('list', files),
      create: spia('create', { data: { id: 'NUOVO', name: 'nuova' } }),
      update: spia('update', { data: { id: 'AGGIORNATO' } }),
      get: spia('get', { data: { parents: [RADICE], name: 'x', mimeType: 'text/csv', size: '1' } }),
      delete: spia('delete', { data: {} }),
      copy: spia('copy', { data: { id: 'COPIA' } }),
      export: vi.fn(async () => ({ data: 'testo' })),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  chiamate = []
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
  mockGetAuthorizedClient.mockResolvedValue(null)
  docsFactory.mockReturnValue({ documents: { batchUpdate: vi.fn(async () => ({ data: {} })) } })
})

/** L'invariante. `files.export` e' l'unico metodo che il parametro non ce l'ha. */
function verificaInvariante() {
  expect(chiamate.length).toBeGreaterThan(0) // controllo positivo: qualcosa e' successo
  for (const { metodo, params } of chiamate) {
    expect(params, `files.${metodo} senza supportsAllDrives: ${JSON.stringify(params)}`)
      .toMatchObject({ supportsAllDrives: true })
    if (metodo === 'list') {
      expect(params, `files.list senza includeItemsFromAllDrives: ${JSON.stringify(params)}`)
        .toMatchObject({ includeItemsFromAllDrives: true })
    }
  }
}

describe('drive.ts — ogni chiamata chiede i Drive condivisi', () => {
  it('createFolder', async () => {
    driveFactory.mockReturnValue(drivFinto())
    const { createFolder } = await import('./drive')
    const esito = await createFolder('nuova', RADICE)
    expect(esito).toContain('creata') // controllo positivo
    verificaInvariante()
  })

  it('renameFile', async () => {
    driveFactory.mockReturnValue(drivFinto())
    const { renameFile } = await import('./drive')
    const esito = await renameFile('FILE1', 'nome nuovo')
    expect(esito).toContain('rinominato')
    verificaInvariante()
  })

  it('createDocument', async () => {
    driveFactory.mockReturnValue(drivFinto())
    const { createDocument } = await import('./drive')
    const esito = await createDocument('doc', 'contenuto', RADICE)
    expect(esito).not.toContain('Errore')
    verificaInvariante()
  })

  it('copyFile', async () => {
    driveFactory.mockReturnValue(drivFinto())
    const { copyFile } = await import('./drive')
    const esito = await copyFile('FILE1', RADICE, 'copia')
    expect(esito).toContain('copiato')
    verificaInvariante()
  })

  it('trashFilesByName cestina davvero', async () => {
    driveFactory.mockReturnValue(drivFinto())
    const { trashFilesByName } = await import('./drive')
    const quanti = await trashFilesByName(RADICE, 'SAL_01.xlsx')
    expect(quanti).toBe(1) // controllo positivo: senza, una update che non parte passerebbe
    verificaInvariante()
  })

  it('getOrCreateBozzeFolder quando la cartella NON c e', async () => {
    driveFactory.mockReturnValue(drivFinto({ listVuota: true }))
    const { getOrCreateBozzeFolder } = await import('./drive')
    expect(await getOrCreateBozzeFolder()).toBe('NUOVO')
    verificaInvariante()
  })

  it('getTelegramInboxFolderId quando la cartella NON c e', async () => {
    driveFactory.mockReturnValue(drivFinto({ listVuota: true }))
    const { getTelegramInboxFolderId } = await import('./drive')
    expect(await getTelegramInboxFolderId()).toBe('NUOVO')
    verificaInvariante()
  })

  // Il caso che conta: un segmento NUOVO. Con la cartella gia' esistente la
  // `create` non viene mai raggiunta e il test non prova niente.
  it('getOrCreatePathFolders su un segmento nuovo', async () => {
    driveFactory.mockReturnValue(drivFinto({ listVuota: true }))
    const { getOrCreatePathFolders } = await import('./drive')
    expect(await getOrCreatePathFolders(RADICE, ['C2026-008', '01_CONTABILITA'])).toBe('NUOVO')
    expect(chiamate.filter((c) => c.metodo === 'create')).toHaveLength(2)
    verificaInvariante()
  })
})
