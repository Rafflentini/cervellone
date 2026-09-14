import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    /**
     * I 5 secondi che vitest concede per difetto non sono un budget di
     * COMPORTAMENTO, sono un budget di CPU — e qui i worker se la contendono.
     *
     * MISURATO il 14 set 2026, suite intera su questa macchina:
     *  - su `main`, prima di qualunque modifica: 1 rosso
     *    (`conferma-invio.test.ts`);
     *  - aggiungendo i 29 test della porta dei cron, che importano undici
     *    moduli-rotta interi: 3 rossi;
     *  - TUTTI E TRE, incluso quello preesistente, passano quando il loro file
     *    viene lanciato DA SOLO.
     * Cioe': non falliscono per quello che provano, falliscono perche' un
     * vicino di worker gli ha portato via il processore. Aggiungere test veri
     * faceva cadere test veri altrove — un contatore di rossi che non parla
     * piu' del codice.
     *
     * Perche' 15s e non "spegniamo il timeout": un test che si e' PIANTATO
     * davvero deve ancora morire, e muore, solo dieci secondi piu' tardi. Nel
     * caso verde questo numero non costa niente, perche' il timeout scatta
     * solo quando qualcosa non finisce.
     */
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
