// src/lib/stream-retry.test.ts — unit test per consumeStreamWithRetry + isTransientError.
// Stream FINTO: factory che ritorna { [Symbol.asyncIterator], finalMessage }. sleep/jitter iniettati
// per determinismo e zero attesa reale.

import { describe, it, expect, vi } from 'vitest'
import {
  consumeStreamWithRetry,
  isTransientError,
  type StreamLike,
} from './stream-retry'

// --- Helpers per costruire stream finti -------------------------------------

interface FakeStreamSpec<TEvent, TFinal> {
  /** Eventi emessi prima dell'eventuale errore. */
  events?: TEvent[]
  /** Se presente, viene lanciato DOPO aver emesso `events` (errore mid-iteration). */
  iterError?: unknown
  /** Final ritornato da finalMessage() (se non lancia). */
  final?: TFinal
  /** Se presente, finalMessage() lancia questo errore invece di ritornare. */
  finalError?: unknown
}

function makeStream<TEvent, TFinal>(
  spec: FakeStreamSpec<TEvent, TFinal>,
): StreamLike<TEvent, TFinal> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
      for (const e of spec.events ?? []) {
        yield e
      }
      if (spec.iterError !== undefined) {
        throw spec.iterError
      }
    },
    async finalMessage(): Promise<TFinal> {
      if (spec.finalError !== undefined) {
        throw spec.finalError
      }
      return spec.final as TFinal
    },
  }
}

const transient529 = () => Object.assign(new Error('overloaded'), { status: 529 })
const noWait = { sleep: async () => {}, jitter: () => 0 }

// --- Test -------------------------------------------------------------------

