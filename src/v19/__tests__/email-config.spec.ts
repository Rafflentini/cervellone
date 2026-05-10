// src/v19/__tests__/email-config.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAccountConfig, listAccounts, EmailConfigError } from '../tools/email/config'

const RELEVANT_KEYS = [
  'TOPHOST_IMAP_HOST', 'TOPHOST_IMAP_PORT', 'TOPHOST_IMAP_TLS',
  'TOPHOST_SMTP_HOST', 'TOPHOST_SMTP_PORT', 'TOPHOST_SMTP_STARTTLS',
  'EMAIL_INFO_USER', 'EMAIL_INFO_PASS', 'EMAIL_INFO_FROM_ADDRESS', 'EMAIL_INFO_DISPLAY_NAME',
  'EMAIL_RAFFAELE_USER', 'EMAIL_RAFFAELE_PASS', 'EMAIL_RAFFAELE_FROM_ADDRESS', 'EMAIL_RAFFAELE_DISPLAY_NAME',
] as const

describe('email/config', () => {
  beforeEach(() => {
    for (const k of RELEVANT_KEYS) delete process.env[k]
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
  afterEach(() => {
    for (const k of RELEVANT_KEYS) delete process.env[k]
  })

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

  it('throws EmailConfigError on non-numeric port', () => {
    process.env.TOPHOST_IMAP_PORT = 'abc'
    expect(() => getAccountConfig('info')).toThrow(EmailConfigError)
  })

  it('throws EmailConfigError on out-of-range port', () => {
    process.env.TOPHOST_IMAP_PORT = '70000'
    expect(() => getAccountConfig('info')).toThrow(EmailConfigError)
  })

  it('throws EmailConfigError on unrecognized boolean', () => {
    process.env.TOPHOST_IMAP_TLS = 'maybe'
    expect(() => getAccountConfig('info')).toThrow(EmailConfigError)
  })

  it('accepts "1" and "yes" for boolean true', () => {
    process.env.TOPHOST_IMAP_TLS = '1'
    process.env.TOPHOST_SMTP_STARTTLS = 'yes'
    const cfg = getAccountConfig('info')
    expect(cfg.imap.secure).toBe(true)
    expect(cfg.smtp.requireTLS).toBe(true)
  })
})
