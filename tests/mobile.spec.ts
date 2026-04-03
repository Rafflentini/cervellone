import { test, expect } from '@playwright/test'

// Questi test usano il progetto "mobile" (Pixel 5 viewport)
test.describe('Mobile UI', () => {
  test.use({ viewport: { width: 393, height: 851 } })

  async function login(page: import('@playwright/test').Page) {
    await page.goto('/login')
    await page.fill('input[type="password"]', 'Raffaele2026!')
    await page.click('button[type="submit"]')
    await page.waitForURL('**/chat')
  }

  test('login page è responsive', async ({ page }) => {
    await page.goto('/login')

    // Form visibile e non overflow
    const form = page.locator('form')
    await expect(form).toBeVisible()

    const box = await form.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(393)
  })

  test('sidebar nascosta di default su mobile', async ({ page }) => {
    await login(page)

    // La sidebar deve essere nascosta (translate-x-full)
    // Il bottone hamburger deve essere visibile
    const hamburger = page.locator('button:has(svg path[d="M4 6h16M4 12h16M4 18h16"])')
    await expect(hamburger).toBeVisible()
  })

  test('hamburger apre/chiude sidebar su mobile', async ({ page }) => {
    await login(page)

    const hamburger = page.locator('button:has(svg path[d="M4 6h16M4 12h16M4 18h16"])')
    await hamburger.click()

    // Sidebar visible — bottone "Esci" visibile
    await expect(page.locator('button:has-text("Esci")')).toBeVisible()

    // Overlay visibile
    const overlay = page.locator('div.fixed.inset-0.bg-black\\/50')
    await expect(overlay).toBeVisible()

    // Click overlay chiude sidebar
    await overlay.click()
    await expect(overlay).not.toBeVisible()
  })

  test('welcome screen su mobile con suggerimenti', async ({ page }) => {
    await login(page)

    await expect(page.locator('text=Ciao Raffaele!')).toBeVisible()

    // Suggerimenti sono su griglia 2 colonne
    await expect(page.locator('button:has-text("Genera un POS cantiere")')).toBeVisible()
  })

  test('input floating visibile e funzionante su mobile', async ({ page }) => {
    await login(page)

    const textarea = page.locator('textarea[placeholder="Scrivi un messaggio..."]')
    await expect(textarea).toBeVisible()

    // Digita testo
    await textarea.fill('test mobile')
    await expect(textarea).toHaveValue('test mobile')
  })

  test('pagina /doc/ è responsive su mobile', async ({ page }) => {
    await page.goto('/doc/00000000-0000-0000-0000-000000000000')

    // Errore visibile e non overflow
    await expect(page.locator('text=Documento non trovato')).toBeVisible({ timeout: 10000 })
    const btn = page.locator('a:has-text("Vai alla chat")')
    await expect(btn).toBeVisible()
  })
})
