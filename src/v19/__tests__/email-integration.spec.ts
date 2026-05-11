/**
 * Cervellone V19 — Integration test reali contro TopHost. OPT-IN.
 *
 * Eseguito solo se EMAIL_INFO_USER/PASS sono settati nell'env corrente.
 * In CI / vitest normale: skippato silenziosamente.
 *
 * Per eseguirlo manualmente:
 *   $env:EMAIL_INFO_USER='restruktura.it<N>'
 *   $env:EMAIL_INFO_PASS='<password>'
 *   $env:EMAIL_INFO_FROM_ADDRESS='info@restruktura.it'
 *   $env:EMAIL_INFO_DISPLAY_NAME='Restruktura'
 *   $env:TOPHOST_IMAP_HOST='pop.tophost.it'
 *   $env:TOPHOST_IMAP_PORT='993'
 *   $env:TOPHOST_IMAP_TLS='true'
 *   $env:TOPHOST_SMTP_HOST='mail.tophost.it'
 *   $env:TOPHOST_SMTP_PORT='587'
 *   $env:TOPHOST_SMTP_STARTTLS='true'
 *   npx vitest run src/v19/__tests__/email-integration.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { openImap, closeImap, makeSmtp } from '../tools/email/connection'
import { readEmail } from '../tools/email/read-email'
import { appendToSent } from '../tools/email/append-sent'

const hasInfo = !!process.env.EMAIL_INFO_USER && !!process.env.EMAIL_INFO_PASS
const itif = hasInfo ? it : it.skip

describe('email integration (LIVE, opt-in)', () => {
  itif(
    'IMAP connect info@ + list folders',
    async () => {
      const c = await openImap('info')
      const list = await c.list()
      expect(list.length).toBeGreaterThan(0)
      expect(list.some((m) => /inbox/i.test(m.path))).toBe(true)
      await closeImap(c)
    },
    30_000,
  )

  itif(
    'SMTP verify info@',
    async () => {
      const t = makeSmtp('info')
      await expect(t.verify()).resolves.toBeTruthy()
    },
    15_000,
  )

  itif(
    'readEmail ritorna array messages (anche vuoto è OK)',
    async () => {
      const r = await readEmail({ account: 'info', limit: 5 })
      expect(Array.isArray(r.messages)).toBe(true)
    },
    30_000,
  )

  itif(
    'SMTP send self-test (info@ → info@) + APPEND Sent',
    async () => {
      const t = makeSmtp('info')
      const info = (await t.sendMail({
        from: '"Restruktura" <info@restruktura.it>',
        to: 'info@restruktura.it',
        subject: `[TEST cervellone ${new Date().toISOString()}]`,
        text: 'Self-test integration cervellone V19. Ignorare.',
      })) as { messageId?: string; raw?: Buffer }
      expect(info.messageId).toBeTruthy()
      if (info.raw) {
        const append = await appendToSent('info', info.raw)
        expect(append.path).toMatch(/sent/i)
      }
    },
    60_000,
  )
})
