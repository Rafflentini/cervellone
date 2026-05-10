// src/v19/__tests__/email-config.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAccountConfig, listAccounts, EmailConfigError } from '../tools/email/config'

const ENV_BACKUP = { ...process.env }

describe('email/config', () => {
  beforeEach(() => {
    process.env.TOPHOST_IMAP_HOST = 'pop.tophost.it'
    process.env.TOPHOST_IMAP_PORT = '993'
    process.env.TOPHOST_IMAP_TLS = 'true'
    process.env.TOPHOST_SMTP_HOST = 'mail.tophost.it'
    process.env.TOPHOST_SMTP_PORT = '587'
    process.env.TOPHOST_SMTP_STARTTLS = 'true'
    process.env.EMAIL_INFO_USER = 'restruktura.it78915'
    process.env.EMAIL_INFO_PASS = 'redacted'
    process.env.EMAIL_INFO_FROM_ADDRESS = 'info@restruktura.it'
    process.env.EMAIL_INFO_DISPLAY_NAME = 'Restruktura'
  })
  afterEach(() => { process.env = { ...ENV_BACKUP } })

  it('returns account config for "info"', () => {
    const cfg = getAccountConfig('info')
    expect(cfg.imap.host).toBe('pop.tophost.it')
    expect(cfg.imap.port).toBe(993)
    expect(cfg.imap.secure).toBe(true)
    expect(cfg.smtp.host).toBe('mail.tophost.it')
    expect(cfg.smtp.port).toBe(587)
    expect(cfg.auth.user).toBe('restruktura.it78915')
    expect(cfg.fromAddress).toBe('info@restruktura.it')
    expect(cfg.displayName).toBe('Restruktura')
  })

  it('throws EmailConfigError when account user is missing', () => {
    delete process.env.EMAIL_INFO_USER
    expect(() => getAccountConfig('info')).toThrow(EmailConfigError)
  })

  it('throws EmailConfigError on unknown account', () => {
    expect(() => getAccountConfig('unknown' as never)).toThrow(EmailConfigError)
  })

  it('listAccounts returns only configured accounts', () => {
    delete process.env.EMAIL_RAFFAELE_USER
    expect(listAccounts()).toEqual(['info'])
  })
})