describe('consumeStreamWithRetry', () => {
  it('1. happy path: 3 eventi + finalMessage ok → onEvent ×3, ritorna final, 0 retry, onAttemptStart ×1', async () => {
    const onEvent = vi.fn()
    const onAttemptStart = vi.fn()
    const onRetry = vi.fn()
    const createStream = vi.fn(() =>
      makeStream<string, { id: string }>({
        events: ['a', 'b', 'c'],
        final: { id: 'FINAL' },
      }),
    )

    const final = await consumeStreamWithRetry({
      createStream,
      onEvent,
      onAttemptStart,
      onRetry,
      ...noWait,
    })

    expect(final).toEqual({ id: 'FINAL' })
    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent).toHaveBeenNthCalledWith(1, 'a')
    expect(onEvent).toHaveBeenNthCalledWith(2, 'b')
    expect(onEvent).toHaveBeenNthCalledWith(3, 'c')
    expect(createStream).toHaveBeenCalledTimes(1)
    expect(onAttemptStart).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('2. transient mid-iteration → retry e successo (createStream ×2, onAttemptStart ×2, onRetry ×1, final del 2°)', async () => {
    const onAttemptStart = vi.fn()
    const onRetry = vi.fn()
    const createStream = vi
      .fn<() => StreamLike<string, { id: string }>>()
      .mockImplementationOnce(() =>
        makeStream({ events: ['only-1-event'], iterError: transient529() }),
      )
      .mockImplementationOnce(() =>
        makeStream({ events: ['x', 'y'], final: { id: 'SECOND' } }),
      )

    const final = await consumeStreamWithRetry({
      createStream,
      onEvent: vi.fn(),
      onAttemptStart,
      onRetry,
      ...noWait,
    })

    expect(final).toEqual({ id: 'SECOND' })
    expect(createStream).toHaveBeenCalledTimes(2)
    expect(onAttemptStart).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ status: 529 }))
  })

  it('3. transient su finalMessage → retry; ok al 2° tentativo', async () => {
    const onRetry = vi.fn()
    const createStream = vi
      .fn<() => StreamLike<string, { id: string }>>()
      .mockImplementationOnce(() =>
        makeStream({ events: ['a'], finalError: transient529() }),
      )
      .mockImplementationOnce(() =>
        makeStream({ events: ['a'], final: { id: 'OK' } }),
      )

    const final = await consumeStreamWithRetry({
      createStream,
      onEvent: vi.fn(),
      onRetry,
      ...noWait,
    })

    expect(final).toEqual({ id: 'OK' })
    expect(createStream).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('4. esaurisce i retry → throw; tentativi = maxRetries+1', async () => {
    const createStream = vi.fn(() =>
      makeStream<string, unknown>({ iterError: transient529() }),
    )
    const onRetry = vi.fn()

    await expect(
      consumeStreamWithRetry({
        createStream,
        onEvent: vi.fn(),
        onRetry,
        maxRetries: 2,
        ...noWait,
      }),
    ).rejects.toMatchObject({ status: 529 })

    expect(createStream).toHaveBeenCalledTimes(3) // maxRetries(2) + 1
    expect(onRetry).toHaveBeenCalledTimes(2) // un retry per ogni tentativo fallito tranne l'ultimo
  })

  it('5. errore NON transitorio → throw immediato, 0 retry (createStream ×1)', async () => {
    const err400 = Object.assign(new Error('invalid request'), { status: 400 })
    const createStream = vi.fn(() =>
      makeStream<string, unknown>({ iterError: err400 }),
    )
    const onRetry = vi.fn()

    await expect(
      consumeStreamWithRetry({
        createStream,
        onEvent: vi.fn(),
        onRetry,
        ...noWait,
      }),
    ).rejects.toBe(err400)

    expect(createStream).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('7. onAttemptStart è chiamato PRIMA di ogni tentativo (azzeramento parziale tra i tentativi)', async () => {
    // Spy che registra l'ordine: ogni onAttemptStart deve precedere il relativo createStream.
    const order: string[] = []
    const createStream = vi
      .fn<() => StreamLike<string, { id: string }>>()
      .mockImplementationOnce(() => {
        order.push('createStream#1')
        return makeStream({ events: ['a'], iterError: transient529() })
      })
      .mockImplementationOnce(() => {
        order.push('createStream#2')
        return makeStream({ events: ['b'], final: { id: 'DONE' } })
      })

    const onAttemptStart = vi.fn(() => {
      order.push(`onAttemptStart#${onAttemptStart.mock.calls.length}`)
    })

    const final = await consumeStreamWithRetry({
      createStream,
      onEvent: vi.fn(),
      onAttemptStart,
      ...noWait,
    })

    expect(final).toEqual({ id: 'DONE' })
    expect(onAttemptStart).toHaveBeenCalledTimes(2)
    expect(order).toEqual([
      'onAttemptStart#1',
      'createStream#1',
      'onAttemptStart#2',
      'createStream#2',
    ])
  })
})

describe('isTransientError', () => {
  it('6. status 5xx/429 → true', () => {
    expect(isTransientError({ status: 529 })).toBe(true)
    expect(isTransientError({ status: 503 })).toBe(true)
    expect(isTransientError({ status: 500 })).toBe(true)
    expect(isTransientError({ status: 429 })).toBe(true)
  })

  it('6. status 4xx-client → false', () => {
    expect(isTransientError({ status: 400 })).toBe(false)
    expect(isTransientError({ status: 401 })).toBe(false)
    expect(isTransientError({ status: 404 })).toBe(false)
    expect(isTransientError({ status: 422 })).toBe(false)
  })

  it('6. messaggi transitori → true', () => {
    expect(isTransientError(new Error('Overloaded'))).toBe(true)
    expect(isTransientError(new Error('fetch failed'))).toBe(true)
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientError(new Error('Request timeout'))).toBe(true)
  })

  it('6. messaggio non transitorio → false', () => {
    expect(isTransientError(new Error('invalid_request_error'))).toBe(false)
  })

  it('6. status nidificato (error.status / response.status) → true', () => {
    expect(isTransientError({ error: { status: 503 } })).toBe(true)
    expect(isTransientError({ response: { status: 502 } })).toBe(true)
  })
})
