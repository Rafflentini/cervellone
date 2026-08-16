import { describe, it, expect } from 'vitest'
import { classifyGoogleError, GoogleAuthDeadError } from './google-token-health'

/**
 * Classificazione pura degli errori Google. Nessun mock: la funzione è
 * deterministica e non tocca né rete né DB.
 *
 * Le forme degli errori sono ricavate da
 * node_modules/google-auth-library/build/src/auth/oauth2client.js:
 *  - refreshTokenNoCache() rilancia il GaxiosError con message === 'invalid_grant'
 *  - se error_description contiene "ReAuth", message viene RISCRITTO in
 *    JSON.stringify(response.data) → '{"error":"invalid_grant",...}'
 *  - getAccessTokenAsync() lancia Error('No refresh token or refresh handler callback is set.')
 *  - refreshTokenNoCache() lancia Error('No refresh token is set.')
 */

function gaxiosLike(message: string, extra: Record<string, unknown>): unknown {
  return Object.assign(new Error(message), extra)
}

describe('classifyGoogleError — dead (token revocato/scaduto)', () => {
  it('riconosce il message secco "invalid_grant"', () => {
    expect(classifyGoogleError(new Error('invalid_grant'))).toBe('dead')
  })

  it('riconosce la forma ReAuth (message = JSON del body)', () => {
    const reauth = new Error(
      JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked. ReAuth required.',
      }),
    )
    expect(classifyGoogleError(reauth)).toBe('dead')
  })

  it('riconosce response.data.error === "invalid_grant" anche se il message è generico', () => {
    const err = gaxiosLike('Bad Request', {
      status: 400,
      response: { status: 400, data: { error: 'invalid_grant', error_description: 'Bad Request' } },
    })
    expect(classifyGoogleError(err)).toBe('dead')
  })
})

describe('classifyGoogleError — config (client id/secret errati)', () => {
  it('unauthorized_client ⇒ config', () => {
    const err = gaxiosLike('unauthorized_client', {
      status: 401,
      response: { status: 401, data: { error: 'unauthorized_client' } },
    })
    expect(classifyGoogleError(err)).toBe('config')
  })

  it('invalid_client ⇒ config', () => {
    const err = gaxiosLike('invalid_client', {
      status: 401,
      response: { status: 401, data: { error: 'invalid_client', error_description: 'Unauthorized' } },
    })
    expect(classifyGoogleError(err)).toBe('config')
  })

  it('config NON è dead: il re-consent non risolverebbe', () => {
    expect(classifyGoogleError(new Error('invalid_client'))).not.toBe('dead')
  })
})

describe('classifyGoogleError — scope', () => {
  it('403 insufficientPermissions ⇒ scope', () => {
    const err = gaxiosLike('Insufficient Permission', {
      status: 403,
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Insufficient Permission',
            errors: [{ domain: 'global', reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
            status: 'PERMISSION_DENIED',
          },
        },
      },
    })
    expect(classifyGoogleError(err)).toBe('scope')
  })

  it('403 ACCESS_TOKEN_SCOPE_INSUFFICIENT (details[].reason) ⇒ scope', () => {
    const err = gaxiosLike('Request had insufficient authentication scopes.', {
      status: 403,
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
                domain: 'googleapis.com',
              },
            ],
          },
        },
      },
    })
    expect(classifyGoogleError(err)).toBe('scope')
  })
})

describe('classifyGoogleError — REGRESSIONE: 403 non è di per sé mancanza di scope', () => {
  it('403 rateLimitExceeded ⇒ transient, NON scope (altrimenti alert falsi)', () => {
    const err = gaxiosLike('Rate Limit Exceeded', {
      status: 403,
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: 'Rate Limit Exceeded',
            errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
          },
        },
      },
    })
    expect(classifyGoogleError(err)).toBe('transient')
  })

  it('403 userRateLimitExceeded ⇒ transient', () => {
    const err = gaxiosLike('User Rate Limit Exceeded', {
      status: 403,
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
          },
        },
      },
    })
    expect(classifyGoogleError(err)).toBe('transient')
  })

  it('403 senza reason riconoscibile NON diventa scope', () => {
    const err = gaxiosLike('Forbidden', { status: 403, response: { status: 403, data: {} } })
    expect(classifyGoogleError(err)).toBe('other')
  })
})

describe('classifyGoogleError — credenziali assenti (NON deve latchare)', () => {
  it('"No refresh token is set." ⇒ other', () => {
    expect(classifyGoogleError(new Error('No refresh token is set.'))).toBe('other')
  })

  it('"No refresh token or refresh handler callback is set." ⇒ other', () => {
    expect(classifyGoogleError(new Error('No refresh token or refresh handler callback is set.'))).toBe('other')
  })
})

describe('classifyGoogleError — transient', () => {
  it.each([408, 429, 500, 502, 503, 504])('status %i ⇒ transient', (status) => {
    expect(classifyGoogleError(gaxiosLike('boom', { status, response: { status, data: {} } }))).toBe('transient')
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])('code %s ⇒ transient', (code) => {
    expect(classifyGoogleError(gaxiosLike('network down', { code }))).toBe('transient')
  })

  it('"fetch failed" ⇒ transient', () => {
    expect(classifyGoogleError(new Error('fetch failed'))).toBe('transient')
  })

  it.each(['backendError', 'internalError'])('reason %s ⇒ transient', (reason) => {
    const err = gaxiosLike('Backend Error', {
      status: 500,
      response: { status: 500, data: { error: { code: 500, errors: [{ reason }] } } },
    })
    expect(classifyGoogleError(err)).toBe('transient')
  })
})

describe('classifyGoogleError — other', () => {
  it.each([
    ['errore sconosciuto', new Error('qualcosa è andato storto')],
    ['404', Object.assign(new Error('File not found'), { status: 404 })],
    ['null', null],
    ['undefined', undefined],
    ['stringa', 'boom'],
  ])('%s ⇒ other', (_label, err) => {
    expect(classifyGoogleError(err)).toBe('other')
  })
})

describe('GoogleAuthDeadError', () => {
  it('porta con sé la spiegazione completa (i ~20 catch di drive.ts la stampano così com è)', () => {
    const err = new GoogleAuthDeadError('dead')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('GoogleAuthDeadError')
    expect(err.message).toContain('Token Google scaduto o revocato')
    expect(err.message).toContain('non posso accedere a Drive, Gmail e Calendar')
    expect(err.message).toContain('Non è un problema di file mancanti')
    expect(err.message).toContain('https://cervellone-five.vercel.app/api/auth/google')
    expect(err.message).toContain('restruktura.drive@gmail.com')
  })

  it('interpolato in stringa (come fanno i catch di drive.ts) resta leggibile', () => {
    const err = new GoogleAuthDeadError('dead')
    const rendered = `Errore listando i file: ${err}`
    expect(rendered).toContain('Token Google scaduto')
    expect(rendered).toContain('/api/auth/google')
  })

  it('kind=config aggiunge la nota che il re-consent NON risolve', () => {
    const err = new GoogleAuthDeadError('config')
    expect(err.message).toContain('https://cervellone-five.vercel.app/api/auth/google')
    expect(err.message.toLowerCase()).toContain('client_id')
  })
})
