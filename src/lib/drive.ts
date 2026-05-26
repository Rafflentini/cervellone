import { google } from 'googleapis'
import { Readable } from 'stream'

/**
 * FIX W1.3.5: auth dinamica OAuth-first → SA fallback.
 *
 * Prova prima OAuth2 utente (refresh_token in Supabase) → quota utente
 * (643/2000 GB). Se non disponibile, fallback Service Account (quota = 0,
 * funziona solo per READ).
 *
 * Lazy import di google-oauth per evitare side-effect del modulo supabase
 * a load-time (supabase.ts crash se env mancante in test environment).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAuth(): Promise<any> {
  try {
    const { getAuthorizedClient } = await import('./google-oauth')
    const oauthClient = await getAuthorizedClient()
    if (oauthClient) return oauthClient
  } catch (err) {
    console.error('[DRIVE] OAuth lookup failed, fallback to SA:', err instanceof Error ? err.message : err)
  }

  // Fallback SA — funziona solo per READ
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}')
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  })
}

async function getDrive() {
  return google.drive({ version: 'v3', auth: await getAuth() })
}

async function getSheets() {
  return google.sheets({ version: 'v4', auth: await getAuth() })
}

// ID cartelle Restruktura (reali)
export const DRIVE_FOLDERS = {
  STUDIO_ATTIVI: '1fPrUX_GTZVYITQVk-CW0VuXSGs1Db3If',
  STUDIO_ARCHIVIO: '1-pExmiifvV9v8sfSzEkR0XNYi8tdXAkj',
  CANTIERI_ATTIVI: '1V3_yoIsrFBWgIgZfkMFlFVObGDm3yiuf',
  ARCHIVIO_CANTIERI: '18B6Az-mG8L-NNpwD4GZ_QkHTUzORvljf',
  DOC_IMPRESA: '1PAXIQwW4opTJtJPZA0JCApZKYVJr63eq',
  DURC: '1vxHyJ7VX6oWnAFmRuRUjP8od0_TuGh6S',
  POS: '1BexyjYwMreOy4sBuOa0SADKshQFoKTrx',
  DVR: '15J0n3K0yUKgmVtXrf7cqDiHmaePlJq-Z',
  PERSONALE: '1e2XptX3mv3DuItnBULX_imMW21g7RpY5',
}

export const SHEETS = {
  REGISTRO_PROGETTI: '1G5wLIa8ZMRTr05Jc6fUxmLkyA3xKtRSVNyib-4h4Zac',
  REGISTRO_CANTIERI: '1LvUkPRCWhDRZW5qIAiap0aJ_qA9TKHm-HOhV1H6FBso',
}

// --- RECINZIONE SCRITTURE (folder access policy) ---
// Una scrittura su Drive è permessa SOLO se la cartella di destinazione è una "radice
// consentita" (tabella cervellone_drive_policy, can_write=true) oppure una sua DISCENDENTE.
// Tutto il resto è bloccato finché l'utente non autorizza la cartella (doppia conferma da chat).
// Fail-closed: in caso di dubbio (policy non leggibile, ancestry non determinabile) si blocca.

export class DrivePolicyError extends Error {
  constructor(public folderId: string, public folderName?: string) {
    super(
      `Scrittura non consentita nella cartella ${folderName || folderId}. ` +
        `Cervellone può scrivere solo nelle cartelle autorizzate (e relative sottocartelle). ` +
        `Per autorizzare questa cartella chiedimi di darti accesso: serve la doppia conferma.`,
    )
    this.name = 'DrivePolicyError'
  }
}

let _rootsCache: { ids: Set<string>; at: number } | null = null
const ROOTS_TTL_MS = 30_000
const _ancestryCache = new Map<string, { allowed: boolean; at: number }>()
const ANCESTRY_TTL_MS = 5 * 60_000

async function loadWritableRoots(): Promise<Set<string>> {
  if (_rootsCache && Date.now() - _rootsCache.at < ROOTS_TTL_MS) return _rootsCache.ids
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .from('cervellone_drive_policy')
    .select('folder_id')
    .eq('can_write', true)
  if (error) throw new Error(`Policy Drive non leggibile: ${error.message}`)
  const ids = new Set((data ?? []).map((r: { folder_id: string }) => r.folder_id))
  _rootsCache = { ids, at: Date.now() }
  return ids
}

/** Invalida la cache delle radici consentite. Chiamare dopo una modifica di policy. */
export function invalidateDrivePolicyCache(): void {
  _rootsCache = null
  _ancestryCache.clear()
}

/**
 * Verifica che `targetFolderId` sia una radice consentita o una sua discendente,
 * risalendo i parent (max 15 livelli). Lancia DrivePolicyError se non consentita.
 * Fail-closed: se l'ancestry non è determinabile (errore API), blocca.
 */
