import { google } from 'googleapis'
import { DRIVE_FOLDERS, SHEETS, createDocument } from './drive'

export type DocumentType =
  | 'pos'
  | 'preventivo'
  | 'cme'
  | 'perizia'
  | 'relazione'
  | 'scia'
  | 'cila'
  | 'altro'

interface ResolvedFolder {
  folderId: string
  folderPath: string
  isFallback: boolean
  matchedClient?: string
}

interface SaveResult {
  driveUrl: string
  folderPath: string
  isFallback: boolean
  fileName: string
  fileId: string
  registroAppended: boolean
}

// ── Inferenza tipo documento ──

export function inferDocumentType(htmlContent: string, userPrompt: string): DocumentType {
  const text = (htmlContent + ' ' + userPrompt).toLowerCase()
  // Ordine importante: pattern più specifici prima
  if (/\bpiano\s+operativo\s+(?:di\s+)?sicurezza|\bp\.?o\.?s\.?\b/i.test(text)) return 'pos'
  if (/\bcomputo\s+metric|\bc\.?m\.?e\.?\b/i.test(text)) return 'cme'
  if (/\bperizia/i.test(text)) return 'perizia'
  if (/\brelazione\s+(?:di\s+)?(?:calcol|tecnic|geologic)/i.test(text)) return 'relazione'
  if (/\bscia\b|segnalazione\s+certif/i.test(text)) return 'scia'
  if (/\bcila\b|comunicazione\s+inizio\s+lavori/i.test(text)) return 'cila'
  if (/\bpreventiv|\bofferta\b/i.test(text)) return 'preventivo'
  return 'altro'
}

// ── Estrazione nome cliente/cantiere dal prompt ──

export function extractClientName(prompt: string, recentHistory: string): string | null {
  const ctx = prompt + ' ' + recentHistory
  // Pattern: cattura sequenza di 1-4 parole capitalizzate (cognome+nome+...).
  // Il lookahead richiede `\s+keyword\s` (con spazio DOPO la keyword) per evitare
  // di matchare la "A" di "Antonio"/"ABC" come alternativa "a".
  // wordSeq cattura SOLO parole capitalizzate (cognome+nome). NO flag /i per
  // mantenere [A-ZÀ-Ý] case-sensitive — altrimenti "in via Roma" verrebbe
  // catturato come parte della sequenza.
  const wordSeq = `[A-ZÀ-Ý][\\wà-ÿ']+(?:\\s+[A-ZÀ-Ý][\\wà-ÿ']+){0,3}`
  const stopAhead = `(?=\\s+(?:[Ii]n|[Aa]|[Vv]ia|[Pp]resso|[Dd]el|[Dd]ella|[Ii]l|[Ll]a|[Aa]l|[Aa]lla|[Ss]ul|[Ss]ulla)\\s|[—,.]|\\s*$)`
  const patterns = [
    new RegExp(`(?:[Cc]antiere|[Pp]er\\s+i?l?\\s*[Cc]antiere)\\s+(${wordSeq})${stopAhead}`),
    new RegExp(`(?:[Cc]liente|[Ss]ig\\.?(?:\\s*[Rr]a)?|[Ss]ignor[ae]?)\\s+(${wordSeq})${stopAhead}`),
    new RegExp(`\\b[Pp]er\\s+(${wordSeq})${stopAhead}`),
  ]
  for (const re of patterns) {
    const m = ctx.match(re)
    if (m && m[1]) {
      const name = m[1].trim()
      // Filtra parole troppo generiche
      if (name.length >= 3 && !/^(?:il|la|un|una|cantiere|cliente|signor[ae]?)$/i.test(name)) {
        return name
      }
    }
  }
  return null
}

// ── Helper Google Drive client ──
// FIX W1.3.5: usa OAuth-first → SA fallback come drive.ts (consistente).
// Lazy import di google-oauth per evitare side-effect supabase a test time.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAuth(): Promise<any> {
  try {
    const { getAuthorizedClient } = await import('./google-oauth')
    const oauthClient = await getAuthorizedClient()
    if (oauthClient) return oauthClient
  } catch (err) {
    console.error('[DRIVE-SAVER] OAuth lookup failed, fallback to SA:', err instanceof Error ? err.message : err)
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}')
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  })
}

async function getDriveClient() {
  const auth = await getAuth()
  return {
    drive: google.drive({ version: 'v3', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  }
}

// ── Lookup cliente in CANTIERI ATTIVI / STUDIO_ATTIVI ──

async function findClientFolderInParent(
  parentFolderId: string,
  clientName: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const { drive } = await getDriveClient()
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 200,
    })
    const folders = res.data.files || []
    const queryLower = clientName.toLowerCase()
    // Match: nome contiene query o viceversa (cognome match)
    for (const f of folders) {
      const fname = (f.name || '').toLowerCase()
      if (fname.includes(queryLower) || queryLower.includes(fname.split(/\s+|\-/)[0] || '')) {
        return { id: f.id || '', name: f.name || '' }
      }
    }
    return null
  } catch (err) {
    console.error('[DRIVE-SAVER] findClientFolderInParent error:', err)
    return null
  }
}

// ── Risoluzione cartella destinazione (Y + fallback X) ──

const FALLBACK_FOLDERS: Record<DocumentType, string> = {
  pos: DRIVE_FOLDERS.POS,
  preventivo: DRIVE_FOLDERS.STUDIO_ATTIVI,
  cme: DRIVE_FOLDERS.STUDIO_ATTIVI,
  perizia: DRIVE_FOLDERS.STUDIO_ATTIVI,
  relazione: DRIVE_FOLDERS.STUDIO_ATTIVI,
  scia: DRIVE_FOLDERS.STUDIO_ATTIVI,
  cila: DRIVE_FOLDERS.STUDIO_ATTIVI,
  altro: DRIVE_FOLDERS.STUDIO_ATTIVI,
}

