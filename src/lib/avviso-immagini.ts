/**
 * La riga da appendere alla consegna di un documento quando qualche immagine
 * non e' entrata.
 *
 * Nasce dall'8 settembre 2026: il Preventivo Extra B della commessa C2026-008 e'
 * uscito a 178KB con la foto della facciata rotta, e il bot l'ha dichiarato a
 * posto tre volte di fila — perche' il fallimento dell'incorporamento veniva
 * ingoiato da un `catch` con un solo `console.error`.
 *
 * Un documento tecnico a cui mancano le foto del degrado non e' un documento
 * con meno grafica: e' un documento che non prova quello che afferma.
 */
export function avvisoImmagini(mancanti: string[]): string {
  if (mancanti.length === 0) return ''
  const quante = mancanti.length === 1 ? '1 immagine' : `${mancanti.length} immagini`
  // Una riga per voce, e NESSUNA etichetta "Id Drive": da quando si riesce si
  // dice il nome del file, e chiamarlo id era una bugia oltre che un formato
  // misto illeggibile ("Id Drive: facciata.heic (1a2b3c), 9z8y7x").
  const elenco = mancanti.map((m) => `\n• ${m}`).join('')
  return (
    `\n\n⚠️ **Attenzione: ${quante} non sono entrate nel documento** e li' dentro risultano rotte:` +
    elenco +
    `\nControlli che i file esistano, siano accessibili e in un formato che il documento sa contenere (JPEG, PNG, GIF, BMP), prima di consegnarlo.`
  )
}
