import fs from "fs";
const p = "src/lib/agent-job.salvataggio.test.ts";
let s = fs.readFileSync(p, "utf8");
const v = `  it('la riga porta l istante del TURNO, non quello della scrittura', async () => {
    mockCallClaude.mockResolvedValue('Fatto.')
    await runAgentJob(input())
    expect(righe[0].istante).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })`;
if (!s.includes(v)) throw new Error("ancora");
const n = `  // Se il turno e' lungo e la scrittura arriva molto dopo, la riga NON deve
  // portare l'istante della scrittura: si infilerebbe dopo la domanda che
  // l'Ingegnere ha intanto mandato. Un mock istantaneo non lo distingue: qui
  // il loop ci mette apposta un po'.
  it('la riga porta l istante del TURNO, non quello della scrittura', async () => {
    mockCallClaude.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 120))
      return 'Fatto dopo un po.'
    })

    await runAgentJob(input())
    const fine = Date.now()

    expect(righe[0].istante).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // L'istante e' PRIMA che il loop finisse, non dopo.
    expect(fine - Date.parse(righe[0].istante!)).toBeGreaterThanOrEqual(100)
  })`;
fs.writeFileSync(p, s.replace(v, n));
console.log("ok");
