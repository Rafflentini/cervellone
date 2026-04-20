export const maxDuration = 300 // 5 minuti — limite piano Hobby Vercel

import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'
import { PDFParse } from 'pdf-parse'
import { supabase } from '@/lib/supabase'
import { saveProjectKnowledge } from '@/lib/memory'
import { digestDocument, chunkDigest } from '@/lib/digest'
import { getConfig } from '@/lib/claude'

type FileReport = {
  name: string
  status: 'digested' | 'preserved' | 'failed' | 'skipped'
  method?: string
  error?: string
  chars?: number
}

// ===== ESTRAZIONE TESTO — SISTEMA A CASCATA COMPLETO =====
// Un agente vero non si arrende: prova TUTTO finché non riesce.

import Anthropic from '@anthropic-ai/sdk'
const anthropicClient = new Anthropic()

// Metodo 1: pdf-parse v2 (locale, gratis, veloce — funziona con PDF testuali)
async function pdfMethod1_PdfParse(buf: Buffer, fileName: string): Promise<string> {
  const parser = new PDFParse({ data: buf })
  try {
    const result = await parser.getText()
    const textLen = result.text.trim().length
    const fileSizeKB = Math.round(buf.length / 1024)
    const charsPerKB = textLen / fileSizeKB

    if (textLen < 50) throw new Error('Testo insufficiente (< 50 car)')

    // Se il rapporto testo/dimensione è troppo basso, è un PDF scansionato
    // Un PDF testuale ha ~10-50 car/KB, uno scansionato ha < 1 car/KB
    if (charsPerKB < 2 && fileSizeKB > 100) {
      console.log(`  ⚠️ pdf-parse: "${fileName}" → solo ${textLen} car per ${fileSizeKB}KB (${charsPerKB.toFixed(1)} car/KB) — probabilmente scansionato`)
      throw new Error(`PDF scansionato: ${textLen} car per ${fileSizeKB}KB è troppo poco`)
    }

    console.log(`  ✅ Metodo 1 (pdf-parse v2): "${fileName}" → ${textLen} car (${charsPerKB.toFixed(1)} car/KB)`)
    return result.text
  } finally {
    await parser.destroy()
  }
}

// Metodo 2: Claude API con tipo "document" (PDF nativi — legge anche scansioni)
async function pdfMethod2_ClaudeDocument(buf: Buffer, fileName: string): Promise<string> {
  const base64Data = buf.toString('base64')
  const message = await anthropicClient.messages.create({
    model: (await getConfig()).model,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
        { type: 'text', text: `Questo è il documento "${fileName}". Potrebbe essere un PDF scansionato (immagini di pagine).
Estrai TUTTO il testo visibile, pagina per pagina. Includi:
- Ogni parola, numero, data, codice
- Intestazioni e piè di pagina
- Contenuto di tabelle (riproduci in formato testo)
- Note a margine
NON riassumere. Trascrivi TUTTO il contenuto integrale.` },
      ],
    }],
  })
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  if (text.trim().length < 200) throw new Error(`Testo insufficiente: ${text.trim().length} car`)
  console.log(`  ✅ Metodo 2 (Claude document): "${fileName}" → ${text.length} car`)
  return text
}

// Metodo 3: Ricostruisci buffer da Uint8Array e riprova Claude
async function pdfMethod3_ClaudeRebuiltBuffer(buf: Buffer, fileName: string): Promise<string> {
  // Ricostruisci il buffer da Uint8Array per evitare problemi di offset/SharedArrayBuffer
  const cleanBuf = Buffer.from(new Uint8Array(buf))
  const base64Data = cleanBuf.toString('base64')
  const message = await anthropicClient.messages.create({
    model: (await getConfig()).model,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
        { type: 'text', text: `Estrai TUTTO il testo di questo PDF "${fileName}". Contenuto integrale.` },
      ],
    }],
  })
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  if (text.trim().length < 50) throw new Error('Testo insufficiente')
  console.log(`  ✅ Metodo 3 (Claude rebuilt buffer): "${fileName}" → ${text.length} car`)
  return text
}

