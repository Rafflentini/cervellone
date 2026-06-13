// src/lib/stream-retry.ts — Consumo resiliente di uno stream Anthropic con retry su errori transitori.
// Avvolge crea-stream + iterazione eventi + finalMessage: su errore transitorio (overloaded/529/rete/
// timeout) ri-tenta l'intera iterazione. Il chiamante azzera il proprio parziale in onAttemptStart
// (es. fullResponse.slice(0, iterStart)). NON ritenta gli errori "veri" (400/401/404/422 ecc.).

export interface StreamLike<TEvent, TFinal> extends AsyncIterable<TEvent> {
  finalMessage(): Promise<TFinal>
}

export interface ConsumeStreamRetryOpts<TEvent, TFinal> {
  /** Crea uno stream FRESCO ad ogni tentativo (NON riusare lo stesso oggetto stream). */
  createStream: () => StreamLike<TEvent, TFinal>
  /** Processa un evento (il chiamante accumula testo/thinking ecc.). Può essere async. */
  onEvent: (event: TEvent) => void | Promise<void>
  /** Chiamato PRIMA di ogni tentativo (incluso il primo): il chiamante azzera il parziale di questa iterazione. */
  onAttemptStart?: () => void
  /** Notifica (logging) prima di ri-tentare. */
  onRetry?: (attempt: number, err: unknown) => void
  maxRetries?: number
  baseDelayMs?: number
  isTransient?: (err: unknown) => boolean
  sleep?: (ms: number) => Promise<void>
  jitter?: () => number
}

/** Classifica un errore come transitorio (ri-tentabile). Conservativo: i 4xx-client NON sono transitori. */
export function isTransientError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any
  const status: unknown = anyErr?.status ?? anyErr?.error?.status ?? anyErr?.response?.status
  if (typeof status === 'number') {
    if ([429, 500, 502, 503, 504, 529].includes(status)) return true
    if (status >= 400 && status < 500) return false // client error → NON ritentare
  }
  const msg = String(anyErr?.message ?? anyErr ?? '').toLowerCase()
  return /overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|network error|fetch failed|terminated|connection error|service unavailable|\b5\d\d\b/.test(msg)
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function consumeStreamWithRetry<TEvent, TFinal>(
  opts: ConsumeStreamRetryOpts<TEvent, TFinal>,
): Promise<TFinal> {
  const {
    createStream, onEvent, onAttemptStart, onRetry,
    maxRetries = 2, baseDelayMs = 800,
    isTransient = isTransientError,
    sleep = defaultSleep,
    jitter = () => Math.random() * 400,
  } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onAttemptStart?.()
    try {
      const stream = createStream()
      for await (const event of stream) {
        await onEvent(event)
      }
      return await stream.finalMessage()
    } catch (err) {
      lastErr = err
      if (isTransient(err) && attempt < maxRetries) {
        onRetry?.(attempt + 1, err)
        await sleep(baseDelayMs * Math.pow(2, attempt) + jitter())
        continue
      }
      throw err
    }
  }
  throw lastErr
}
