import { test, expect } from '@playwright/test'

test.describe('Pagina documento pubblico /doc/[id]', () => {
  test('documento inesistente mostra errore', async ({ page }) => {
    // /doc/ e /api/doc/ sono rotte pubbliche (no auth necessario)
    await page.goto('/doc/00000000-0000-0000-0000-000000000000')

    // Deve mostrare messaggio di errore
    await expect(page.locator('text=Documento non trovato')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=Il link potrebbe essere scaduto o non valido')).toBeVisible()

    // Link per tornare alla chat
    await expect(page.locator('a:has-text("Vai alla chat")')).toBeVisible()
  })

  test('pagina /doc/ non richiede autenticazione', async ({ page }) => {
    // Pulisci tutti i cookie
    await page.context().clearCookies()

    await page.goto('/doc/test-id')

    // Non deve redirectare a /login — la rotta è pubblica
    expect(page.url()).toContain('/doc/')
    expect(page.url()).not.toContain('/login')
  })
})
