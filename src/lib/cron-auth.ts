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
import { confrontoCostante } from './confronto-costante'

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
 *
 * ⚠️ E NON SI CHIUDE IN SILENZIO. La correzione trasforma un guasto che APRIVA
 * in un guasto che CHIUDE, ed e' giusto — ma un guasto che chiude in silenzio
 * su undici cron e' la forma esatta dei difetti che questa casa si e' gia'
 * presa: sei rapporti di autodiagnosi mai consegnati, quattro mesi di fatture
 * estere a zero. Se il segreto manca lo si SCRIVE, come fa gia' il caso
 * gemello in `auth.ts` per AUTH_SECRET. Un bearer semplicemente SBAGLIATO non
 * logga niente: quello e' rumore, e un log che urla sempre non lo legge piu'
 * nessuno.
 */
export function segretoCronValido(request: RichiestaConIntestazioni): boolean {
  const grezzo = process.env.CRON_SECRET
  if (typeof grezzo !== 'string' || grezzo.trim() === '') {
    console.error('[cron] CRON_SECRET non configurato: nessun cron viene autorizzato.')
    return false
  }

  /**
   * ⚠️ Si confronta il segreto RIPULITO, e lo si dice.
   *
   * Il `trim()` qui sopra VALIDAVA senza NORMALIZZARE: un `CRON_SECRET` che
   * finisce con un a-capo superava il controllo e poi non poteva piu'
   * combaciare con nessuna intestazione — undici cron a 401 per sempre, in
   * silenzio, per una variabile scritta male. Non e' un'ipotesi: in questa
   * casa `TOOL_DEFER` e' valso letteralmente `"1\n"` per giorni, perche'
   * scritta con `echo` invece che con `printf`, e la Strada C e' rimasta spenta
   * mentre tutti la credevano accesa.
   *
   * `interruttori.ts` ha gia' deciso come si fa: si ripulisce E si avvisa. La
   * cura silenziosa nasconderebbe la variabile scritta male; l'avviso la mette
   * sotto gli occhi la prima volta che un cron passa.
   */
  const segreto = grezzo.trim()
  if (segreto !== grezzo) {
    console.warn(
      '[cron] CRON_SECRET ha spazi o un a-capo in coda: confronto col valore ripulito. '
      + 'Riscrivila su Vercel con `printf \'%s\' ...`, mai con `echo`.',
    )
  }

  // A tempo costante, come OGNI altro confronto di segreti di questa app
  // (`confronto-costante.ts`: check-in, doc-access, webhook Telegram). Il
  // rischio pratico qui e' debole — segreto ad alta entropia, rumore di rete e
  // cold start di una lambda in mezzo — ma questa era l'unica difesa da
  // segreto-in-header del repo che non lo usava, e una difesa che diverge
  // dalle altre e' una difesa che qualcuno dovra' ri-giudicare da capo.
  // Il controllo di esistenza qui sopra resta indispensabile: `confrontoCostante`
  // rifiuta i valori vuoti, ma un segreto fatto di soli spazi e' truthy.
  return confrontoCostante(request.headers.get('authorization'), `Bearer ${segreto}`)
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