// Metodo 4: Claude visione — converti ogni pagina del PDF in immagine PNG e falla "guardare"
async function pdfMethod4_ClaudeVision(buf: Buffer, fileName: string): Promise<string> {
  // Usa pdf-parse per ottenere il numero di pagine, poi invia il raw PDF come immagine
  // In realtà, inviamo il PDF intero come immagine — Claude supporta PDF come immagine
  const base64Data = buf.toString('base64')

  // Prova a inviare come immagine (Claude può interpretare PDF come immagine in alcuni casi)
  const message = await anthropicClient.messages.create({
    model: (await getConfig()).model,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Data } },
        { type: 'text', text: `Questo è un documento PDF convertito in immagine. Estrai TUTTO il testo visibile. File: "${fileName}"` },
      ],
    }],
  })
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  if (text.trim().length < 50) throw new Error('Testo insufficiente')
  console.log(`  ✅ Metodo 4 (Claude vision): "${fileName}" → ${text.length} car`)
  return text
}

// Metodo 5: Scrivi il buffer su un file temp e rileggi (fix per buffer condivisi)
async function pdfMethod5_TempFile(buf: Buffer, fileName: string): Promise<string> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')
  const tempPath = path.join(os.tmpdir(), `cervellone_${Date.now()}_${fileName.replace(/[/\\]/g, '_')}`)

  await fs.writeFile(tempPath, buf)
  const freshBuf = await fs.readFile(tempPath)
  await fs.unlink(tempPath).catch(() => {})

  // Riprova pdf-parse v2 con il buffer fresco
  const parser = new PDFParse({ data: freshBuf })
  try {
    const data = await parser.getText()
    if (data.text.trim().length < 50) {
      // Riprova Claude con buffer fresco
      const base64Data = freshBuf.toString('base64')
      const message = await anthropicClient.messages.create({
        model: (await getConfig()).model,
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
            { type: 'text', text: `Estrai TUTTO il testo di questo PDF "${fileName}". Contenuto integrale.` },
          ],
        }],
      })
      const text = message.content[0].type === 'text' ? message.content[0].text : ''
      if (text.trim().length < 50) throw new Error('Testo insufficiente anche da file temp')
      console.log(`  ✅ Metodo 5 (temp file + Claude): "${fileName}" → ${text.length} car`)
      return text
    }
    console.log(`  ✅ Metodo 5 (temp file + pdf-parse): "${fileName}" → ${data.text.length} car`)
    return data.text
  } finally {
    await parser.destroy()
  }
}

// Metodo 6: Estrai raw bytes con arraybuffer e ricostruisci
async function pdfMethod6_ArrayBuffer(entry: JSZip.JSZipObject, fileName: string): Promise<string> {
  const ab = await entry.async('arraybuffer')
  const buf = Buffer.from(new Uint8Array(ab))

  // Verifica magic bytes PDF
  const header = buf.slice(0, 5).toString('ascii')
  if (!header.startsWith('%PDF')) {
    throw new Error(`Non è un PDF valido (header: "${header}")`)
  }

  // Prova pdf-parse v2
  const parser = new PDFParse({ data: buf })
  try {
    const data = await parser.getText()
    if (data.text.trim().length >= 50) {
      console.log(`  ✅ Metodo 6 (arraybuffer + pdf-parse): "${fileName}" → ${data.text.length} car`)
      return data.text
    }
  } finally {
    await parser.destroy()
  }

  // Prova Claude
  const base64Data = buf.toString('base64')
  const message = await anthropicClient.messages.create({
    model: (await getConfig()).model,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
        { type: 'text', text: `Estrai TUTTO il testo di questo PDF "${fileName}". Contenuto integrale.` },
      ],
    }],
  })
  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  if (text.trim().length < 50) throw new Error('Testo insufficiente')
  console.log(`  ✅ Metodo 6 (arraybuffer + Claude): "${fileName}" → ${text.length} car`)
  return text
}

