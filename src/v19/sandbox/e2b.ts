/**
 * Cervellone V19 — E2B sandbox wrapper (feature-flagged)
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 11
 *
 * IMPORTANTE: il pacchetto `@e2b/code-interpreter` è caricato dinamicamente
 * SOLO se la feature è attiva, per evitare che l'import lazy faccia fallire
 * il build se la dep non è installata. Questo permette di mergiare la
 * foundation V19 senza necessariamente avere E2B installato.
 */

import {
  SandboxConnectionError,
  SandboxDisabledError,
  SandboxKeyMissingError,
} from './errors'
import { loadSandboxId, markSandboxKilled, saveSandboxId } from './persist'

export type RunCodeOptions = {
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  timeoutMs?: number
}

export type RunCodeResult = {
  stdout: string
  stderr: string
  files: Array<{ name: string; path: string; size: number }>
  sandboxId: string
}

export type SandboxLike = {
  sandboxId: string
  runCode(code: string, opts?: any): Promise<any>
  files: { list(path: string): Promise<any[]>; read(path: string, opts?: any): Promise<any> }
}

let cachedModule: any = null

async function loadE2bModule(): Promise<any> {
  if (cachedModule) return cachedModule
  // Dynamic import via stringa per evitare type-check del modulo (potrebbe non
  // essere installato in dev environment). Runtime: dipende dalla dep.
  try {
    // @ts-ignore - intentional dynamic import of optional dep
    cachedModule = await import(/* webpackIgnore: true */ '@e2b/code-interpreter' as any)
  } catch (err) {
    throw new SandboxConnectionError(
      'Pacchetto @e2b/code-interpreter non installato. Esegui: npm install @e2b/code-interpreter',
      err,
    )
  }
  return cachedModule
}

function checkFeatureFlags(): void {
  if (process.env.E2B_FEATURE !== 'on') {
    throw new SandboxDisabledError()
  }
  if (!process.env.E2B_API_KEY) {
    throw new SandboxKeyMissingError()
  }
}

export async function getOrCreateSandbox(conversationId: string): Promise<SandboxLike> {
  checkFeatureFlags()
  const e2b = await loadE2bModule()
  const Sandbox = e2b.Sandbox

  const savedId = await loadSandboxId(conversationId)
  if (savedId) {
    try {
      const sbx = await Sandbox.connect(savedId, { apiKey: process.env.E2B_API_KEY! })
      return sbx
    } catch (err) {
      console.warn(`[v19/sandbox] Connect to ${savedId} failed, creating new:`, err)
      await markSandboxKilled(conversationId)
    }
  }

  const sbx = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY!,
    timeoutMs: 600_000, // 10 min default
  })
  await saveSandboxId(conversationId, sbx.sandboxId)
  return sbx
}

export async function runCodeInSandbox(
  conversationId: string,
  code: string,
  opts: RunCodeOptions = {},
): Promise<RunCodeResult> {
  const sbx = await getOrCreateSandbox(conversationId)
  const exec = await sbx.runCode(code, {
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
    timeoutMs: opts.timeoutMs,
  })
  const stdout = (exec?.logs?.stdout ?? []).join('')
  const stderr = (exec?.logs?.stderr ?? []).join('')
  let files: RunCodeResult['files'] = []
  try {
    const list = await sbx.files.list('/home/user')
    files = (list ?? []).map((f: any) => ({
      name: f.name,
      path: f.path,
      size: f.size ?? 0,
    }))
  } catch (err) {
    console.warn('[v19/sandbox] file list failed:', err)
  }
  return { stdout, stderr, files, sandboxId: sbx.sandboxId }
}

/** Per test: reset cache module. */
export function _resetE2bCacheForTest(): void {
  cachedModule = null
}
