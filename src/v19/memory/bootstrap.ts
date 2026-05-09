/**
 * Cervellone V19 — Bootstrap memory per utente
 *
 * Crea i file iniziali in /memories/{userId}/ con identità + tono + ufficio +
 * preferenze. Idempotente: non sovrascrive se i file esistono già.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 7.3
 */

import { createFile, viewFile } from './storage'
import { RESTRUKTURA, UTENTE_PRINCIPALE } from '../prompts/identita'

export type BootstrapResult = {
  created: string[]
  skipped: string[]
}

const SEED_FILES_RAFFAELE = (): Record<string, string> => ({
  'raffaele/identita.md': `# Identità — ${UTENTE_PRINCIPALE.nome}

- Ruolo: ${UTENTE_PRINCIPALE.qualifica}
- Email: ${UTENTE_PRINCIPALE.email}
- Azienda: ${RESTRUKTURA.ragioneSociale} (P.IVA ${RESTRUKTURA.partitaIva})
- Sede: ${RESTRUKTURA.sedeLegale}
`,

  'raffaele/tono.md': `# Tono di comunicazione

- Lei formale (mai "tu").
- Pragmatico, conciso. Niente cortesia ridondante ("Spero le sia utile", "Buona giornata", ecc.).
- Nei messaggi tecnici: dati prima, narrazione dopo.
- Su Telegram: max 3-4 paragrafi salvo richiesta esplicita di approfondimento.
`,

  'raffaele/ufficio.md': `# Ufficio Restruktura

- Sede: ${RESTRUKTURA.sedeLegale}
- Fuso orario: Europe/Rome
- Clima: appenninico lucano (inverni freddi con neve, estati miti, piovosità autunnale e primaverile elevata)
- Orari business: 9:00-13:00 e 14:30-18:30, lun-ven
- Cantieri: prevalentemente Basilicata (Vulture-Melfese, Pollino, Val d'Agri)
`,

  'raffaele/preferenze/git-policy.md': `# Git policy Restruktura

## Branch
- Feature: \`feat/<descrizione-breve>\`
- Fix: \`fix/<descrizione-breve>\`
- V19: \`v19/foundation\`, \`v19/<modulo>\`

## Commit
- Mai \`--amend\` su commit pushati. Mai \`--no-verify\`.
- Conventional commits: \`feat(scope):\`, \`fix(scope):\`, \`chore(scope):\`, \`docs(scope):\`, \`test(scope):\`.
- Co-Authored-By Claude se l'autore principale è Cervellone.

## Push / Merge
- Mai push diretto su \`main\`. Sempre via PR.
- Force push solo dopo conferma esplicita Ingegnere.
- PR draft → review utente → merge.
- Skip hooks (\`--no-verify\`) MAI senza conferma esplicita.

## Self-healing autonomo
- Bug nel proprio codice: prima \`github_read_file\` per vedere il codice attuale, poi \`github_propose_fix\` per aprire PR.
- Mai \`--force\`, mai \`--amend\`, mai bypass hooks.
- Merge \`github_merge_pr\` solo se l'Ingegnere è impossibilitato (mobile, fuori) e il fix è non-invasivo.
`,

  'raffaele/preferenze/doc-output.md': `# Output documenti — preferenze

## Default
- Memoria interna conversazione (non scrivere su Drive automaticamente).

## Trigger Drive upload
Solo se l'Ingegnere dice esplicitamente:
- "salva su Drive"
- "archivia"
- "manda a [persona]"
- "carica su Drive"

## Cartelle Drive (mappa semantica V19)
- DDT: cartella DDT
- Preventivi: cartella PREVENTIVI
- CME: cartella CME
- Allegato 10 CIGO: cartella RELAZIONI CIG
- Checklist: cartella CHECKLIST
- POS/PSC: cartella SICUREZZA

Mai cartella generica "Studio Tecnico" per documenti specifici.

## Engine
- Sempre \`genera_docx_v19\` / \`genera_xlsx_v19\` / \`genera_pdf_v19\` (input JSON semantico).
- Mai \`genera_docx\` V18 (deprecato: appiattiva tabelle).
- Mai \`jsPDF\`.
`,

  'raffaele/preferenze/gmail-policy.md': `# Gmail policy

## Read
- Mattina (cron 8:00 lun-ven): digest mail nuove ultime 24h, classificate per urgenza/tipo.
- On-demand: \`gmail_search\`, \`gmail_read_message\`, \`gmail_read_thread\`.

## Write (drafts)
- Sempre creare draft tramite \`gmail_create_draft\`.
- Mostrare preview con \`gmail_show_draft\` prima di chiedere conferma.

## Send
- SOLO dopo \`/conferma\` esplicito utente OPPURE \`manda\`/\`invia\`.
- MAI invio automatico senza human-in-loop, eccezione: routine pre-autorizzate (es. fatture estere → commercialista cron mensile, fase 2).
- Anti-loop: se thread ha reply bot <30min, rifiuta send automatico.

## Hard-block
- Delete permanente: MAI.
- Forward a terzi (non-Restruktura): MAI.
- Modifica filtri/firma: MAI.
- Bulk send: MAI.
`,

  'raffaele/preferenze/cigo-policy.md': `# CIGO policy

## Bollettino meteo (vincolante)
Per causale "Eventi Meteorologici" il bollettino DEVE essere scaricato dal:
- **Centro Funzionale Decentrato (CFD) Regione Basilicata**
- URL: https://centrofunzionale.regione.basilicata.it/
- Pattern PDF: https://centrofunzionale.regione.basilicata.it/ew/ew_pdf/a/Bollettino_Criticita_Regione_Basilicata_DD_MM_YYYY.pdf

NON usare datimeteo.it, ARPA generica, Aeronautica Militare nazionale come sostitutive.

## Documenti del pacchetto CIGO
1. Allegato 10 — Relazione tecnica art. 2 D.M. 95442/2016 (DOCX → PDF firmato)
2. Elenco beneficiari (CSV tracciato Msg INPS 3566/2018)
3. (Solo pagamento diretto) SR41 PDF compilabile

## Salvataggio
Cartella Drive: RELAZIONI CIG (NON Studio Tecnico).

## Termine
Domanda CIGO entro fine mese successivo all'evento (perentorio).

## Note
- INPS acquisisce d'ufficio i bollettini (Msg 1856/2017), ma allegarli rinforza la relazione.
- Microimpresa <15 dipendenti: niente procedura sindacale preventiva per eventi meteo (ma comunicazione informativa RSU prudenziale).
- Edilizia eventi meteo: requisito anzianità abolito.
`,
})

export async function bootstrapUserMemory(
  userId: string,
  storage?: { createFile?: typeof createFile; viewFile?: typeof viewFile },
): Promise<BootstrapResult> {
  const cf = storage?.createFile ?? createFile
  const vf = storage?.viewFile ?? viewFile

  if (userId !== 'raffaele') {
    // Per ora solo Raffaele è seedato. Estendere quando arriva 2° utente.
    return { created: [], skipped: [] }
  }

  const seeds = SEED_FILES_RAFFAELE()
  const created: string[] = []
  const skipped: string[] = []

  for (const [relPath, content] of Object.entries(seeds)) {
    try {
      const existing = await vf(relPath)
      if (existing && existing.length > 0) {
        skipped.push(`/memories/${relPath}`)
        continue
      }
      await cf(relPath, content)
      created.push(`/memories/${relPath}`)
    } catch (err) {
      console.warn(`[v19/memory/bootstrap] failed ${relPath}:`, err)
    }
  }

  return { created, skipped }
}
