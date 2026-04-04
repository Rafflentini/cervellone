# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile.spec.ts >> Mobile UI >> pagina /doc/ è responsive su mobile
- Location: tests\mobile.spec.ts:72:7

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
  3  | // Questi test usano il progetto "mobile" (Pixel 5 viewport)
  4  | test.describe('Mobile UI', () => {
  5  |   test.use({ viewport: { width: 393, height: 851 } })
  6  | 
  7  |   async function login(page: import('@playwright/test').Page) {
  8  |     await page.goto('/login')
  9  |     await page.fill('input[type="password"]', 'Raffaele2026!')
  10 |     await page.click('button[type="submit"]')
  11 |     await page.waitForURL('**/chat')
  12 |   }
  13 | 
  14 |   test('login page è responsive', async ({ page }) => {
  15 |     await page.goto('/login')
  16 | 
  17 |     // Form visibile e non overflow
  18 |     const form = page.locator('form')
  19 |     await expect(form).toBeVisible()
  20 | 
  21 |     const box = await form.boundingBox()
  22 |     expect(box!.width).toBeLessThanOrEqual(393)
  23 |   })
  24 | 
  25 |   test('sidebar nascosta di default su mobile', async ({ page }) => {
  26 |     await login(page)
  27 | 
  28 |     // La sidebar deve essere nascosta (translate-x-full)
  29 |     // Il bottone hamburger deve essere visibile
  30 |     const hamburger = page.locator('button:has(svg path[d="M4 6h16M4 12h16M4 18h16"])')
  31 |     await expect(hamburger).toBeVisible()
  32 |   })
  33 | 
  34 |   test('hamburger apre/chiude sidebar su mobile', async ({ page }) => {
  35 |     await login(page)
  36 | 
  37 |     const hamburger = page.locator('button:has(svg path[d="M4 6h16M4 12h16M4 18h16"])')
  38 |     await hamburger.click()
  39 | 
  40 |     // Sidebar visible — bottone "Esci" visibile
  41 |     await expect(page.locator('button:has-text("Esci")')).toBeVisible()
  42 | 
  43 |     // Overlay visibile
  44 |     const overlay = page.locator('div.fixed.inset-0.bg-black\\/50')
  45 |     await expect(overlay).toBeVisible()
  46 | 
  47 |     // Click overlay chiude sidebar
  48 |     await overlay.click()
  49 |     await expect(overlay).not.toBeVisible()
  50 |   })
  51 | 
  52 |   test('welcome screen su mobile con suggerimenti', async ({ page }) => {
  53 |     await login(page)
  54 | 
  55 |     await expect(page.locator('text=Ciao Raffaele!')).toBeVisible()
  56 | 
  57 |     // Suggerimenti sono su griglia 2 colonne
  58 |     await expect(page.locator('button:has-text("Genera un POS cantiere")')).toBeVisible()
  59 |   })
  60 | 
  61 |   test('input floating visibile e funzionante su mobile', async ({ page }) => {
  62 |     await login(page)
  63 | 
  64 |     const textarea = page.locator('textarea[placeholder="Scrivi un messaggio..."]')
  65 |     await expect(textarea).toBeVisible()
  66 | 
  67 |     // Digita testo
  68 |     await textarea.fill('test mobile')
  69 |     await expect(textarea).toHaveValue('test mobile')
  70 |   })
  71 | 
  72 |   test('pagina /doc/ è responsive su mobile', async ({ page }) => {
> 73 |     await page.goto('/doc/00000000-0000-0000-0000-000000000000')
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/doc/00000000-0000-0000-0000-000000000000
  74 | 
  75 |     // Errore visibile e non overflow
  76 |     await expect(page.locator('text=Documento non trovato')).toBeVisible({ timeout: 10000 })
  77 |     const btn = page.locator('a:has-text("Vai alla chat")')
  78 |     await expect(btn).toBeVisible()
  79 |   })
  80 | })
  81 | 
```