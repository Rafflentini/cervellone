/**
 * Cervellone V19 — Memory tool handler (memory_20250818 Anthropic)
 *
 * Implementa i comandi view/create/str_replace/insert/delete/rename del tool
 * nativo Anthropic. Il backend è Supabase Storage bucket "memories".
 *
 * SECURITY: tutte le path validate per essere dentro /memories/{userId}/.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 7
 */

import type Anthropic from '@anthropic-ai/sdk'
import {
  viewFile,
  viewDir,
  createFile,
  strReplace,
  insertLine,
  deleteFile,
  renameFile,
} from './storage'

export const MEMORY_TOOL: Anthropic.Tool = {
  type: 'memory_20250818',
  name: 'memory',
} as unknown as Anthropic.Tool

export type MemoryToolInput =
  | { command: 'view'; path: string }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; line: number; text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; path: string; new_path: string }

export type MemoryHandlerOptions = {
  /** Per test: bypassa Supabase. */
  storage?: {
    viewFile?: typeof viewFile
    viewDir?: typeof viewDir
    createFile?: typeof createFile
    strReplace?: typeof strReplace
    insertLine?: typeof insertLine
    deleteFile?: typeof deleteFile
    renameFile?: typeof renameFile
  }
}

const MEMORY_PREFIX = '/memories/'

/** Valida path e lo converte in path relativo al bucket Supabase. */
function userScopedRelPath(path: string, userId: string): string {
  if (!path.startsWith(MEMORY_PREFIX)) {
    throw new Error(`Path memoria deve iniziare con ${MEMORY_PREFIX} (ricevuto: ${path})`)
  }
  const expectedPrefix = `${MEMORY_PREFIX}${userId}/`
  if (!path.startsWith(expectedPrefix) && path !== `${MEMORY_PREFIX}${userId}`) {
    throw new Error(
      `Path traversal rilevato: ${path} non appartiene a /memories/${userId}/`,
    )
  }
  // Rimuovi prefisso /memories/
  return path.slice(MEMORY_PREFIX.length)
}

/**
 * Esegui una chiamata al tool memory_20250818 e ritorna il risultato come string.
 */
export async function handleMemoryToolCall(
  input: MemoryToolInput,
  userId: string,
  opts: MemoryHandlerOptions = {},
): Promise<string> {
  const s = {
    viewFile: opts.storage?.viewFile ?? viewFile,
    viewDir: opts.storage?.viewDir ?? viewDir,
    createFile: opts.storage?.createFile ?? createFile,
    strReplace: opts.storage?.strReplace ?? strReplace,
    insertLine: opts.storage?.insertLine ?? insertLine,
    deleteFile: opts.storage?.deleteFile ?? deleteFile,
    renameFile: opts.storage?.renameFile ?? renameFile,
  }

  switch (input.command) {
    case 'view': {
      const rel = userScopedRelPath(input.path, userId)
      // Se path termina con / o nessuna estensione, prova come dir
      if (input.path.endsWith('/') || !rel.includes('.')) {
        const items = await s.viewDir(rel)
        return items.length === 0
          ? `(empty: ${input.path})`
          : items.map((p) => `/memories/${p}`).join('\n')
      }
      const content = await s.viewFile(rel)
      if (content === null) return `(file non trovato: ${input.path})`
      return content
    }

    case 'create': {
      const rel = userScopedRelPath(input.path, userId)
      await s.createFile(rel, input.file_text)
      return `OK: file creato/aggiornato ${input.path} (${input.file_text.length} char)`
    }

    case 'str_replace': {
      const rel = userScopedRelPath(input.path, userId)
      await s.strReplace(rel, input.old_str, input.new_str)
      return `OK: str_replace su ${input.path}`
    }

    case 'insert': {
      const rel = userScopedRelPath(input.path, userId)
      await s.insertLine(rel, input.line, input.text)
      return `OK: insert su ${input.path} riga ${input.line}`
    }

    case 'delete': {
      const rel = userScopedRelPath(input.path, userId)
      await s.deleteFile(rel)
      return `OK: file eliminato ${input.path}`
    }

    case 'rename': {
      const oldRel = userScopedRelPath(input.path, userId)
      const newRel = userScopedRelPath(input.new_path, userId)
      await s.renameFile(oldRel, newRel)
      return `OK: rinominato ${input.path} -> ${input.new_path}`
    }

    default: {
      const exhaustive: never = input
      throw new Error(`Memory command sconosciuto: ${JSON.stringify(exhaustive)}`)
    }
  }
}
