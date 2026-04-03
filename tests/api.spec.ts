import { test, expect } from '@playwright/test'

test.describe('API Endpoints', () => {
  test.describe('Auth API', () => {
    test('POST /api/auth con password errata ritorna 401', async ({ request }) => {
      const res = await request.post('/api/auth', {
        data: { password: 'sbagliata' },
      })
      expect(res.status()).toBe(401)
    })

    test('POST /api/auth con password corretta ritorna 200 e set cookie', async ({ request }) => {
      const res = await request.post('/api/auth', {
        data: { password: 'Raffaele2026!' },
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      // Verifica che il cookie è stato impostato
      const headers = res.headers()
      expect(headers['set-cookie']).toContain('cervellone_auth')
    })

    test('DELETE /api/auth cancella il cookie', async ({ request }) => {
      // Prima autentica
      await request.post('/api/auth', {
        data: { password: 'Raffaele2026!' },
      })

      const res = await request.delete('/api/auth')
      expect(res.status()).toBe(200)
    })
  })

  test.describe('Conversations API (autenticato)', () => {
    test('GET /api/conversations senza auth ritorna 401', async ({ request }) => {
      const res = await request.get('/api/conversations')
      expect(res.status()).toBe(401)
    })

    test('GET /api/conversations con auth ritorna lista', async ({ request }) => {
      // Autentica
      await request.post('/api/auth', {
        data: { password: 'Raffaele2026!' },
      })

      const res = await request.get('/api/conversations')
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('conversations')
      expect(Array.isArray(body.conversations)).toBe(true)
    })
  })

  test.describe('Doc API (pubblica)', () => {
    test('GET /api/doc/id-inesistente ritorna 404', async ({ request }) => {
      const res = await request.get('/api/doc/00000000-0000-0000-0000-000000000000')
      expect(res.status()).toBe(404)
    })
  })

  test.describe('Telegram API (pubblica)', () => {
    test('POST /api/telegram senza body gestisce errore', async ({ request }) => {
      const res = await request.post('/api/telegram', {
        data: {},
      })
      // Non deve crashare — ritorna 200 (webhook Telegram ignora errori)
      // o un altro status gestito
      expect(res.status()).toBeLessThan(500)
    })
  })
})
