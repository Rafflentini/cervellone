/**
 * src/lib/fic-aliquote.ts — l'ELENCO DELLE ALIQUOTE IVA dell'azienda, letto da
 * Fatture in Cloud.
 *
 * ⚠️ **Perche' e' un file suo.** Questa funzione viveva dentro
 * `fic-write-tools.ts`, dove la usa `resolveVatId` per cercare un'aliquota per
 * VALORE (22%, 10%). Dal 15 settembre 2026 le serve anche a
 * `fic-fattura-ospite.ts`, che cerca una cosa diversa: la NATURA N1 «Iva
 * esclusa ex art. 15», che di valore ha 0 — come ogni altra natura — e si
 * riconosce solo dalla DESCRIZIONE.
 *
 * Le strade erano tre: importarla al contrario (ciclo fra i due moduli),
 * riscriverla (due copie della stessa lettura, che in questo repo divergono
 * puntualmente), o metterla dove possono prenderla tutti e due. E' la terza.
 * `fic-write-tools.ts` la ri-esporta col vecchio nome, cosi' i test che c'erano
 * continuano a trovarla dov'era.
 */

import { ficGet, getCompanyId } from './fatture-in-cloud'
import type { CodiceSocieta } from './societa'

/** Come `parseAliquotaFic` in fic-write-tools: NON cancella il punto decimale. */
function numeroAliquota(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const pulito = value.trim().replace('%', '').replace(',', '.')
  if (!pulito) return null
  const parsed = Number(pulito)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Elenco COMPLETO delle aliquote IVA dell'azienda.
 *
 * Prima si leggeva una pagina sola: un'aliquota perfettamente esistente ma
 * oltre la prima pagina risultava inesistente. Si prova il path con
 * `/settings/` e in fallback quello precedente, cosi' il fix non dipende da
 * quale dei due risponda.
 */
export async function elencoAliquoteFic(
  societa: CodiceSocieta,
): Promise<{ ok: true; righe: Record<string, unknown>[] } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const righe: Record<string, unknown>[] = []
  // ⚠️ Gli id gia' visti. `settings/vat_types` di Fatture in Cloud NON e'
  // paginato: ignora `page` e restituisce ogni volta la stessa lista intera.
  // Senza questa guardia il ciclo girava tutte e 10 le volte — visto nel log
  // delle richieste dell'app il 15 settembre 2026, dieci chiamate identiche in
  // quattro secondi — e `righe` finiva per contenere ogni aliquota DIECI
  // VOLTE. Cioe' l'elenco che il tool mostra all'Ingegnere quando gli chiede
  // quale aliquota usare era dieci volte piu' lungo del vero.
  //
  // Fermarsi su `last_page` non bastava: quel campo qui non arriva. La regola
  // che regge in entrambi i casi e' un'altra — se una pagina non porta NESSUN
  // id nuovo, non c'e' altro da leggere.
  const idVisti = new Set<string>()
  for (let page = 1; page <= 10; page++) {
    const r = await ficGet(`/c/${company.id}/settings/vat_types`, { per_page: 100, page }, societa)
    if (!r.ok) {
      if (page > 1) break
      const legacy = await ficGet(`/c/${company.id}/vat_types`, { per_page: 100 }, societa)
      if (!legacy.ok) return { ok: false, error: legacy.error }
      const lista = Array.isArray(legacy.data?.data) ? legacy.data.data as Record<string, unknown>[] : []
      return { ok: true, righe: lista }
    }
    const lista = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
    const nuove = lista.filter((x) => {
      const id = String(x?.id ?? "")
      if (!id || idVisti.has(id)) return false
      idVisti.add(id)
      return true
    })
    righe.push(...nuove)
    // Nessun id nuovo = non c'e' una pagina dopo, comunque FIC risponda.
    if (nuove.length === 0) break
    const meta = (r.data as unknown as Record<string, unknown> | undefined) ?? {}
    const ultima = numeroAliquota(meta.last_page)
    if (ultima !== null && page >= ultima) break
  }
  return { ok: true, righe }
}
