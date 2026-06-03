import { helloStep } from './hello-steps'

export async function helloWorkflow(name: string): Promise<string> {
  'use workflow'
  const msg = await helloStep(name)
  return msg
}
