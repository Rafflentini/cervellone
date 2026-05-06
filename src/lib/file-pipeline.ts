/**
 * lib/file-pipeline.ts — pipeline universale lettura file
 *
 * HYBRID architecture:
 * - NATIVE fast path: PDF/img/Word/Excel/CSV/TXT/ODS via base64 content blocks (logica esistente)
 * - CUSTOM via Anthropic Files API → container_upload → code_execution + Python lib
 *
 * Spec: docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md
 */

import Anthropic, { toFile } from '@anthropic-ai/sdk'
import { supabase } from './supabase'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlockParam = any  // Anthropic.Messages.ContentBlockParam (avoid namespace import quirks)

export type FileInput = {
  buffer: ArrayBuffer | Buffer
  fileName: string
  mimeType: string
}

export type Strategy = 'native' | 'files-api' | 'fallback-text' | 'metadata-only'

export type PipelineResult = {
  blocks: ContentBlockParam[]
  strategy: Strategy
  uploadedFileId?: string
}

const NATIVE_MIMES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain',
  'text/csv',
  'text/markdown',
])

export function detectStrategy(mimeType: string, _fileName: string): 'native' | 'files-api' {
  if (mimeType.startsWith('image/')) return 'native'
  if (NATIVE_MIMES.has(mimeType)) return 'native'
  return 'files-api'
}

/**
 * processNative — handler per formati nativi (whitelist).
 * Logica copiata 1:1 da buildContentBlocks in telegram-helpers.ts.
 * Strategy può essere 'native', 'fallback-text' (ASCII non whitelist), 'metadata-only' (binario non riconosciuto).
 */