export async function assertWriteAllowed(targetFolderId: string): Promise<void> {
  if (!targetFolderId) throw new DrivePolicyError(targetFolderId)
  const roots = await loadWritableRoots()
  if (roots.has(targetFolderId)) return

  const cached = _ancestryCache.get(targetFolderId)
  if (cached && Date.now() - cached.at < ANCESTRY_TTL_MS) {
    if (cached.allowed) return
    throw new DrivePolicyError(targetFolderId)
  }

  const drive = await getDrive()
  let current = targetFolderId
  const seen = new Set<string>()
  for (let depth = 0; depth < 15; depth++) {
    if (roots.has(current)) {
      _ancestryCache.set(targetFolderId, { allowed: true, at: Date.now() })
      return
    }
    if (seen.has(current)) break
    seen.add(current)
    let parents: string[] | undefined
    try {
      const meta = await drive.files.get({ fileId: current, fields: 'parents', supportsAllDrives: true })
      parents = meta.data.parents || undefined
    } catch (err) {
      console.error(`[DRIVE POLICY] ancestry lookup failed for ${current}:`, err instanceof Error ? err.message : err)
      throw new DrivePolicyError(targetFolderId) // fail-closed
    }
    if (!parents || parents.length === 0) break // radice del Drive raggiunta senza match
    current = parents[0]
  }
  _ancestryCache.set(targetFolderId, { allowed: false, at: Date.now() })
  throw new DrivePolicyError(targetFolderId)
}

// --- OPERAZIONI FILE E CARTELLE ---

// Elenca file/cartelle in una cartella
export async function listFiles(folderId: string): Promise<string> {
  try {
    const drive = await getDrive()
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      orderBy: 'name',
      pageSize: 100,
    })

    const files = res.data.files || []
    if (files.length === 0) return 'Cartella vuota.'

    const lines = files.map(f => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder'
      const size = f.size ? ` (${Math.round(Number(f.size) / 1024)}KB)` : ''
      const modified = f.modifiedTime ? ` — ${new Date(f.modifiedTime).toLocaleDateString('it-IT')}` : ''
      return `${isFolder ? '📁' : '📄'} ${f.name}${size}${modified} [ID: ${f.id}]`
    })

    return `${files.length} elementi:\n${lines.join('\n')}`
  } catch (err) {
    return `Errore listando i file: ${err}`
  }
}

function escapeDriveQueryString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// Cerca file per nome in tutto il Drive o in una cartella
export async function searchFiles(query: string, folderId?: string): Promise<string> {
  console.log(`[DRIVE] searchFiles query="${query}" folder="${folderId || 'root'}"`)
  try {
    const drive = await getDrive()
    let q = `name contains '${escapeDriveQueryString(query)}' and trashed = false`
    if (folderId) q += ` and '${folderId}' in parents`

    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, parents, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 15, // FIX W1.3: ridotto da 20 per evitare prompt esplosi
    })

    const files = res.data.files || []
    console.log(`[DRIVE] searchFiles found=${files.length}`)
    if (files.length === 0) return `Nessun file trovato per "${query}".`

    const lines = files.map(f => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder'
      const truncName = (f.name || '').slice(0, 100) // truncate nomi lunghi
      return `${isFolder ? '📁' : '📄'} ${truncName} [ID: ${f.id}]`
    })

    return `${files.length} risultati per "${query}":\n${lines.join('\n')}`
  } catch (err) {
    console.error(`[DRIVE] searchFiles ERROR:`, err)
    return `Errore nella ricerca: ${err instanceof Error ? err.message : err}`
  }
}

