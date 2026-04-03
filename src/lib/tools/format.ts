/**
 * Format a number Italian-style: 12500.50 → "12.500,50"
 */
export function formatEuro(value: number): string {
  return value.toLocaleString('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Format a date Italian-style: "2026-04-03" → "03/04/2026"
 */
export function formatDate(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/**
 * Generate a preventivo number: PREV-2026-001
 */
export function generateNumeroPreventivo(): string {
  const now = new Date()
  const year = now.getFullYear()
  const rand = Math.floor(Math.random() * 900) + 100
  return `PREV-${year}-${rand}`
}