const FALLBACK_PATHS: Record<DocumentType, string> = {
  pos: '/IMPRESA EDILE/DOC. IMPRESA EDILE/POS/',
  preventivo: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  cme: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  perizia: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  relazione: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  scia: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  cila: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
  altro: '/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/_Bozze/',
}

export async function resolveTargetFolder(
  docType: DocumentType,
  userPrompt: string,
  recentHistory: string,
): Promise<ResolvedFolder> {
  const clientName = extractClientName(userPrompt, recentHistory)
  console.log(`[DRIVE-SAVER] resolveTargetFolder type=${docType} client="${clientName}"`)

  if (clientName && clientName.length >= 3) {
    // Documenti tecnici → cerca in STUDIO_ATTIVI
    if (['preventivo', 'cme', 'perizia', 'relazione'].includes(docType)) {
      const found = await findClientFolderInParent(DRIVE_FOLDERS.STUDIO_ATTIVI, clientName)
      if (found) {
        return {
          folderId: found.id,
          folderPath: `/STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI/${found.name}/`,
          isFallback: false,
          matchedClient: found.name,
        }
      }
    }
    // POS/SCIA/CILA → cerca in CANTIERI_ATTIVI
    if (['pos', 'scia', 'cila'].includes(docType)) {
      const found = await findClientFolderInParent(DRIVE_FOLDERS.CANTIERI_ATTIVI, clientName)
      if (found) {
        return {
          folderId: found.id,
          folderPath: `/IMPRESA EDILE/CANTIERI/ATTIVI/${found.name}/`,
          isFallback: false,
          matchedClient: found.name,
        }
      }
    }
  }

  // Fallback X
  return {
    folderId: FALLBACK_FOLDERS[docType],
    folderPath: FALLBACK_PATHS[docType],
    isFallback: true,
  }
}

// ── Helper: build history context ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildHistoryContext(history: any[]): string {
  return history
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .slice(-3)
    .join(' ')
}

// ── Save documento HTML come Google Doc nella cartella matched ──

export async function saveDocumentToDrive(
  htmlContent: string,
  title: string,
  docType: DocumentType,
  userPrompt: string,
  recentHistory: string,
): Promise<SaveResult> {
  const target = await resolveTargetFolder(docType, userPrompt, recentHistory)
  const timestamp = new Date().toISOString().slice(0, 10)
  const safeTitle = title.replace(/[^\w\s\-]/g, '').trim().slice(0, 80) || 'Documento'
  const fileName = `${safeTitle}_${timestamp}`

  console.log(`[DRIVE-SAVER] saveDocumentToDrive type=${docType} folder="${target.folderPath}" fallback=${target.isFallback}`)

  // Strategia: convertiamo HTML → testo plain (strip tag), usiamo createDocument
  // esistente in drive.ts (testato in Task 1). Il Google Doc avrà testo flat,
  // non layout HTML rendered, ma è funzionale e affidabile.
  const plainText = htmlContent
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

  const result = await createDocument(fileName, plainText, target.folderId)
  console.log(`[DRIVE-SAVER] createDocument result: ${result.slice(0, 200)}`)

  // createDocument ritorna stringa con format "Documento "X" creato.\nLink: URL\n[ID: id]"
  const idMatch = result.match(/\[ID:\s*([^\]]+)\]/)
  const linkMatch = result.match(/Link:\s*(https?:\/\/\S+)/)
  const fileId = idMatch?.[1] || ''
  const driveUrl = linkMatch?.[1] || ''

  if (!fileId || !driveUrl) {
    throw new Error(`createDocument failed: ${result.slice(0, 300)}`)
  }
  console.log(`[DRIVE-SAVER] uploaded fileId=${fileId} url=${driveUrl}`)

  // Append a REGISTRO appropriato (best effort, non blocca su errori)
  let registroAppended = false
  try {
    registroAppended = await appendToRegistro(docType, target, fileName, driveUrl, userPrompt)
  } catch (err) {
    console.error('[DRIVE-SAVER] appendToRegistro failed:', err)
  }

  return {
    driveUrl,
    folderPath: target.folderPath,
    isFallback: target.isFallback,
    fileName,
    fileId,
    registroAppended,
  }
}

async function appendToRegistro(
  docType: DocumentType,
  target: ResolvedFolder,
  fileName: string,
  driveUrl: string,
  userPrompt: string,
): Promise<boolean> {
  // POS/SCIA/CILA → REGISTRO_CANTIERI; preventivi/perizie/relazioni → REGISTRO_PROGETTI
  const isCantiere = ['pos', 'scia', 'cila'].includes(docType)
  const spreadsheetId = isCantiere ? SHEETS.REGISTRO_CANTIERI : SHEETS.REGISTRO_PROGETTI
  const range = 'A:H' // append finale, sheet stesso

  const today = new Date().toLocaleDateString('it-IT')
  const cliente = target.matchedClient || '(non identificato)'
  const tipoLavoro = userPrompt.slice(0, 100)
  const stato = 'In bozza'

  // Schema generico (l'utente potrà adattarlo allo schema reale del registro):
  // [data, tipo, cliente, tipo_lavoro, file_name, drive_url, stato, note]
  const row = [today, docType.toUpperCase(), cliente, tipoLavoro, fileName, driveUrl, stato, 'auto-save Cervellone']

  const { sheets } = await getDriveClient()
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })
  console.log(`[DRIVE-SAVER] appendToRegistro ok updatedRows=${res.data.updates?.updatedRows}`)
  return true
}
