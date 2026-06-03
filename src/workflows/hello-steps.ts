export async function helloStep(ms: number): Promise<string> {
  'use step'
  const start = Date.now()
  await new Promise((r) => setTimeout(r, ms))
  return `step ok: atteso ${ms}ms (reale ${Date.now() - start}ms)`
}
