import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    /**
     * ⚠️ QUI NON C'E' UN `testTimeout` GLOBALE, ED E' UNA DECISIONE.
     *
     * Il 14 set 2026 ce n'e' stato uno, a 15s, per qualche ora. Il motivo
     * sembrava buono: la suite era passata da 1 rosso a 3 aggiungendo i test
     * della porta dei cron, i tre rossi erano tutti `timed out in 5000ms` in
     * file che non c'entravano, e tutti e tre passavano in isolamento. La
     * diagnosi scritta era «fame di CPU fra worker».
     *
     * Poi la diagnosi e' stata RIMISURATA, ed era troppo grossa per le prove
     * che aveva sotto: quattro giri indipendenti della suite intera a 5000ms
     * — tre qui, uno da un audit — sono usciti TUTTI VERDI. Il fenomeno e'
     * reale (osservato tre volte) ma non si riproduce a comando, e non
     * giustifica un cambiamento che tocca 2.888 test per curarne tre.
     *
     * La causa vera, per due dei tre, e' stata poi misurata: importare
     * `@/v19/tools/email/telegram-confirm` costa **1703 ms**, e quei due test
     * se lo portano dentro il proprio budget con un `await import()` nel
     * corpo. Curati li', con un timeout PER TEST — che e' l'idioma di questo
     * repo (41 punti).
     *
     * Se un giorno servisse di nuovo un numero globale, serve prima un rosso
     * che si riproduca: un timeout largo per tutti fa morire dieci secondi
     * piu' tardi anche il test che si e' piantato davvero.
     */
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
