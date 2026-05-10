# 🔄 RIPRESA V19 — leggi questo per primo

> Guida lampo alla ripresa dopo sessione autonoma notturna 9-10 maggio 2026.
> Per dettagli completi: `ONBOARDING.md`

## In 30 secondi

```powershell
# 1. Vai sul branch V19
git checkout v19/foundation

# 2. Verifica test (39/39 atteso)
npx vitest run src/v19/__tests__/

# 3. Apri PR draft (1 click in browser)
# https://github.com/Rafflentini/cervellone/pull/new/v19/foundation

# 4. Apri Claude Code in questa cartella e digli "riprendi V19"
```

## Stato

- **Branch**: `v19/foundation` (locale + origin) — commit `a4acc61`
- **Test**: 39/39 PASS
- **TypeScript**: 0 errori in V19
- **Working tree**: pulito sui file V19
- **V18 prod**: intoccato (`main` su `f973b2d`, ancora live su Vercel)

## Cosa esiste già

| Cosa | Dove |
|---|---|
| Spec V19 (~9000 parole) | `docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md` |
| Plan V19 eseguibile | `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation.md` |
| Codice V19 (~3800 LOC) | `src/v19/` |
| Test 39 unit | `src/v19/__tests__/` |
| Migration Supabase | `supabase/migrations/2026-05-09-v19-*.sql` |
| Handoff dettagliato | `ONBOARDING.md` |

## Cosa serve da te (in ordine, dettagli in ONBOARDING.md)

1. ☐ Click PR draft (1 min)
2. ☐ `E2B_API_KEY` per attivare sandbox
3. ☐ ID cartelle Drive semantiche (RELAZIONI CIG, DDT, PREVENTIVI, CME, CHECKLIST, SICUREZZA)
4. ☐ Beneficiari CIGO Aprile 2026 reali (sostituire fixture)
5. ☐ Data esatta evento meteo Aprile 2026 (per scaricare bollettino CFD vero)
6. ☐ Decisione cutover Telegram immediato vs parallelo
7. ☐ Path Hybrid (E) come safety net si/no

## Comandi utili

```powershell
# Vedi commit V19 (6 totali)
git log --oneline main..v19/foundation

# Diff vs main
git diff main..v19/foundation --stat

# Re-run test
npx vitest run src/v19/__tests__/

# Type check globale (4 errori PRE-ESISTENTI in pdf-generator.test.ts non sono miei)
npx tsc --noEmit
```

## Memoria Claude Code

Quando riapri Claude Code, troverai memoria già aggiornata con:
- `cervellone-v19-stato.md` — stato post-foundation
- `cervellone-bollettino-meteo-basilicata.md` — vincolo CFD
- `MEMORY.md` aggiornata

Basta dire: **"riprendi V19"** o **"apri PR e iniziamo cutover"**.
