// src/lib/cron-auth.ts
/**
 * La porta dei cron. UNA, e in un posto solo.
 *
 * ⚠️ C43 — PERCHE' ESISTE. Undici rotte sotto `src/app/api/cron/` scrivevano
 * ciascuna la propria copia di
 *
 *     if (auth !== `Bearer ${process.env.CRON_SECRET}`) …
 *
 * senza verificare che il segreto ESISTESSE. Se `CRON_SECRET` non fosse
 * configurata — un deploy sbagliato, una variabile ruotata male, un ambiente
 * nuovo — quel confronto diventerebbe con la stringa letterale
 * `"Bearer undefined"`, che chiunque puo' scrivere a mano: la porta di undici
 * cron si aprirebbe da sola proprio nel momento in cui la configurazione e'
 * guasta. E' la stessa famiglia del ripiego silenzioso sul client anonimo —
 * **un guasto di configurazione che invece di chiudere, apre** — e in questo
 * repository quella famiglia e' gia' costata.
 *
 * Undici copie della stessa regola divergono al primo cambiamento: qui la
 * regola e' una, e ciascuna rotta la chiama.
 */
import { NextResponse } from 'next/server'

/** Quello che la guardia ha bisogno di leggere: nient'altro. */
interface RichiestaConIntestazioni {
  headers: { get(nome: string): string | null }
}

/**
 * Vero SOLO se il segreto e' configurato davvero e l'intestazione lo porta.
 *
 * Il `trim()` non e' pignoleria: su Vercel una variabile «impostata a niente»
 * esiste come stringa vuota, e senza quel controllo `Bearer ` — con lo spazio
 * e basta — sarebbe la chiave di casa.
 */
export function segretoCronValido(request: RichiestaConIntestazioni): boolean {
  const segreto = process.env.CRON_SECRET
  if (typeof segreto !== 'string' || segreto.trim() === '') return false
  return request.headers.get('authorization') === `Bearer ${segreto}`
}

/**
 * `null` se si puo' procedere, altrimenti il 401 da restituire.
 *
 * Il corpo e' un parametro perche' le rotte non rispondevano tutte con la
 * stessa frase, e cambiargliela sarebbe stato un effetto collaterale di una
 * correzione di sicurezza — cioe' un secondo cambiamento nascosto dentro il
 * primo. La GUARDIA resta una: cambia solo la frase.
 */
export function rispostaSeFuoriDalCron(
  request: RichiestaConIntestazioni,
  corpo: Record<string, unknown> = { ok: false, error: 'unauthorized' },
): NextResponse | null {
  if (segretoCronValido(request)) return null
  return NextResponse.json(corpo, { status: 401 })
}