// ===== CASCATA MASTER: prova TUTTI i metodi =====
async function extractPdf(buf: Buffer, fileName: string, zipEntry?: JSZip.JSZipObject): Promise<{ text: string; method: string }> {
  console.log(`PDF CASCATA: "${fileName}" (${Math.round(buf.length / 1024)}KB) — inizio tentativi...`)

  // Se i bytes iniziano con PK (ZIP), è un contenitore con immagini delle pagine (export da Claude AI)
  const header = buf.slice(0, 4).toString('ascii')
  if (header.startsWith('PK')) {
    console.log(`  📸 "${fileName}" è un ZIP con immagini pagine — estraggo e leggo con Claude Vision...`)
    try {
      const innerZip = await JSZip.loadAsync(buf)
      const imageFiles = Object.entries(innerZip.files)
        .filter(([n, e]) => !e.dir && /\.(jpe?g|png|webp|gif|bmp)$/i.test(n))
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))

      if (imageFiles.length === 0) throw new Error('Nessuna immagine trovata nel contenitore')

      console.log(`  → Trovate ${imageFiles.length} pagine immagine`)

      // Invia TUTTE le pagine a Claude Vision in un unico messaggio
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imageBlocks: any[] = []
      for (const [imgName, imgEntry] of imageFiles) {
        const imgBuf = Buffer.from(await imgEntry.async('nodebuffer'))
        const base64 = imgBuf.toString('base64')
        const ext = imgName.split('.').pop()?.toLowerCase()
        const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        })
      }

      // Processa in batch da 20 immagini (limite Claude per chiamata)
      const BATCH_SIZE = 20
      let fullText = ''
      const totalBatches = Math.ceil(imageBlocks.length / BATCH_SIZE)

      for (let batch = 0; batch < totalBatches; batch++) {
        const start = batch * BATCH_SIZE
        const end = Math.min(start + BATCH_SIZE, imageBlocks.length)
        const batchBlocks = imageBlocks.slice(start, end)
        const pageRange = `${start + 1}-${end}`

        batchBlocks.push({
          type: 'text',
          text: totalBatches === 1
            ? `Queste sono ${end - start} pagine del documento "${fileName}". Estrai TUTTO il testo visibile da ogni pagina, nell'ordine. Riproduci il contenuto integrale compresi dati, tabelle, riferimenti normativi. Non riassumere, trascrivi tutto.`
            : `Queste sono le pagine ${pageRange} di ${imageBlocks.length} del documento "${fileName}". Estrai TUTTO il testo visibile. Contenuto integrale.`,
        })

        const message = await anthropicClient.messages.create({
          model: (await getConfig()).model,
          max_tokens: 16000,
          messages: [{ role: 'user', content: batchBlocks }],
        })

        const batchText = message.content[0].type === 'text' ? message.content[0].text : ''
        if (batchText.trim().length > 0) {
          fullText += (fullText ? '\n\n--- Pagine ' + pageRange + ' ---\n\n' : '') + batchText
        }

        if (totalBatches > 1) {
          console.log(`  → Batch ${batch + 1}/${totalBatches}: pagine ${pageRange} → ${batchText.length} car`)
        }
      }

      if (fullText.trim().length > 50) {
        console.log(`  ✅ Vision OCR: "${fileName}" → ${fullText.length} car da ${imageBlocks.length} pagine (${totalBatches} batch)`)
        return { text: fullText, method: 'claude-vision-ocr' }
      }
      throw new Error('Testo insufficiente dalla visione')
    } catch (visionErr) {
      const msg = visionErr instanceof Error ? visionErr.message.slice(0, 100) : String(visionErr)
      console.log(`  ✗ Vision OCR fallito: ${msg}`)
      // Continua con gli altri metodi sotto
    }
  }

  const methods: { name: string; fn: () => Promise<string> }[] = [
    { name: 'pdf-parse', fn: () => pdfMethod1_PdfParse(buf, fileName) },
    { name: 'claude-document', fn: () => pdfMethod2_ClaudeDocument(buf, fileName) },
    { name: 'claude-rebuilt-buffer', fn: () => pdfMethod3_ClaudeRebuiltBuffer(buf, fileName) },
    { name: 'temp-file', fn: () => pdfMethod5_TempFile(buf, fileName) },
  ]

  // Aggiungi metodo 6 solo se abbiamo l'entry JSZip
  if (zipEntry) {
    methods.push({ name: 'arraybuffer-rebuild', fn: () => pdfMethod6_ArrayBuffer(zipEntry, fileName) })
  }

  // Metodo visione come ultimo resort
  methods.push({ name: 'claude-vision', fn: () => pdfMethod4_ClaudeVision(buf, fileName) })

  for (const method of methods) {
    try {
      console.log(`  → Provo metodo: ${method.name}...`)
      const text = await method.fn()
      return { text, method: method.name }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)
      console.log(`  ✗ ${method.name} fallito: ${msg}`)
    }
  }

  throw new Error(`TUTTI I METODI FALLITI per "${fileName}" — provati: ${methods.map(m => m.name).join(', ')}`)
}