// Cerca SOLO cartelle per nome, ritorno strutturato (per la gestione policy accessi).
export async function findFoldersByName(query: string): Promise<Array<{ id: string; name: string }>> {
  const drive = await getDrive()
  const safe = escapeDriveQueryString(query)
  const res = await drive.files.list({
    q: `name contains '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 15,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (res.data.files || [])
    .filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))
    .map(f => ({ id: f.id, name: f.name }))
}

// FIX W1.3 Task 2: ricerca per CONTENUTO testuale (full-text indexed da Drive)
export async function searchFilesFullText(query: string, folderId?: string): Promise<string> {
  console.log(`[DRIVE] searchFilesFullText query="${query}" folder="${folderId || 'root'}"`)
  try {
    const drive = await getDrive()
    let q = `fullText contains '${escapeDriveQueryString(query)}' and trashed = false`
    if (folderId) q += ` and '${folderId}' in parents`

    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, parents, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 15,
    })

    const files = res.data.files || []
    console.log(`[DRIVE] searchFilesFullText found=${files.length}`)
    if (files.length === 0) return `Nessun file con contenuto "${query}".`

    const lines = files.map(f => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder'
      const truncName = (f.name || '').slice(0, 100)
      return `${isFolder ? '📁' : '📄'} ${truncName} [ID: ${f.id}]`
    })

    return `${files.length} file con contenuto "${query}":\n${lines.join('\n')}`
  } catch (err) {
    console.error(`[DRIVE] searchFilesFullText ERROR:`, err)
    return `Errore nella ricerca full-text: ${err instanceof Error ? err.message : err}`
  }
}

// FIX W1.3 Task 3: download binario per parsing client-side (PDF/DOCX/XLSX)
async function downloadFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
  const drive = await getDrive()
  const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' })
  const sizeBytes = Number(meta.data.size || 0)
  if (sizeBytes > 20 * 1024 * 1024) {
    throw new Error(`File troppo grande (${(sizeBytes / 1024 / 1024).toFixed(1)} MB > 20 MB max)`)
  }
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = Buffer.from(res.data as any)
  return {
    buffer,
    mimeType: meta.data.mimeType || 'application/octet-stream',
    name: meta.data.name || 'file',
  }
}

export async function readPdfFromDrive(fileId: string): Promise<string> {
  console.log(`[DRIVE] readPdfFromDrive id=${fileId}`)
  try {
    const file = await downloadFile(fileId)
    if (!file.mimeType.includes('pdf')) {
      return `File "${file.name}" non è un PDF (mime: ${file.mimeType}). Usa drive_read_office o drive_read_document.`
    }
    // FIX W1.3: polyfill DOMMatrix per pdfjs-dist in Node.js serverless.
    // pdfjs-dist (usato da pdf-parse v2) richiede DOMMatrix che NON esiste in Node serverless.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any
    if (typeof g.DOMMatrix === 'undefined') {
      g.DOMMatrix = class DOMMatrix {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(..._args: any[]) {}
        // Stubs minimali per evitare crash, sufficienti per text extraction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        multiply() { return this } translate() { return this } scale() { return this }
      }
    }
    // pdf-parse v2 API: new PDFParse({ data }) + getText()
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: file.buffer })
    let text = ''
    let pages = 0
    try {
      const result = await parser.getText()
      text = (result.text || '').slice(0, 50000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pages = (result as any).numpages || (result as any).pages?.length || 0
    } finally {
      await parser.destroy()
    }
    console.log(`[DRIVE] readPdfFromDrive ok pages=${pages} chars=${text.length}`)
    return `📄 PDF: ${file.name}${pages ? ` (${pages} pagine)` : ''}\n\n${text || '(testo vuoto o solo immagini — considera Vision OCR)'}`
  } catch (err) {
    console.error(`[DRIVE] readPdfFromDrive ERROR:`, err)
    return `Errore lettura PDF: ${err instanceof Error ? err.message : err}`
  }
}

export async function readDocxFromDrive(fileId: string): Promise<string> {
  console.log(`[DRIVE] readDocxFromDrive id=${fileId}`)
  try {
    const file = await downloadFile(fileId)
    const isDocx = file.mimeType.includes('wordprocessing') || file.name.toLowerCase().endsWith('.docx')
    if (!isDocx) return `File "${file.name}" non è un DOCX (mime: ${file.mimeType}).`
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: file.buffer })
    const text = (result.value || '').slice(0, 50000)
    console.log(`[DRIVE] readDocxFromDrive ok chars=${text.length}`)
    return `📄 DOCX: ${file.name}\n\n${text}`
  } catch (err) {
    console.error(`[DRIVE] readDocxFromDrive ERROR:`, err)
    return `Errore lettura DOCX: ${err instanceof Error ? err.message : err}`
  }
}

export async function readXlsxFromDrive(fileId: string): Promise<string> {
  console.log(`[DRIVE] readXlsxFromDrive id=${fileId}`)
  try {
    const file = await downloadFile(fileId)
    const isXlsx = file.mimeType.includes('spreadsheet') || file.name.toLowerCase().endsWith('.xlsx')
    if (!isXlsx) return `File "${file.name}" non è un XLSX (mime: ${file.mimeType}).`
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(file.buffer)
    const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
    if (!shared) return `XLSX "${file.name}" senza sharedStrings — vuoto?`
    const texts: string[] = []
    const re = /<t[^>]*>([\s\S]*?)<\/t>/g
    let m
    while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
    const content = texts.slice(0, 5000).join(' | ').slice(0, 50000)
    console.log(`[DRIVE] readXlsxFromDrive ok strings=${texts.length}`)
    return `📊 XLSX: ${file.name}\n\n${content}`
  } catch (err) {
    console.error(`[DRIVE] readXlsxFromDrive ERROR:`, err)
    return `Errore lettura XLSX: ${err instanceof Error ? err.message : err}`
  }
}

// Crea una cartella
export async function createFolder(name: string, parentId: string): Promise<string> {
  try {
    await assertWriteAllowed(parentId)
  } catch (err) {
    if (err instanceof DrivePolicyError) return `🔒 ${err.message}`
    return `Errore verifica permessi: ${err instanceof Error ? err.message : err}`
  }
  try {
    const drive = await getDrive()
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id, name',
    })

    return `Cartella "${res.data.name}" creata. [ID: ${res.data.id}]`
  } catch (err) {
    return `Errore creando la cartella: ${err}`
  }
}

// Sposta un file/cartella
export async function moveFile(fileId: string, newParentId: string): Promise<string> {
  try {
    await assertWriteAllowed(newParentId)
  } catch (err) {
    if (err instanceof DrivePolicyError) return `🔒 ${err.message}`
    return `Errore verifica permessi: ${err instanceof Error ? err.message : err}`
  }
  try {
    const drive = await getDrive()
    // Ottieni i parent attuali
    const file = await drive.files.get({ fileId, fields: 'parents, name' })
    const previousParents = (file.data.parents || []).join(',')

    await drive.files.update({
      fileId,
      addParents: newParentId,
      removeParents: previousParents,
      fields: 'id, name, parents',
    })

    return `"${file.data.name}" spostato nella nuova cartella.`
  } catch (err) {
    return `Errore spostando il file: ${err}`
  }
}

// Rinomina un file/cartella
export async function renameFile(fileId: string, newName: string): Promise<string> {
  try {
    const drive = await getDrive()
    await drive.files.update({
      fileId,
      requestBody: { name: newName },
    })

    return `File rinominato in "${newName}".`
  } catch (err) {
    return `Errore rinominando: ${err}`
  }
}

// Leggi contenuto di un Google Doc
export async function readDocument(fileId: string): Promise<string> {
  try {
    const drive = await getDrive()
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    })

    const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    return content.slice(0, 50000) || 'Documento vuoto.'
  } catch (err) {
    return `Errore leggendo il documento: ${err}`
  }
}

// Crea un Google Doc con contenuto
export async function createDocument(name: string, content: string, folderId: string): Promise<string> {
  try {
    await assertWriteAllowed(folderId)
  } catch (err) {
    if (err instanceof DrivePolicyError) return `🔒 ${err.message}`
    return `Errore verifica permessi: ${err instanceof Error ? err.message : err}`
  }
  try {
    const drive = await getDrive()

    // Crea il documento
    const doc = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.document',
        parents: [folderId],
      },
      fields: 'id, name, webViewLink',
    })

    // Scrivi il contenuto usando Docs API
    const docs = google.docs({ version: 'v1', auth: await getAuth() })
    if (doc.data.id && content) {
      await docs.documents.batchUpdate({
        documentId: doc.data.id,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: content,
            },
          }],
        },
      })
    }

    return `Documento "${doc.data.name}" creato.\nLink: ${doc.data.webViewLink}\n[ID: ${doc.data.id}]`
  } catch (err) {
    return `Errore creando il documento: ${err}`
  }
}

// --- OPERAZIONI GOOGLE SHEETS ---

// Leggi dati da un foglio
export async function readSheet(spreadsheetId: string, range: string): Promise<string> {
  try {
    const sheets = await getSheets()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    })

    const rows = res.data.values || []
    if (rows.length === 0) return 'Foglio vuoto.'

    // Formatta come tabella leggibile
    const lines = rows.map((row, i) => `Riga ${i + 1}: ${row.join(' | ')}`).join('\n')
    return `${rows.length} righe:\n${lines}`
  } catch (err) {
    return `Errore leggendo il foglio: ${err}`
  }
}

// Scrivi dati in un foglio
export async function writeSheet(spreadsheetId: string, range: string, values: string[][]): Promise<string> {
  try {
    const sheets = await getSheets()
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })

    return `Scritte ${res.data.updatedCells} celle nel foglio.`
  } catch (err) {
    return `Errore scrivendo nel foglio: ${err}`
  }
}

// Aggiungi riga in fondo al foglio
export async function appendSheet(spreadsheetId: string, range: string, values: string[][]): Promise<string> {
  try {
    const sheets = await getSheets()
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })

    return `Aggiunta ${res.data.updates?.updatedRows} riga al foglio.`
  } catch (err) {
    return `Errore aggiungendo al foglio: ${err}`
  }
}

// --- UPLOAD BINARIO + FOLDER HELPERS ---

/** Converte un Buffer Node.js in uno stream Readable per l'API Google Drive */
function bufferToReadable(buffer: Buffer): Readable {
  const readable = new Readable()
  readable.push(buffer)
  readable.push(null)
  return readable
}

/** Cache module-level per folder ID (per non ri-creare a ogni upload) */
const _folderIdCache = new Map<string, string>()

/**
 * Lazy-create la cartella "📥 BOZZE_PDF" sotto DOC_IMPRESA.
 * Restituisce l'ID. Risultato cachato per tutta la vita del modulo.
 */
export async function getOrCreateBozzeFolder(): Promise<string> {
  await assertWriteAllowed(DRIVE_FOLDERS.DOC_IMPRESA)
  const CACHE_KEY = 'bozze_pdf'
  if (_folderIdCache.has(CACHE_KEY)) return _folderIdCache.get(CACHE_KEY)!

  const drive = await getDrive()
  // Cerca se esiste già
  const existing = await drive.files.list({
    q: `name = '📥 BOZZE_PDF' and mimeType = 'application/vnd.google-apps.folder' and '${DRIVE_FOLDERS.DOC_IMPRESA}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  })
  if (existing.data.files?.length) {
    const id = existing.data.files[0].id!
    _folderIdCache.set(CACHE_KEY, id)
    return id
  }

  // Crea
  const res = await drive.files.create({
    requestBody: {
      name: '📥 BOZZE_PDF',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_FOLDERS.DOC_IMPRESA],
    },
    fields: 'id',
  })
  const id = res.data.id!
  _folderIdCache.set(CACHE_KEY, id)
  console.log(`[DRIVE] getOrCreateBozzeFolder created id=${id}`)
  return id
}

/**
 * Lazy-create la cartella "📥 Telegram Inbox" sotto DOC_IMPRESA.
 * Usata per l'auto-archive dei file ricevuti via Telegram.
 */
export async function getTelegramInboxFolderId(): Promise<string> {
  await assertWriteAllowed(DRIVE_FOLDERS.DOC_IMPRESA)
  const CACHE_KEY = 'telegram_inbox'
  if (_folderIdCache.has(CACHE_KEY)) return _folderIdCache.get(CACHE_KEY)!

  const drive = await getDrive()
  const existing = await drive.files.list({
    q: `name = '📥 Telegram Inbox' and mimeType = 'application/vnd.google-apps.folder' and '${DRIVE_FOLDERS.DOC_IMPRESA}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  })
  if (existing.data.files?.length) {
    const id = existing.data.files[0].id!
    _folderIdCache.set(CACHE_KEY, id)
    return id
  }

  const res = await drive.files.create({
    requestBody: {
      name: '📥 Telegram Inbox',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_FOLDERS.DOC_IMPRESA],
    },
    fields: 'id',
  })
  const id = res.data.id!
  _folderIdCache.set(CACHE_KEY, id)
  console.log(`[DRIVE] getTelegramInboxFolderId created id=${id}`)
  return id
}

export async function getOrCreatePathFolders(baseFolderId: string, segments: string[]): Promise<string> {
  // La base deve essere consentita: ogni sottocartella creata qui ne è discendente.
  await assertWriteAllowed(baseFolderId)
  const drive = await getDrive()
  let parentId = baseFolderId

  for (const rawSegment of segments) {
    const segment = rawSegment.trim()
    if (!segment) continue
    if (segment === '.' || segment === '..') continue

    const cacheKey = `path:${parentId}:${segment}`
    if (_folderIdCache.has(cacheKey)) {
      parentId = _folderIdCache.get(cacheKey)!
      continue
    }

    const safeName = escapeDriveQueryString(segment)
    const existing = await drive.files.list({
      q: `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    })
    if (existing.data.files?.length) {
      const id = existing.data.files[0].id!
      _folderIdCache.set(cacheKey, id)
      parentId = id
      continue
    }

    const created = await drive.files.create({
      requestBody: {
        name: segment,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    })
    const id = created.data.id!
    _folderIdCache.set(cacheKey, id)
    console.log(`[DRIVE] getOrCreatePathFolders created "${segment}" id=${id}`)
    parentId = id
  }

  return parentId
}

/**
 * Carica un file binario (Buffer) su Google Drive.
 * Crea la cartella BOZZE_PDF se folderId non specificato.
 */
export async function uploadBinaryToDrive(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  folderId?: string,
): Promise<{ id: string; webViewLink: string }> {
  const drive = await getDrive()
  const resolvedFolderId = folderId || (await getOrCreateBozzeFolder())
  await assertWriteAllowed(resolvedFolderId)

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [resolvedFolderId],
      mimeType,
    },
    media: {
      mimeType,
      body: bufferToReadable(buffer),
    },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })

  const id = res.data.id
  const webViewLink = res.data.webViewLink
  if (!id || !webViewLink) throw new Error(`uploadBinaryToDrive: risposta API incompleta id=${id}`)
  console.log(`[DRIVE] uploadBinaryToDrive name="${fileName}" id=${id}`)
  return { id, webViewLink }
}

