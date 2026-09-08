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
export function avvisoImmagini(idMancanti: string[]): string {
  if (idMancanti.length === 0) return ''
  const quante = idMancanti.length === 1 ? '1 immagine' : `${idMancanti.length} immagini`
  return (
    `\n\n⚠️ **Attenzione: ${quante} non sono entrate nel documento** e li' dentro risultano rotte.` +
    `\nId Drive: ${idMancanti.join(', ')}` +
    `\nControlli che i file esistano e siano accessibili prima di consegnarlo.`
  )
}