// Estrai Word con mammoth
async function extractWord(buf: Buffer, fileName: string): Promise<{ text: string; method: string }> {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: buf })
    if (result.value.trim().length > 50) {
      console.log(`WORD OK: "${fileName}" → ${result.value.length} caratteri`)
      return { text: result.value, method: 'mammoth' }
    }
    throw new Error('Poco testo estratto')
  } catch (err) {
    throw new Error(`Impossibile leggere Word "${fileName}": ${err}`)
  }
}

// ===== POST — Upload e digestione =====
export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const projectName = formData.get('project') as string | null

  if (!file || !projectName) {
    return NextResponse.json({ error: 'File e nome progetto richiesti' }, { status: 400 })
  }

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const { data: project, error: projError } = await supabase
    .from('projects')
    .upsert({ slug, name: projectName, metadata: { source: 'upload' } }, { onConflict: 'slug' })
    .select()
    .single()

  if (projError || !project) {
    return NextResponse.json({ error: 'Errore creazione progetto' }, { status: 500 })
  }

  const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.htm', '.xml', '.log']
  const WORD_EXTS = ['.docx', '.doc']
  const PDF_EXTS = ['.pdf']
  const report: FileReport[] = []

  // Digerisci un file e salva
  async function digestAndSave(fileName: string, content: string, rawBuffer?: Buffer) {
    console.log(`DIGEST: studio "${fileName}" (${content.length} caratteri)...`)
    const result = await digestDocument(content, fileName)
    console.log(`DIGEST: "${fileName}" digerito (${result.digest.length} car) — ${result.shouldPreserve ? 'CONSERVA' : 'DIGEST'}`)

    const chunks = chunkDigest(result.digest)
    for (const chunk of chunks) {
      await saveProjectKnowledge(project.id, `[Progetto: ${projectName}] [File: ${fileName}]\n\n${chunk}`, fileName)
    }

    await supabase.from('documents').insert({
      project_id: project.id,
      name: `digest_${fileName}`,
      type: '.md',
      content: result.digest,
      metadata: { source: 'digest', originalFile: fileName, chunksCount: chunks.length },
    })

    if (result.shouldPreserve && rawBuffer) {
      await supabase.from('documents').insert({
        project_id: project.id,
        name: fileName,
        type: '.' + fileName.split('.').pop()?.toLowerCase(),
        content: '[FILE ORIGINALE CONSERVATO]',
        metadata: { source: 'preserved_original', reason: result.preserveReason, base64: rawBuffer.toString('base64') },
      })
    }

    return result.shouldPreserve
  }

  // Processa un singolo file
  async function processOneFile(fileName: string, ext: string, getBuffer: () => Promise<Buffer>, getText?: () => Promise<string>, zipEntry?: JSZip.JSZipObject) {
    try {
      let text = ''
      let method = ''
      let buf: Buffer | undefined

      if (TEXT_EXTS.includes(ext)) {
        text = getText ? await getText() : ''
        method = 'text-direct'
      } else if (WORD_EXTS.includes(ext)) {
        buf = await getBuffer()
        const result = await extractWord(buf, fileName)
        text = result.text
        method = result.method
      } else if (PDF_EXTS.includes(ext)) {
        buf = await getBuffer()
        const result = await extractPdf(buf, fileName, zipEntry)
        text = result.text
        method = result.method
      } else {
        report.push({ name: fileName, status: 'skipped', error: 'Formato non supportato' })
        return
      }

      if (text.trim().length <= 50) {
        report.push({ name: fileName, status: 'failed', method, error: 'Testo insufficiente' })
        return
      }

      const wasPreserved = await digestAndSave(fileName, text, buf)
      report.push({
        name: fileName,
        status: wasPreserved ? 'preserved' : 'digested',
        method,
        chars: text.length,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`ERRORE "${fileName}":`, errMsg)

      // Se Word fallisce, conserva come originale
      if (WORD_EXTS.includes(ext)) {
        try {
          const buf = await getBuffer()
          await supabase.from('documents').insert({
            project_id: project.id,
            name: fileName,
            type: ext,
            content: '[File Word non leggibile — conservato come originale]',
            metadata: { source: 'preserved_original', reason: errMsg, base64: buf.toString('base64') },
          })
          report.push({ name: fileName, status: 'preserved', error: 'Non leggibile, conservato originale' })
        } catch {
          report.push({ name: fileName, status: 'failed', error: errMsg })
        }
      } else {
        report.push({ name: fileName, status: 'failed', error: errMsg })
      }
    }
  }

  // ===== Processa tutti i file =====
  if (file.name.endsWith('.zip')) {
    const buffer = Buffer.from(await file.arrayBuffer())
    const zip = await JSZip.loadAsync(buffer)

    for (const [filename, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      if (filename.startsWith('__MACOSX') || filename.startsWith('.')) continue

      const ext = '.' + filename.split('.').pop()?.toLowerCase()
      await processOneFile(
        filename,
        ext,
        async () => Buffer.from(await entry.async('nodebuffer')),
        async () => entry.async('string'),
        entry,
      )
    }
  } else {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    await processOneFile(
      file.name,
      ext,
      async () => Buffer.from(await file.arrayBuffer()),
      async () => file.text(),
    )
  }

  // ===== REPORT FINALE =====
  const digested = report.filter(r => r.status === 'digested')
  const preserved = report.filter(r => r.status === 'preserved')
  const failed = report.filter(r => r.status === 'failed')
  const skipped = report.filter(r => r.status === 'skipped')

  console.log(`\n===== REPORT CARICAMENTO "${projectName}" =====`)
  console.log(`Totale file: ${report.length}`)
  console.log(`✅ Digeriti: ${digested.length}`)
  console.log(`📋 Conservati: ${preserved.length}`)
  console.log(`❌ Falliti: ${failed.length}`)
  console.log(`⏭️ Saltati: ${skipped.length}`)
  if (failed.length > 0) {
    console.log(`\nFILE FALLITI:`)
    failed.forEach(f => console.log(`  - ${f.name}: ${f.error}`))
  }
  console.log(`==============================================\n`)

  // Aggiorna metadati progetto
  await supabase.from('projects').update({
    metadata: {
      source: 'upload',
      report,
      filesCount: report.length,
      digestedCount: digested.length,
      preservedCount: preserved.length,
      failedCount: failed.length,
    },
  }).eq('id', project.id)

  return NextResponse.json({
    success: true,
    project: projectName,
    slug,
    projectId: project.id,
    filesExtracted: report.length,
    filesDigested: digested.length,
    filesPreserved: preserved.length,
    filesFailed: failed.length,
    files: report.map(r => r.name),
    report,
  })
}

// ===== GET — lista progetti =====
export async function GET(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('projects')
    .select('id, name, slug, metadata, created_at')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ projects: [] })
  return NextResponse.json({ projects: data })
}
