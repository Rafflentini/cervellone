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
  if (grezzo !== valore || !(acceso || valore === '0' || valore === '')) {
    console.warn(
      `[interruttori] ${nome}=${JSON.stringify(grezzo)} non e' un valore pulito: ` +
        `lo leggo come ${acceso ? 'ACCESO' : 'SPENTO'}. Valori ammessi: "1" o "0".`,
    )
  }
  return acceso
}
