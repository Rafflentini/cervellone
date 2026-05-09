/**
 * Cervellone V19 — Bundle CIGO files in un singolo ZIP
 */

import JSZip from 'jszip'
import type { CigoFileEntry } from './types'

export async function zipCigoFiles(files: CigoFileEntry[]): Promise<Buffer> {
  const zip = new JSZip()
  for (const f of files) {
    zip.file(f.name, f.buffer)
  }
  const out = await zip.generateAsync({ type: 'nodebuffer' })
  return Buffer.isBuffer(out) ? out : Buffer.from(out as any)
}
