/**
 * Gli interruttori d'ambiente (`TOOL_DEFER`, `DECOLLO`): accesi solo con '1'.
 *
 * 🚨 Nato il 13 set 2026. Su Vercel `TOOL_DEFER` valeva "1\n" — un a capo
 * incollato con il valore — e il codice confrontava `=== '1'`: la Strada C
 * sembrava accesa ed era spenta. Per questo gli spazi ai bordi non contano, e
 * un valore sporco o non riconosciuto **lo dice nei log**: un interruttore
 * non deve spegnersi in silenzio.
 *
 * Non importa niente: `delega-tools` lo usa e non deve raggiungere `tools.ts`.
 */
export function interruttoreAcceso(nome: string): boolean {
  const grezzo = process.env[nome]
  if (grezzo === undefined) return false
  const valore = grezzo.trim()
  const acceso = valore === '1'
  // Il valore si mostra solo se e' corto: chi un giorno usasse questa funzione
  // su una variabile che contiene un segreto non deve ritrovarselo nei log.
  const mostrato = grezzo.length <= 8 ? JSON.stringify(grezzo) : `(${grezzo.length} caratteri)`
  if (grezzo !== valore || !(acceso || valore === '0' || valore === '')) {
    console.warn(
      `[interruttori] ${nome}=${mostrato} non e' un valore pulito: ` +
        `lo leggo come ${acceso ? 'ACCESO' : 'SPENTO'}. Valori ammessi: "1" o "0".`,
    )
  }
  return acceso
}
