/**
 * api/cron/canary — Vercel cron handler.
 *
 * Schedule: ogni 30 minuti (vedi vercel.json).
 * Quando lo stato breaker è ROLLED_BACK, esegue una request canary contro
 * model_default. Se 3 canary consecutivi vanno OK → resetBreaker.
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import {
  getCircuitState,
  resetBreaker,
  recordOutcome,
  invalidateCache,
  type CircuitState,
} from '@/lib/circuit-breaker'

const CANARY_OK_TARGET = 3
const CANARY_TIMEOUT_MS = 30_000

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const state = await getCircuitState()
  if (state.state !== 'ROLLED_BACK') {
    console.log(`[CRON canary] skipped: state=${state.state}`)
    return NextResponse.json({ ok: true, skipped: true, state: state.state })
  }

  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  console.log(`[CRON canary] testing ${defaultModel}`)

  const client = new Anthropic()
  let outcome: 'success' | 'empty' | 'api_error' | 'timeout' = 'success'
  let canaryText = ''

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS)

    const res = await client.messages.create(
      {
        model: defaultModel,
        max_tokens: 10,
        system: 'Rispondi SOLO con la parola OK e nient\'altro.',
        messages: [{ role: 'user', content: 'Ping' }],
      },
      { signal: controller.signal },
    )
    clearTimeout(timeout)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    canaryText = res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim()

    if (!canaryText || canaryText.length === 0) {
      outcome = 'empty'
    }
  } catch (err) {
    console.error('[CRON canary] API error:', err)
    if (err instanceof Error && err.name === 'AbortError') {
      outcome = 'timeout'
    } else {
      outcome = 'api_error'
    }
  }

  await recordOutcome(defaultModel, outcome, {
    isCanary: true,
    details: `canary text="${canaryText.slice(0, 50)}"`,
  })

  let newOk = state.canary_consecutive_ok
  if (outcome === 'success') {
    newOk = state.canary_consecutive_ok + 1
  } else {
    newOk = 0
  }

  if (newOk >= CANARY_OK_TARGET) {
    console.log(`[CRON canary] ${newOk} OK consecutive → resetBreaker`)
    await resetBreaker()
    return NextResponse.json({ ok: true, action: 'recovery', model: defaultModel })
  }

  const newState: CircuitState = { ...state, canary_consecutive_ok: newOk }
  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')
  invalidateCache()

  console.log(`[CRON canary] outcome=${outcome} consecutive_ok=${newOk}/${CANARY_OK_TARGET}`)
  return NextResponse.json({ ok: true, outcome, consecutive_ok: newOk })
}

export const maxDuration = 60
