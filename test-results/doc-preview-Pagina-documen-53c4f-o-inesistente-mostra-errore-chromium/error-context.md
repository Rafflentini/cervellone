# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: doc-preview.spec.ts >> Pagina documento pubblico /doc/[id] >> documento inesistente mostra errore
- Location: tests\doc-preview.spec.ts:4:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/doc/00000000-0000-0000-0000-000000000000
Call log:
  - navigating to "http://localhost:3000/doc/00000000-0000-0000-0000-000000000000", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | 
  3  | test.describe('Pagina documento pubblico /doc/[id]', () => {
  4  |   test('documento inesistente mostra errore', async ({ page }) => {
  5  |     // /doc/ e /api/doc/ sono rotte pubbliche (no auth necessario)
> 6  |     await page.goto('/doc/00000000-0000-0000-0000-000000000000')
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/doc/00000000-0000-0000-0000-000000000000
  7  | 
  8  |     // Deve mostrare messaggio di errore
  9  |     await expect(page.locator('text=Documento non trovato')).toBeVisible({ timeout: 10000 })
  10 |     await expect(page.locator('text=Il link potrebbe essere scaduto o non valido')).toBeVisible()
  11 | 
  12 |     // Link per tornare alla chat
  13 |     await expect(page.locator('a:has-text("Vai alla chat")')).toBeVisible()
  14 |   })
  15 | 
  16 |   test('pagina /doc/ non richiede autenticazione', async ({ page }) => {
  17 |     // Pulisci tutti i cookie
  18 |     await page.context().clearCookies()
  19 | 
  20 |     await page.goto('/doc/test-id')
  21 | 
  22 |     // Non deve redirectare a /login — la rotta è pubblica
  23 |     expect(page.url()).toContain('/doc/')
  24 |     expect(page.url()).not.toContain('/login')
  25 |   })
  26 | })
  27 | 
```