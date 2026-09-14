// src/app/api/cron/porta-comune.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * ⚠️ C43 — LA PORTA DI TUTTI I CRON, PROVATA ROTTA PER ROTTA.
 *
 * Undici rotte confrontavano `auth !== \`Bearer ${process.env.CRON_SECRET}\``
 * senza verificare che il segreto esistesse: con `CRON_SECRET` non
 * configurata, la stringa `"Bearer undefined"` le avrebbe aperte tutte. Non e'
 * sfruttabile oggi — i cron girano, quindi il segreto c'e' — ma e' **un deploy
 * sbagliato di distanza**, ed e' un guasto di configurazione che invece di
 * chiudere APRE.
 *
 * Questo file prova DUE cose per CIASCUNA rotta:
 *  - segreto assente + `Bearer undefined` ⇒ **401**;
 *  - CONTROLLO POSITIVO: segreto presente e corretto ⇒ **non 401**, cioe' la
 *    porta si apre ancora e i cron non sono stati spenti dalla correzione.
 */

// Tutto quello che le rotte toccano appena passata la porta, spento: qui si
// misura CHI ENTRA, non che cosa fa una volta dentro. Senza questi finti, il
// controllo positivo andrebbe a cercare Supabase e la rete vere.
vi.mock('@/lib/supabase', () => {
  const vuoto = { data: null, error: null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = new Proxy(() => b, {
    get: (_o, chiave) => {
      if (chiave === 'then') return (risolvi: (v: unknown) => unknown) => risolvi(vuoto)
      return b
    },
    apply: () => b,
  })
  return { supabase: b, getSupabase: () => b }
})
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: async () => undefined,
  sendTelegramMessageChecked: async () => true,
  chatAdmin: () => 0,
}))

/** Le rotte cron, LETTE DAL DISCO: una nuova entra in questo test da sola. */
const CARTELLA = path.join(process.cwd(), 'src', 'app', 'api', 'cron')
const ROTTE = fs.readdirSync(CARTELLA, { withFileTypes: true })
  .filter(v => v.isDirectory() && fs.existsSync(path.join(CARTELLA, v.name, 'route.ts')))
  .map(v => v.name)
  .sort()

