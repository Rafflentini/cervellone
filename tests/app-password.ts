// Password dell'interfaccia web, per i test end-to-end.
//
// NON scriverla qui. Questo repository è PUBBLICO (github.com/Rafflentini/cervellone,
// visibility: public): fino al 17/08/2026 il valore reale era hardcoded in quattro
// file di test, quindi leggibile da chiunque. È la password che protegge /chat e
// /doc, cioè l'accesso a Drive, mail e contabilità di Restruktura.
//
// Uso:  APP_PASSWORD='...' npx playwright test
//
// NB: toglierla dal codice NON la mette al sicuro — resta nella storia di git.
// L'unico rimedio reale è ruotarla su Vercel (e valutare se il repo debba
// davvero essere pubblico).
export const APP_PASSWORD = (() => {
  const value = process.env.APP_PASSWORD
  if (!value) {
    throw new Error(
      'APP_PASSWORD non impostata. Esportala prima di lanciare i test end-to-end: ' +
        "APP_PASSWORD='...' npx playwright test",
    )
  }
  return value
})()
