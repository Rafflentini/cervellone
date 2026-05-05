/**
 * lib/gmail-summary.ts — Digest mattutino + detection critical alert.
 */

import { supabase } from './supabase'
import { listInbox, type GmailMessageMeta } from './gmail-tools'

export interface MailSummary {
  totalUnread: number
  byCategory: Record<string, number>
  critical: GmailMessageMeta[]
  routine: GmailMessageMeta[]
  digest: string
}

interface AlertRule {
  rule_type: 'keyword' | 'sender_vip'
  pattern: string
  severity: 'high' | 'medium' | 'low'
}

async function loadAlertRules(): Promise<AlertRule[]> {
  const { data } = await supabase
    .from('gmail_alert_rules')
    .select('rule_type, pattern, severity')
    .eq('enabled', true)
  return (data || []) as AlertRule[]
}

function matchesAlert(msg: GmailMessageMeta, rules: AlertRule[]): { matched: boolean; severity: string; reason: string } {
  for (const r of rules) {
    if (r.rule_type === 'keyword') {
      const haystack = `${msg.subject} ${msg.snippet}`.toLowerCase()
      if (haystack.includes(r.pattern.toLowerCase())) {
        return { matched: true, severity: r.severity, reason: `keyword: ${r.pattern}` }
      }
    } else if (r.rule_type === 'sender_vip') {
      if (msg.from.toLowerCase().includes(r.pattern.toLowerCase())) {
        return { matched: true, severity: r.severity, reason: `VIP sender: ${r.pattern}` }
      }
    }
  }
  return { matched: false, severity: 'low', reason: '' }
}

export async function buildDailySummary(sinceDays = 1): Promise<MailSummary> {
  const messages = await listInbox({ onlyUnread: true, sinceDays, maxResults: 100 })
  const rules = await loadAlertRules()

  const critical: GmailMessageMeta[] = []
  const routine: GmailMessageMeta[] = []
  const byCategory: Record<string, number> = {}

  for (const m of messages) {
    const match = matchesAlert(m, rules)
    if (match.matched && match.severity === 'high') {
      critical.push(m)
    } else {
      routine.push(m)
    }
    const cat = naiveCategory(m)
    byCategory[cat] = (byCategory[cat] || 0) + 1
  }

  const digest = formatDigest(messages.length, byCategory, critical, routine)
  return {
    totalUnread: messages.length,
    byCategory,
    critical,
    routine,
    digest,
  }
}

function naiveCategory(m: GmailMessageMeta): string {
  const fromLow = m.from.toLowerCase()
  const subjLow = m.subject.toLowerCase()
  if (/cassaedile|inps|inail|comune|regione|agenzia/i.test(fromLow)) return 'enti'
  if (/fattura|ddt|listino|preventivo/i.test(subjLow)) return 'fornitori'
  if (/cliente|sopralluogo|capitolato/i.test(subjLow)) return 'clienti'
  if (/newsletter|news|update/i.test(fromLow + subjLow)) return 'newsletter'
  return 'altro'
}

function formatDigest(
  total: number,
  byCategory: Record<string, number>,
  critical: GmailMessageMeta[],
  routine: GmailMessageMeta[],
): string {
  const lines: string[] = [`🌅 *Buongiorno Ingegnere* — ${total} mail nuove non lette.`]
  if (critical.length > 0) {
    lines.push('')
    lines.push(`🚨 *Urgenti* (${critical.length}):`)
    for (const m of critical.slice(0, 5)) {
      lines.push(`- ${truncate(m.from, 30)} — '${truncate(m.subject, 60)}'`)
    }
  }
  if (Object.keys(byCategory).length > 0) {
    lines.push('')
    lines.push(`📊 *Per categoria:*`)
    for (const [cat, count] of Object.entries(byCategory)) {
      lines.push(`- ${cat}: ${count}`)
    }
  }
  if (routine.length > 0) {
    lines.push('')
    lines.push(`📋 Routine (${routine.length}): per dettagli chiedi "leggi le mail nuove"`)
  }
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export async function checkCriticalAlerts(sinceTs: Date): Promise<GmailMessageMeta[]> {
  const sinceDays = Math.max(1, Math.ceil((Date.now() - sinceTs.getTime()) / (24 * 3600 * 1000)))
  const messages = await listInbox({ onlyUnread: true, sinceDays, maxResults: 50 })
  const rules = await loadAlertRules()
  const critical: GmailMessageMeta[] = []
  for (const m of messages) {
    if (new Date(m.date).getTime() < sinceTs.getTime()) continue
    const match = matchesAlert(m, rules)
    if (match.matched && match.severity !== 'low') {
      critical.push(m)
    }
  }
  return critical
}