function req(authorization?: string) {
  const intestazioni = new Map<string, string>()
  if (authorization !== undefined) intestazioni.set('authorization', authorization)
  const url = 'https://cervellone-five.vercel.app/api/cron/x'
  return {
    url,
    nextUrl: new URL(url),
    headers: { get: (nome: string) => intestazioni.get(nome.toLowerCase()) ?? null },
    cookies: { get: () => undefined },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const SEGRETO = 'segreto-di-prova-del-cron'

/**
 * Questi sono i test piu' CARI della suite: ciascuno importa un modulo-rotta
 * intero, che si porta dietro mezzo mondo (Supabase, googleapis, i prompt).
 *
 * OSSERVATO il 14 set 2026 su Windows: al primo lancio, col timeout di
 * vitest ancora a 5s, due rotte (`checkin-documenti` e `self-audit`) sono
 * fallite per TIMEOUT mentre tutto il resto passava. ⚠️ La causa del primo
 * lancio lento NON e' accertata: svuotare `node_modules/.vite` non la
 * riproduce, quindi non e' la cache di trasformazione.
 *
 * L'attesa generale e' poi stata portata a 15s in `vitest.config.ts` per un
 * motivo piu' largo (la contesa fra worker: v. il commento la'). Questo
 * numero resta lo stesso, ed e' piu' alto, perche' vale per i due import
 * peggiori che ci siano: se un giorno la suite tornera' stretta, questo file
 * non dev'essere il primo a cadere per fame di CPU invece che per la porta
 * dei cron.
 *
 * Un test verde solo dal secondo lancio in poi viene ignorato al primo rosso,
 * ed e' cosi' che un test smette di sorvegliare senza che nessuno lo cancelli.
 */
const ATTESA_IMPORT_FREDDO = 30_000
let segretoDiPrima: string | undefined
let spie: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  segretoDiPrima = process.env.CRON_SECRET
  spie = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ]
})
afterEach(() => {
  if (segretoDiPrima === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = segretoDiPrima
  for (const s of spie) s.mockRestore()
})

describe('C43 — nessun cron si apre quando CRON_SECRET manca', () => {
  it('le rotte che questo test sorveglia sono TUTTE quelle che esistono', () => {
    // Un elenco cablato invecchia in silenzio: la rotta scritta domani non
    // entrerebbe mai in questo test, e il buco tornerebbe da un'altra parte.
    // L'elenco lo legge dal disco; qui si controlla solo che non sia vuoto,
    // perche' un `forEach` su zero elementi e' verde e non prova niente.
    //
    // Su `main` le rotte cron sono UNDICI. La dodicesima (`turni-aperti`)
    // arriva col modulo commesse: quando quel ramo entrera', si aggiungera' da
    // sola a questo test, perche' l'elenco e' letto dal disco e non scritto a
    // mano. Il numero qui sotto e' un pavimento contro l'elenco che si
    // dimezza in silenzio, non un censimento.
    expect(ROTTE.length).toBeGreaterThanOrEqual(11)
    expect(ROTTE).toContain('scadenze')
  })

  it('🚨 ogni cron PIANIFICATO su Vercel e fra quelli sorvegliati qui', () => {
    // Il pavimento qui sopra non basta da solo: legge una CARTELLA, quindi
    // non vedrebbe un cron scritto come `route.tsx`, annidato, o messo
    // altrove — sparirebbe da questo test in silenzio, e il numero resterebbe
    // undici. E non vedrebbe nemmeno una SOSTITUZIONE: una tolta e una messa
    // lasciano il conto identico.
    //
    // La verita' su quali porte il mondo puo' bussare non sta nel filesystem,
    // sta in `vercel.json`: quello e' l'elenco di cosa Vercel chiamera' davvero.
    // Stesso patto gia' stretto in `src/lib/tools/automazioni.test.ts`.
    const pianificati = (JSON.parse(fs.readFileSync('vercel.json', 'utf8')) as {
      crons?: Array<{ path: string }>
    }).crons ?? []

    // Se un giorno `vercel.json` non avesse piu' cron, questo test diventerebbe
    // verde e vuoto: e' esattamente il modo in cui smetterebbe di sorvegliare.
    expect(pianificati.length).toBeGreaterThanOrEqual(11)

    const scoperti = pianificati
      .map(c => c.path)
      .filter(p => {
        const m = /^\/api\/cron\/(.+)$/.exec(p)
        return !m || !ROTTE.includes(m[1])
      })

    expect(
      scoperti,
      `cron pianificati su Vercel ma NON sorvegliati da questo test: ${scoperti.join(', ')}`,
    ).toEqual([])
  })

  for (const rotta of ROTTE) {
    it(`🚨 ${rotta}: senza il segreto, «Bearer undefined» NON apre`, async () => {
      delete process.env.CRON_SECRET
      const modulo = await import(`./${rotta}/route.ts`)
      const verbo = modulo.GET ?? modulo.POST

      const r = await verbo(req('Bearer undefined'))

      expect(r.status).toBe(401)
    }, ATTESA_IMPORT_FREDDO)

    it(`CONTROLLO POSITIVO — ${rotta}: col segreto giusto la porta si apre ancora`, async () => {
      // Senza questo, il test qui sopra resterebbe verde anche con dodici cron
      // spenti: risponderebbero 401 sempre, e nessuno se ne accorgerebbe fino
      // alla mattina in cui otto operai non riescono a timbrare.
      process.env.CRON_SECRET = SEGRETO
      const modulo = await import(`./${rotta}/route.ts`)
      const verbo = modulo.GET ?? modulo.POST

      // Quello che la rotta fa una volta dentro qui non interessa e puo' anche
      // sollevare (le dipendenze sono finte): l'unica cosa misurata e' che non
      // sia stata respinta alla porta.
      let stato: number | 'ha sollevato' = 'ha sollevato'
      try {
        stato = (await verbo(req(`Bearer ${SEGRETO}`))).status
      } catch { /* passata la porta, e' andata a sbattere piu' avanti: basta */ }

      expect(stato).not.toBe(401)
    }, ATTESA_IMPORT_FREDDO)
  }
})