function extractDriveFileId(value: string): string {
  const trimmed = value.trim()
  const pathMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/)
  if (pathMatch) return pathMatch[1]
  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (queryMatch) return queryMatch[1]
  return trimmed
}

export async function archiveDocumentToDrive(
  folderPath: string,
  driveFileId: string,
  filename?: string,
): Promise<string> {
  const fileId = extractDriveFileId(driveFileId)
  const segments = folderPath.split('/').map(s => s.trim()).filter(Boolean)
  if (!fileId) return JSON.stringify({ ok: false, error: 'drive_file_id richiesto' })
  if (segments.length === 0) return JSON.stringify({ ok: false, error: 'folder_path richiesto' })

  try {
    const normalizedPath = segments.join('/')
    const targetFolderId = await getOrCreatePathFolders(DRIVE_FOLDERS.DOC_IMPRESA, segments)
    const moveResult = await moveFile(fileId, targetFolderId)
    if (moveResult.startsWith('Errore')) {
      return JSON.stringify({ ok: false, folder_path: normalizedPath, file_id: fileId, error: moveResult })
    }

    if (filename?.trim()) {
      const renameResult = await renameFile(fileId, filename.trim())
      if (renameResult.startsWith('Errore')) {
        return JSON.stringify({ ok: false, folder_path: normalizedPath, file_id: fileId, error: renameResult })
      }
    }

    return JSON.stringify({
      ok: true,
      folder_path: normalizedPath,
      file_id: fileId,
      url: `https://drive.google.com/file/d/${fileId}/view`,
    })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      folder_path: segments.join('/'),
      file_id: fileId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// --- ESECUZIONE TOOL ---

export async function executeDriveTool(name: string, input: Record<string, string>): Promise<string> {
  switch (name) {
    case 'drive_list_files':
      return listFiles(input.folder_id)

    case 'drive_search':
      return searchFiles(input.query, input.folder_id)

    case 'drive_create_folder':
      return createFolder(input.name, input.parent_id)

    case 'drive_move_file':
      return moveFile(input.file_id, input.new_parent_id)

    case 'drive_rename':
      return renameFile(input.file_id, input.new_name)

    case 'drive_read_document':
      return readDocument(input.file_id)

    case 'drive_create_document':
      return createDocument(input.name, input.content, input.folder_id)

    case 'sheets_read':
      return readSheet(input.spreadsheet_id, input.range)

    case 'sheets_write':
      return writeSheet(input.spreadsheet_id, input.range, JSON.parse(input.values))

    case 'sheets_append':
      return appendSheet(input.spreadsheet_id, input.range, JSON.parse(input.values))

    // FIX W1.3 (utente 2/5): salva esplicito su Drive quando richiesto
    case 'salva_documento_su_drive': {
      const { saveDocumentToDrive } = await import('./document-saver')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docType = (input.document_type as any) || 'altro'
      const title = input.title || 'Documento'
      const htmlContent = input.html_content || ''
      const userPromptHint = input.user_prompt_hint || ''
      try {
        const result = await saveDocumentToDrive(htmlContent, title, docType, userPromptHint, '')
        const fallback = result.isFallback ? '⚠️ FALLBACK ' : ''
        const registro = result.registroAppended ? ' (📊 registro aggiornato)' : ''
        return `✅ ${fallback}Salvato su Drive in ${result.folderPath}${registro}\n👉 ${result.driveUrl}`
      } catch (err) {
        return `Errore salvataggio Drive: ${err instanceof Error ? err.message : err}`
      }
    }

    case 'archivia_documento':
      return archiveDocumentToDrive(input.folder_path, input.drive_file_id, input.filename || undefined)

    // FIX W1.3 Task 2-3: nuovi tool full-text + binari
    case 'drive_search_fulltext':
      return searchFilesFullText(input.query, input.folder_id)
    case 'drive_read_pdf':
      return readPdfFromDrive(input.file_id)
    case 'drive_read_office': {
      // Auto-detect DOCX vs XLSX da metadata
      try {
        const drive = await getDrive()
        const meta = await drive.files.get({ fileId: input.file_id, fields: 'name, mimeType' })
        const fname = (meta.data.name || '').toLowerCase()
        const fmime = meta.data.mimeType || ''
        if (fname.endsWith('.docx') || fmime.includes('wordprocessing')) {
          return readDocxFromDrive(input.file_id)
        }
        if (fname.endsWith('.xlsx') || fmime.includes('spreadsheet')) {
          return readXlsxFromDrive(input.file_id)
        }
        return `Formato non supportato: ${fmime}. Usa drive_read_pdf o drive_read_document.`
      } catch (err) {
        return `Errore drive_read_office: ${err instanceof Error ? err.message : err}`
      }
    }

    case 'drive_upload_binary': {
      try {
        const base64 = input.file_data_base64
        const filename = input.filename
        const mimeType = input.mime_type || 'application/octet-stream'
        const folderId = input.folder_id || undefined

        if (!base64 || !filename) return 'Errore: file_data_base64 e filename sono richiesti.'
        if (base64.length > 14 * 1024 * 1024) return 'File troppo grande (>~10MB base64). Limite caricamento diretto.'

        const buffer = Buffer.from(base64, 'base64')
        const { webViewLink } = await uploadBinaryToDrive(buffer, filename, mimeType, folderId)
        return `✅ File "${filename}" caricato su Drive.\n👉 ${webViewLink}`
      } catch (err) {
        return `Errore upload Drive: ${err instanceof Error ? err.message : err}`
      }
    }

    default:
      return `Tool "${name}" non riconosciuto.`
  }
}

// Definizioni tool per l'API Anthropic
export const DRIVE_TOOLS = [
  {
    name: 'drive_list_files',
    description: `Elenca i file e le cartelle dentro una cartella Google Drive di Restruktura S.R.L.
Cartelle principali disponibili:
- Studio Tecnico ATTIVI: ${DRIVE_FOLDERS.STUDIO_ATTIVI}
- Studio Tecnico ARCHIVIO: ${DRIVE_FOLDERS.STUDIO_ARCHIVIO}
- CANTIERI ATTIVI: ${DRIVE_FOLDERS.CANTIERI_ATTIVI}
- ARCHIVIO CANTIERI: ${DRIVE_FOLDERS.ARCHIVIO_CANTIERI}
- DOC. IMPRESA EDILE: ${DRIVE_FOLDERS.DOC_IMPRESA}
- DURC: ${DRIVE_FOLDERS.DURC}
- POS: ${DRIVE_FOLDERS.POS}
- DVR: ${DRIVE_FOLDERS.DVR}
- PERSONALE: ${DRIVE_FOLDERS.PERSONALE}`,
    input_schema: {
      type: 'object' as const,
      properties: {
        folder_id: { type: 'string', description: 'ID della cartella Google Drive' },
      },
      required: ['folder_id'],
    },
  },
  {
    name: 'drive_search',
    description: 'Cerca file per nome nel Google Drive di Restruktura. Puoi cercare in tutto il Drive o dentro una cartella specifica.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Testo da cercare nel nome del file' },
        folder_id: { type: 'string', description: 'ID cartella dove cercare (opzionale — se omesso cerca in tutto il Drive)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_create_folder',
    description: 'Crea una nuova cartella nel Google Drive di Restruktura.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome della cartella da creare' },
        parent_id: { type: 'string', description: 'ID della cartella genitore dove crearla' },
      },
      required: ['name', 'parent_id'],
    },
  },
  {
    name: 'drive_move_file',
    description: 'Sposta un file o cartella in una nuova posizione nel Drive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'ID del file/cartella da spostare' },
        new_parent_id: { type: 'string', description: 'ID della cartella di destinazione' },
      },
      required: ['file_id', 'new_parent_id'],
    },
  },
  {
    name: 'drive_rename',
    description: 'Rinomina un file o cartella nel Drive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'ID del file/cartella da rinominare' },
        new_name: { type: 'string', description: 'Nuovo nome' },
      },
      required: ['file_id', 'new_name'],
    },
  },
  {
    name: 'drive_read_document',
    description: 'Leggi il contenuto testuale di un Google Doc o file di testo dal Drive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'ID del documento da leggere' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_create_document',
    description: 'Crea un nuovo Google Doc con contenuto nel Drive di Restruktura.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nome del documento' },
        content: { type: 'string', description: 'Contenuto testuale del documento' },
        folder_id: { type: 'string', description: 'ID della cartella dove salvare il documento' },
      },
      required: ['name', 'content', 'folder_id'],
    },
  },
  {
    name: 'sheets_read',
    description: `Leggi dati da un foglio Google Sheets di Restruktura.
Fogli disponibili:
- Registro Progetti: ${SHEETS.REGISTRO_PROGETTI}
- Registro Cantieri: ${SHEETS.REGISTRO_CANTIERI} (header su 3 righe, dati dalla riga 4)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'ID del foglio Google Sheets' },
        range: { type: 'string', description: 'Range da leggere (es. "Foglio1!A1:M50")' },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'sheets_write',
    description: 'Scrivi dati in un foglio Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'ID del foglio' },
        range: { type: 'string', description: 'Range dove scrivere (es. "Foglio1!A4:M4")' },
        values: { type: 'string', description: 'Dati da scrivere come JSON array di array (es. [["val1","val2"]])' },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  {
    name: 'sheets_append',
    description: 'Aggiungi una riga in fondo a un foglio Google Sheets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'ID del foglio' },
        range: { type: 'string', description: 'Range del foglio (es. "Foglio1!A:M")' },
        values: { type: 'string', description: 'Dati da aggiungere come JSON array di array' },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  // FIX W1.3 (utente 2/5): salva esplicito su Drive quando richiesto
  {
    name: 'salva_documento_su_drive',
    description: `Salva un documento generato (POS/preventivo/perizia/CME/relazione/SCIA/CILA) su Google Drive Restruktura nella cartella corretta.
USA QUESTO TOOL SOLO se l'utente CHIEDE ESPLICITAMENTE di salvare su Drive (es. "salva su Drive", "archivialo", "mettilo in cartella X").
Il tool sceglie automaticamente la cartella destinazione:
- POS/SCIA/CILA → cartella cantiere matched (o /POS/ fallback)
- Preventivo/CME/Perizia/Relazione → cartella cliente in /Studio Tecnico ATTIVI/ (o _Bozze/ fallback)
- Aggiorna automaticamente REGISTRO_CANTIERI o REGISTRO_PROGETTI
- Bot dichiara il path scelto.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Titolo del documento (apparirà come nome file su Drive)' },
        html_content: { type: 'string', description: 'Contenuto HTML completo del documento (quello dentro ~~~document ... ~~~)' },
        document_type: {
          type: 'string',
          enum: ['pos', 'preventivo', 'cme', 'perizia', 'relazione', 'scia', 'cila', 'altro'],
          description: 'Tipo documento: determina cartella destinazione e registro su cui appendere',
        },
        user_prompt_hint: { type: 'string', description: 'Frase utente con nome cliente/cantiere per matching cartella (es. "POS per cantiere Rossi Mario")' },
      },
      required: ['title', 'html_content', 'document_type'],
    },
  },
  {
    name: 'archivia_documento',
    description: `Sposta un file già caricato su Google Drive dalla Telegram Inbox alla cartella corretta sotto DOC. IMPRESA EDILE (${DRIVE_FOLDERS.DOC_IMPRESA}), creando le sottocartelle mancanti. Usa quando l'utente chiede di archiviare/spostare un file ricevuto via Telegram. Accetta drive_file_id come ID o URL Drive (/d/<id> o id=<id>).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        folder_path: { type: 'string', description: 'Percorso relativo sotto DOC. IMPRESA EDILE, es. "Automezzi/AB123CD"' },
        drive_file_id: { type: 'string', description: 'ID del file Drive già caricato, oppure URL Drive contenente /d/<id> o id=<id>' },
        filename: { type: 'string', description: 'OPZIONALE — nuovo nome file dopo lo spostamento' },
      },
      required: ['folder_path', 'drive_file_id'],
    },
  },
  // FIX W1.3 Task 2-3: full-text search + lettura binari
  {
    name: 'drive_search_fulltext',
    description: 'Cerca file nel Drive di Restruktura per CONTENUTO testuale (NON solo nome). Usa per trovare documenti che parlano di un argomento specifico. Ritorna max 15 file con ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Testo da cercare nel contenuto dei file' },
        folder_id: { type: 'string', description: 'ID cartella opzionale per restringere la ricerca' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_read_pdf',
    description: 'Leggi il contenuto testuale di un file PDF nel Drive di Restruktura. Limite 20MB, testo troncato a 50K char. Per PDF solo immagini il testo sarà vuoto.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'ID del file PDF nel Drive' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_read_office',
    description: 'Leggi un file Microsoft Office (DOCX o XLSX) dal Drive Restruktura. Auto-detect formato. Limite 20MB, contenuto troncato a 50K char.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'ID del file DOCX o XLSX nel Drive' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_upload_binary',
    description: 'Carica un file binario (PDF, immagine, ecc.) su Drive. Necessario per archiviare allegati ricevuti o PDF generati. Per HTML→PDF usa genera_pdf direttamente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_data_base64: { type: 'string', description: 'Contenuto file in base64' },
        filename: { type: 'string', description: 'Nome file con estensione (es. "DURC_Bianchi.pdf")' },
        mime_type: { type: 'string', description: 'Mime type (es. application/pdf)' },
        folder_id: { type: 'string', description: 'OPZIONALE — folder Drive destinazione' },
      },
      required: ['file_data_base64', 'filename', 'mime_type'],
    },
  },
]
