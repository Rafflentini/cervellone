import { helloStep } from './hello-steps'

export async function helloWorkflow(ms: number): Promise<string> {
  'use workflow'
  return await helloStep(ms)
}
