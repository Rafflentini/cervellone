/**
 * lib/file-pipeline.ts — pipeline universale lettura file
 *
 * HYBRID architecture:
 * - NATIVE fast path: PDF/img/Word/Excel/CSV/TXT/ODS via base64 content blocks (logica esistente)
 * - CUSTOM via Anthropic Files API → container_upload → code_execution + Python lib
 *
 * Spec: docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md
 */

import type Anthropic from '@anthropic-ai/sdk'

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
