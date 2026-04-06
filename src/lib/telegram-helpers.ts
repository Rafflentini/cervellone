/**
 * lib/telegram-helpers.ts — Funzioni helper per Telegram
 * Estratte dalla route per riuso in altri moduli.
 */

const TELEGRAM_API = 'https://api.telegram.org/bot'

export async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  const MAX_LEN = 4000
  const chunks: string[] = []
  if (text.length <= MAX_LEN) {
    chunks.push(text)
  } else {
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LEN) { chunks.push(remaining); break }
      let cutAt = remaining.lastIndexOf('\n\n', MAX_LEN)
      if (cutAt < 500) cutAt = remaining.lastIndexOf('\n', MAX_LEN)
      if (cutAt < 500) cutAt = MAX_LEN
      chunks.push(remaining.slice(0, cutAt))
      remaining = remaining.slice(cutAt).trimStart()
    }
  }
  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
    }).catch(async () => {
      // Fallback senza parse_mode se Markdown fallisce (caratteri speciali)
      await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }).catch(() => {})
    })
  }
}

export async function sendTyping(chatId: number) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`${TELEGRAM_API}${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {})
}

export async function downloadTelegramFile(fileId: string): Promise<{ buffer: ArrayBuffer; fileName: string; mimeType: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData.result?.file_path
  if (!filePath) return null
  const fileName = filePath.split('/').pop() || 'file'
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet', csv: 'text/csv',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic',
    dwg: 'application/acad', dxf: 'application/dxf',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    xml: 'application/xml', html: 'text/html',
    zip: 'application/zip',
  }
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!res.ok) return null
  return { buffer: await res.arrayBuffer(), fileName, mimeType: mimeMap[ext] || 'application/octet-stream' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { buffer, fileName, mimeType } = fileData
  const base64 = Buffer.from(buffer).toString('base64')

  if (mimeType === 'application/pdf') {
    return [{ type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }]
  }
  if (mimeType.startsWith('image/')) {
    return [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }]
  }
  if (mimeType.includes('word') || mimeType === 'application/msword') {
    try {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ arrayBuffer: buffer })
      if (result.value && result.value.length > 50) {
        return [{ type: 'text', text: `[File Word: ${fileName}]\n\n${result.value}` }]
      }
    } catch { /* ignore */ }
  }
  // ODS
  if (fileName.endsWith('.ods')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(Buffer.from(buffer))
      const xml = await zip.file('content.xml')?.async('string')
      if (xml) {
        const rows: string[] = []
        const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g
        let rm
        while ((rm = rowRe.exec(xml)) !== null) {
          const cells: string[] = []
          const cellRe = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
          let cm
          while ((cm = cellRe.exec(rm[1])) !== null) {
            const txt = (cm[2] || '').replace(/<[^>]+>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&apos;/g,"'").trim()
            if (txt) cells.push(txt)
          }
          if (cells.length >= 2) rows.push(cells.join(' | '))
        }
        const text = rows.slice(0, 3000).join('\n')
        if (text.length > 50) {
          return [{ type: 'text', text: `[File ODS: ${fileName} — ${rows.length} righe]\n\n${text.slice(0, 100000)}` }]
        }
      }
    } catch { /* ignore */ }
  }
  // CSV/TXT
  if (fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
    const text = Buffer.from(buffer).toString('utf-8')
    if (text.length > 50) {
      return [{ type: 'text', text: `[File ${fileName}]\n\n${text.slice(0, 100000)}` }]
    }
  }
  // Excel
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(Buffer.from(buffer))
      const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
      if (shared) {
        const texts: string[] = []
        const re = /<t[^>]*>([\s\S]*?)<\/t>/g
        let m
        while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
        if (texts.length > 0) {
          return [{ type: 'text', text: `[File Excel: ${fileName}]\n\n${texts.join(' | ').slice(0, 100000)}` }]
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback: prova come testo
  try {
    const text = Buffer.from(buffer).toString('utf-8')
    const printable = text.replace(/[^\x20-\x7E\r\n\t\xC0-\xFF]/g, '')
    if (printable.length > text.length * 0.5 && text.length > 50) {
      return [{ type: 'text', text: `[File: ${fileName}]\n\n${text.slice(0, 100000)}` }]
    }
  } catch { /* ignore */ }
  return [{ type: 'text', text: `[File binario: ${fileName}, ${(buffer.byteLength / 1024).toFixed(0)} KB]` }]
}

export async function transcribeAudio(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return ''
  const fileRes = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  })
  const fileData = await fileRes.json()
  const filePath = fileData.result?.file_path
  if (!filePath) return ''
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  const audioBuffer = await audioRes.arrayBuffer()
  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg')
  formData.append('model', 'whisper-1')
  formData.append('language', 'it')
  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  })
  if (!whisperRes.ok) return ''
  const data = await whisperRes.json()
  return data.text || ''
}
