/**
 * Cervellone V19 — Runtime hallucination validator
 *
 * V18 violava la propria "REGOLA ASSOLUTA SUI FILE" (prompts.ts:172-175):
 * il bot prometteva PDF/link Drive che non aveva realmente prodotto.
 *
 * V19 valida runtime: scansiona la risposta finale del modello per URL Drive;
 * se trova URL non corrispondenti a file realmente esistenti, lancia
 * HallucinationError. Il route handler trasforma in re-prompt automatico.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 5.3
 */

import { HallucinationError } from './types'

const DRIVE_URL_RE =
  /https:\/\/(?:drive\.google\.com|docs\.google\.com)\/(?:file\/d\/|open\?id=|drive\/folders\/|spreadsheets\/d\/|document\/d\/|presentation\/d\/)([A-Za-z0-9_-]{10,})/g

export type DriveExistenceChecker = (fileId: string) => Promise<boolean>

export type HallucinationCheckOptions = {
  /** Skip the check entirely (e.g. tests). */
  skip?: boolean
  /** Custom Drive existence checker (default uses drive_* tools). */
  checker?: DriveExistenceChecker
}

/**
 * Scan response text for Drive/Docs URLs and verify each ID exists.
 * Throws HallucinationError on first invalid URL.
 */
export async function runHallucinationValidator(
  text: string,
  opts: HallucinationCheckOptions = {},
): Promise<void> {
  if (opts.skip) return
  const checker: DriveExistenceChecker = opts.checker ?? defaultDriveChecker
  const seen = new Set<string>()
  const matches = [...text.matchAll(DRIVE_URL_RE)]
  for (const match of matches) {
    const url = match[0]
    const fileId = match[1]
    if (seen.has(fileId)) continue
    seen.add(fileId)
    let exists = false
    try {
      exists = await checker(fileId)
    } catch (err) {
      // Se il checker fallisce per errore di rete/auth, NON consideriamo
      // automaticamente l'URL come hallucinato. Logghiamo e procediamo.
      console.warn('[v19/hallucination-validator] checker error:', err)
      continue
    }
    if (!exists) {
      throw new HallucinationError(
        `URL Drive/Docs riferito ma file inesistente: ${url}`,
        url,
      )
    }
  }
}

/**
 * Default checker: marca tutti gli URL come "non verificabili" (no-throw)
 * finché il drive client wrapper V19 non è disponibile. Sostituire in
 * produzione con un checker che chiama Google Drive API HEAD.
 */
async function defaultDriveChecker(_fileId: string): Promise<boolean> {
  // Placeholder: in produzione sostituire con client Drive vero.
  // Per ora ritorna true (non blocca) per evitare falsi positivi.
  // Vedi tools/v19/drive-checker.ts (TODO post-foundation).
  return true
}

/** Estrai tutti gli URL Drive/Docs trovati in un testo. */
export function extractDriveUrls(text: string): { url: string; fileId: string }[] {
  return [...text.matchAll(DRIVE_URL_RE)].map((m) => ({ url: m[0], fileId: m[1] }))
}
