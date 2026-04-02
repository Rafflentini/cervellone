import { google } from 'googleapis'

// Autenticazione con service account
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}')
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  })
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() })
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() })
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
    const drive = getDrive()
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
  try {
    const drive = getDrive()
    let q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`
    if (folderId) q += ` and '${folderId}' in parents`

    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType, parents, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 20,
    })

    const files = res.data.files || []
    if (files.length === 0) return `Nessun file trovato per "${query}".`

    const lines = files.map(f => {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder'
      return `${isFolder ? '📁' : '📄'} ${f.name} [ID: ${f.id}]`
    })

    return `${files.length} risultati per "${query}":\n${lines.join('\n')}`
  } catch (err) {
    return `Errore nella ricerca: ${err}`
  }
}

// Crea una cartella
export async function createFolder(name: string, parentId: string): Promise<string> {
  try {
    const drive = getDrive()
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
    const drive = getDrive()
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
    const drive = getDrive()
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
    const drive = getDrive()
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
    const drive = getDrive()

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
    const docs = google.docs({ version: 'v1', auth: getAuth() })
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
    const sheets = getSheets()
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
    const sheets = getSheets()
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
    const sheets = getSheets()
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
]
