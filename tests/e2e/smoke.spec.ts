import { test, expect } from "@playwright/test";

/**
 * Smoke E2E mínimo — no requiere seed ni credenciales reales.
 *
 * Cubre:
 *  - /login renderiza
 *  - credenciales inválidas muestran error
 *  - /dashboard sin sesión redirige a /login
 *  - /dashboard/admin sin sesión redirige a /login
 *
 * Para un E2E completo (login → upload → review → validate → export)
 * hace falta:
 *  - Seed de admin+worker+client en un test DB
 *  - Variable E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
 *  - Mock o fixture de Google Document AI (evitar llamadas reales)
 *  - PDF de prueba en fixtures/
 * Se deja pendiente hasta que esa infraestructura exista.
 */

test.describe("smoke", () => {
  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/contraseña/i)).toBeVisible();
  });

  test("invalid credentials show error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("noexiste@example.com");
    await page.getByLabel(/contraseña/i).fill("wrong-password-1234");
    await page.getByRole("button", { name: /entrar|iniciar|login/i }).click();
    await expect(
      page.getByText(/email o contraseña incorrectos|demasiados intentos|bloqueada/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("protected /dashboard redirects to /login when unauthenticated", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("protected /dashboard/admin redirects to /login when unauthenticated", async ({ page }) => {
    await page.goto("/dashboard/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("forgot password page loads", async ({ page }) => {
    await page.goto("/login/forgot-password");
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });
});
