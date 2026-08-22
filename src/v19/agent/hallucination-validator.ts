/**
 * Cervellone V19 — Runtime hallucination validator
 *
 * V18 violava la propria "REGOLA ASSOLUTA SUI FILE" (prompts.ts:172-175):
 * il bot prometteva PDF/link Drive che non aveva realmente prodotto.
 *
 * V19 valida runtime: scansiona la risposta finale del modello per URL Drive;
 * se trova URL non corrispondenti a file realmente esistenti, lancia
 * HallucinationError.
 *
 * Il checker di default interroga DAVVERO Google Drive (`files.get`): prima era
 * uno stub `return true`, quindi il validatore non invalidava mai nulla.
 * Chiamanti: `src/v19/agent/loop.ts` e — path di produzione Telegram —
 * `src/lib/agent-job.ts`, che invece di rilanciare appende un avviso all'utente.
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
 * Status HTTP di un errore gaxios/googleapis, senza `any`.
 * (`classifyGoogleError` non espone lo status: qui serve solo per isolare il 404.)
 */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const rec = err as Record<string, unknown>
  if (typeof rec.status === 'number') return rec.status
  // gaxios: `code` è numerico solo per errori API-level (AIP-193)
  if (typeof rec.code === 'number') return rec.code
  const response = rec.response
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/**
 * Checker Drive VERO.
 *
 * Semantica deliberata — è il cuore del fix:
 *   - `files.get` riuscito                 → `true`  (il file esiste)
 *   - 404 / file non trovato               → `false` (allucinazione: il bot ha
 *                                            citato un file che non ha prodotto)
 *   - 401/403/rete/quota/token morto       → LANCIA. Il chiamante tratta il caso
 *                                            come "non verificabile" e prosegue.
 *
 * Il terzo ramo è quello che evita il danno peggiore: un refresh token Google
 * scaduto renderebbe TUTTI i link "inesistenti" e l'utente vedrebbe un avviso
 * di allucinazione su file perfettamente reali. La classificazione la fa
 * `classifyGoogleError` (google-token-health), non una euristica locale.
 *
 * Auth: SOLO `getAuthorizedClient()` — lo stesso client OAuth che drive.ts prova
 * per primo. NIENTE fallback Service Account (a differenza di drive.ts): il SA è
 * un principal DIVERSO che non vede i file dell'utente e risponderebbe 404 su
 * file esistenti, cioè esattamente il falso positivo che stiamo evitando.
 *
 * Import dinamici: costo zero quando il testo non contiene link Drive (il
 * chiamante non entra mai qui) ed evita i side-effect a load-time di
 * supabase-server nel modulo v19 (stesso motivo documentato in drive.ts).
 */
export async function defaultDriveChecker(fileId: string): Promise<boolean> {
  const [{ google }, { getAuthorizedClient }, tokenHealth] = await Promise.all([
    import('googleapis'),
    import('@/lib/google-oauth'),
    import('@/lib/google-token-health'),
  ])

  // Può lanciare GoogleAuthDeadError: si propaga → "non verificabile".
  // Casella dichiarata esplicitamente: nel Task 4 arriverà dalla società attiva.
  const { getSocieta } = await import('@/lib/societa')
  const auth = await getAuthorizedClient(getSocieta('restruktura').googleAccount)
  if (!auth) {
    throw new Error(
      '[v19/hallucination-validator] nessun client OAuth Google: esistenza file non verificabile',
    )
  }

  const drive = google.drive({ version: 'v3', auth })
  try {
    await drive.files.get({ fileId, fields: 'id', supportsAllDrives: true })
    return true
  } catch (err) {
    if (err instanceof tokenHealth.GoogleAuthDeadError) throw err
    const kind = tokenHealth.classifyGoogleError(err)
    // dead/scope/config = auth rotta; transient = rete o quota. Mai "inesistente".
    if (tokenHealth.isFatalGoogleAuthKind(kind) || kind === 'transient') throw err
    if (httpStatusOf(err) === 404) return false
    // Sconosciuto: nel dubbio NON accusiamo il bot di allucinare.
    throw err
  }
}

/** Estrai tutti gli URL Drive/Docs trovati in un testo. */
export function extractDriveUrls(text: string): { url: string; fileId: string }[] {
  return [...text.matchAll(DRIVE_URL_RE)].map((m) => ({ url: m[0], fileId: m[1] }))
}