export async function processNative(input: FileInput): Promise<PipelineResult> {
  const { buffer, fileName, mimeType } = input
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
  const base64 = buf.toString('base64')

  // PDF → document block
  if (mimeType === 'application/pdf') {
    return {
      blocks: [{ type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }],
      strategy: 'native',
    }
  }
  // Image → image block
  if (mimeType.startsWith('image/')) {
    return {
      blocks: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }],
      strategy: 'native',
    }
  }
  // Word → mammoth text extraction
  if (mimeType.includes('word') || mimeType === 'application/msword') {
    try {
      const mammoth = await import('mammoth')
      // mammoth richiede ArrayBuffer
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer as ArrayBuffer })
      if (result.value && result.value.length > 50) {
        return {
          blocks: [{ type: 'text', text: `[File Word: ${fileName}]\n\n${result.value}` }],
          strategy: 'native',
        }
      }
    } catch { /* ignore */ }
  }
  // ODS → JSZip XML extract
  if (fileName.endsWith('.ods')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
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
            const txt = (cm[2] || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'").trim()
            if (txt) cells.push(txt)
          }
          if (cells.length >= 2) rows.push(cells.join(' | '))
        }
        const text = rows.slice(0, 3000).join('\n')
        if (text.length > 50) {
          return {
            blocks: [{ type: 'text', text: `[File ODS: ${fileName} — ${rows.length} righe]\n\n${text.slice(0, 100000)}` }],
            strategy: 'native',
          }
        }
      }
    } catch { /* ignore */ }
  }
  // CSV/TXT/markdown
  if (fileName.endsWith('.csv') || fileName.endsWith('.txt') || fileName.endsWith('.md')) {
    const text = buf.toString('utf-8')
    if (text.length > 50) {
      return {
        blocks: [{ type: 'text', text: `[File ${fileName}]\n\n${text.slice(0, 100000)}` }],
        strategy: 'native',
      }
    }
  }
  // Excel
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
      const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
      if (shared) {
        const texts: string[] = []
        const re = /<t[^>]*>([\s\S]*?)<\/t>/g
        let m
        while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
        if (texts.length > 0) {
          return {
            blocks: [{ type: 'text', text: `[File Excel: ${fileName}]\n\n${texts.join(' | ').slice(0, 100000)}` }],
            strategy: 'native',
          }
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback testo se ASCII printable
  try {
    const text = buf.toString('utf-8')
    const printable = text.replace(/[^\x20-\x7E\r\n\t\xC0-\xFF]/g, '')
    if (printable.length > text.length * 0.5 && text.length > 50) {
      return {
        blocks: [{ type: 'text', text: `[File: ${fileName}]\n\n${text.slice(0, 100000)}` }],
        strategy: 'fallback-text',
      }
    }
  } catch { /* ignore */ }
  // Ultima risorsa: metadata-only
  return {
    blocks: [{ type: 'text', text: `[File binario: ${fileName}, ${(buf.byteLength / 1024).toFixed(0)} KB]` }],
    strategy: 'metadata-only',
  }
}

// ─── uploadToAnthropic ────────────────────────────────────────────────────────

const FILES_API_BETA = 'files-api-2025-04-14'

const anthropicClient = new Anthropic()

/**
 * uploadToAnthropic — uploads buffer to Anthropic Files API + tracks in DB.
 * Throws on failure (no fallback here — caller handles).
 */
export async function uploadToAnthropic(input: FileInput): Promise<{ fileId: string }> {
  const { buffer, fileName, mimeType } = input
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer)

  // Convert Buffer → Uploadable (Anthropic SDK helper toFile)
  const uploadable = await toFile(buf, fileName, { type: mimeType || 'application/octet-stream' })

  console.log(`[FILE-PIPELINE] uploadToAnthropic begin file=${fileName} size=${buf.byteLength}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await anthropicClient.beta.files.upload(
    { file: uploadable },
    { headers: { 'anthropic-beta': FILES_API_BETA } }
  )

  const fileId = result?.id
  if (!fileId) throw new Error('Files API: missing id in upload response')

  console.log(`[FILE-PIPELINE] uploadToAnthropic ok fileId=${fileId} file=${fileName}`)

  // Track in DB (best-effort: se DB fail, non bloccare l'upload).
  // Pattern: Supabase JS v2 ritorna {error} invece di throw → leggere error esplicitamente.
  // try/catch per sicurezza extra (errori transport-level che eccezionalmente fanno throw).
  try {
    const { error: dbError } = await supabase.from('cervellone_anthropic_files').insert({
      file_id: fileId,
      original_filename: fileName,
      mime_type: mimeType || null,
      size_bytes: buf.byteLength,
    })
    if (dbError) {
      console.warn(`[FILE-PIPELINE] DB tracking insert failed (non-fatal): ${dbError.message}`)
    }
  } catch (err) {
    console.warn(`[FILE-PIPELINE] DB tracking transport error (non-fatal):`, err instanceof Error ? err.message : err)
  }

  return { fileId }
}

// ─── processFile (orchestrator) ──────────────────────────────────────────────

/**
 * processFile — orchestrator: detect strategy, route a processNative o uploadToAnthropic.
 * Su upload error: fallback a processNative anche se non in whitelist.
 */
export async function processFile(input: FileInput): Promise<PipelineResult> {
  const strategy = detectStrategy(input.mimeType, input.fileName)

  console.log(`[FILE-PIPELINE] processFile begin file=${input.fileName} mime=${input.mimeType} strategy=${strategy}`)

  if (strategy === 'native') {
    return processNative(input)
  }

  // strategy === 'files-api'
  try {
    const { fileId } = await uploadToAnthropic(input)
    return {
      blocks: [
        { type: 'container_upload', file_id: fileId },
        { type: 'text', text: `[File caricato nel sandbox code_execution: ${input.fileName} (${input.mimeType || 'unknown mime'})]` },
      ],
      strategy: 'files-api',
      uploadedFileId: fileId,
    }
  } catch (err) {
    console.warn(`[FILE-PIPELINE] Files API failed, fallback processNative:`, err instanceof Error ? err.message : err)
    return processNative(input)
  }
}
