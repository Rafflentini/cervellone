export async function helloStep(name: string): Promise<string> {
  'use step'
  return `ciao ${name} dal workflow durable`
}
