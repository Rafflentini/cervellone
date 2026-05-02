import { google } from 'googleapis'

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

// Cerca file per nome in tutto il Drive o in una cartella
export async function searchFiles(query: string, folderId?: string): Promise<string> {
  console.log(`[DRIVE] searchFiles query="${query}" folder="${folderId || 'root'}"`)
  try {
    const drive = await getDrive()
    let q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`
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

// FIX W1.3 Task 2: ricerca per CONTENUTO testuale (full-text indexed da Drive)
export async function searchFilesFullText(query: string, folderId?: string): Promise<string> {
  console.log(`[DRIVE] searchFilesFullText query="${query}" folder="${folderId || 'root'}"`)
  try {
    const drive = await getDrive()
    let q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`
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
]
