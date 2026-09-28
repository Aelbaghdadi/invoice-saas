import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseTestDatabaseUrl } from "../shared/testDatabase";
import { truncateTestDatabase } from "../shared/testDatabaseReset";
import bcrypt from "bcryptjs";

/**
 * Cambios sin guardar y el historial del navegador (F-047): el centinela que
 * protege Atras no deja entradas repetidas ni muertas.
 *
 * Siembra su propia asesoria y para eso VACIA la base de datos de
 * E2E_DATABASE_URL. Pasa la misma guarda que la integracion: nombre de
 * pruebas, la conexion llega a esa base de datos y lleva el marcador del
 * harness (`_facturocr_test.marker`, lo crea el globalSetup de integracion
 * sobre una base de datos vacia). Con E2E_DATABASE_URL, playwright.config
 * arranca el servidor contra esa misma base de datos. Sin ella, se salta.
 *   E2E_DATABASE_URL=postgresql://…/facturocr_test npx playwright test unsavedHistory
 */
const E2E_DB = process.env.E2E_DATABASE_URL;
test.skip(!E2E_DB, "Necesita E2E_DATABASE_URL");
test.describe.configure({ mode: "serial" });

const PASSWORD = "Prueba1234!";
const IDS = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"];

test.beforeAll(async () => {
  const parsed = parseTestDatabaseUrl(E2E_DB, "E2E_DATABASE_URL");
  if (!parsed.ok) throw new Error(`[e2e] ${parsed.problem}`);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: parsed.db.url }) });
  try {
    await truncateTestDatabase(db, parsed.db, "e2e");
    await db.advisoryFirm.create({ data: { id: "firm1", name: "Asesoría Prueba", cif: "A00000001" } });
    await db.user.create({ data: { id: "admin1", username: "admin", email: "admin@prueba.es", passwordHash: await bcrypt.hash(PASSWORD, 10), name: "Admin", role: "ADMIN", advisoryFirmId: "firm1" } });
    await db.client.create({ data: { id: "client1", name: "Cliente Prueba SL", cif: "B00000002", advisoryFirmId: "firm1" } });
    for (const id of IDS) {
      await db.invoice.create({
        data: {
          id, filename: `${id}.pdf`, storageKey: "k-pdf", fileType: "application/pdf", type: "PURCHASE",
          periodMonth: 9, periodYear: 2026, clientId: "client1", status: "PENDING_REVIEW",
          invoiceNumber: `F-${id}`, invoiceDate: new Date("2026-09-10"),
          issuerName: "Proveedor SL", issuerCif: "B12345674",
          // h5 sin receptor: al guardar, el servidor pone el del cliente.
          receiverName: id === "h5" ? null : "Cliente Prueba SL", receiverCif: id === "h5" ? null : "B00000002",
          taxBase: 100, vatRate: 21, vatAmount: 21, totalAmount: 121,
          supplierAccount: "40000001", expenseAccount: "60000001", operationType: "INTERIOR",
          vatLines: { create: [{ position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 }] },
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
});

/** El historial de la pestaña como rutas cortas, con la actual entre asteriscos. */
type NavigationEntries = { entries(): { url: string | null }[]; currentEntry: { index: number } | null };
async function historyOf(page: Page) {
  const { urls, index } = await page.evaluate(() => {
    const nav = (window as unknown as { navigation: NavigationEntries }).navigation;
    return { urls: nav.entries().map((e) => new URL(e.url ?? "").pathname), index: nav.currentEntry?.index ?? -1 };
  });
  return urls.map((u, i) => (i === index ? `*${u}*` : u));
}

const P = "/dashboard/worker/invoices";
const review = (id: string) => `/dashboard/worker/review/${id}`;

/** Listado (P) → factura (A), con cambios en el numero. */
async function openAndEdit(page: Page, id: string) {
  await page.goto("/login");
  await page.getByLabel(/usuario/i).fill("admin");
  await page.getByLabel(/contraseña/i).fill(PASSWORD);
  await Promise.all([page.waitForURL(/dashboard/), page.getByRole("button", { name: /acceder/i }).click()]);
  await page.goto(P);
  await page.goto(review(id));
  // Tras hidratar: antes, lo tecleado no pasa por los listeners de React.
  await page.waitForLoadState("networkidle");
  await page.locator("#invoiceNumber").fill(`${id}-CAMBIADO`);
  // El centinela (la misma URL repetida) se pone tras el render.
  await expect.poll(async () => (await historyOf(page)).slice(-2)).toEqual([review(id), `*${review(id)}*`]);
}
const back = (page: Page) => page.evaluate(() => history.back());
const forward = (page: Page) => page.evaluate(() => history.forward());

test("editar → Atrás → Descartar: sale, y Adelante/Atrás siguen funcionando", async ({ page }) => {
  await openAndEdit(page, "h1");
  const dialog = page.getByRole("alertdialog");
  await back(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Descartar" }).click();
  await expect(page).toHaveURL(new RegExp(`${P}$`));
  await forward(page);
  await expect(page).toHaveURL(new RegExp(`${review("h1")}$`));
  await expect(dialog).toHaveCount(0);
  await back(page);
  await expect(page).toHaveURL(new RegExp(`${P}$`));
});

test("editar → validar con Ctrl+Enter → Atrás: la factura anterior en un paso", async ({ page }) => {
  await openAndEdit(page, "h2");
  await page.locator("#invoiceNumber").press("Control+Enter");
  await page.waitForURL((u) => u.pathname.startsWith("/dashboard/worker/review/") && !u.pathname.endsWith("/h2"));
  // replace: la siguiente sustituye al centinela, sin la entrada repetida
  // (con push quedaba [A, A, siguiente]).
  expect((await historyOf(page)).slice(-3)).toEqual([P, review("h2"), expect.stringMatching(/^\*\/dashboard\/worker\/review\//)]);
  await back(page);
  await expect(page).toHaveURL(new RegExp(`${review("h2")}$`));
  await back(page);
  await expect(page).toHaveURL(new RegExp(`${P}$`));
});

test("editar → enlace → Descartar: [P, A, X]", async ({ page }) => {
  await openAndEdit(page, "h3");
  const dialog = page.getByRole("alertdialog");
  const link = page.locator('nav a[href^="/dashboard"]').filter({ hasNot: page.locator(`[href="${P}"]`) }).first();
  const target = await link.getAttribute("href");
  await link.click();
  await dialog.getByRole("button", { name: "Descartar" }).click();
  await page.waitForURL((u) => u.pathname === target);
  expect((await historyOf(page)).slice(-3)).toEqual([P, review("h3"), `*${target}*`]);
});

test("editar → Atrás → Cancelar → Atrás: vuelve a preguntar (también con el aviso abierto)", async ({ page }) => {
  await openAndEdit(page, "h4");
  const dialog = page.getByRole("alertdialog");
  await back(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect.poll(async () => (await historyOf(page)).slice(-2)).toEqual([review("h4"), `*${review("h4")}*`]);
  await back(page);
  await expect(dialog).toBeVisible();
  // Atras con el aviso abierto no sale de la factura.
  await back(page);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(new RegExp(`${review("h4")}$`));
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Descartar" }).click();
  await expect(page).toHaveURL(new RegExp(`${P}$`));
});

test("guardar una factura sin receptor: tras el refresco no quedan cambios sin guardar", async ({ page }) => {
  await openAndEdit(page, "h5");
  await page.getByRole("button", { name: "Guardar sin validar" }).click();
  await expect(page.getByText("Cambios guardados")).toBeVisible();
  // El refresco trae el receptor que ha puesto el servidor.
  await expect(page.locator("#receiverName")).toHaveValue("Cliente Prueba SL");
  const link = page.locator('nav a[href^="/dashboard"]').filter({ hasNot: page.locator(`[href="${P}"]`) }).first();
  const target = await link.getAttribute("href");
  await link.click();
  await page.waitForURL((u) => u.pathname === target);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("guardar y salir enseguida: espera al guardado y no pregunta", async ({ page }) => {
  await openAndEdit(page, "h6");
  const link = page.locator('nav a[href^="/dashboard"]').filter({ hasNot: page.locator(`[href="${P}"]`) }).first();
  const target = await link.getAttribute("href");
  // El guardado tarda: el enlace se pulsa con el guardado en vuelo.
  await page.route(`**${review("h6")}`, async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Guardar sin validar" }).click();
  await link.click();
  await page.waitForURL((u) => u.pathname === target);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("lo tecleado mientras se guarda sigue contando como cambio", async ({ page }) => {
  await openAndEdit(page, "h7");
  await page.route(`**${review("h7")}`, async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Guardar sin validar" }).click();
  // Con el guardado en vuelo: un campo de estado que ya no va en el envío.
  await page.locator("#totalAmount").fill("999");
  await expect(page.getByText("Cambios guardados")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.locator('nav a[href^="/dashboard"]').filter({ hasNot: page.locator(`[href="${P}"]`) }).first().click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${review("h7")}$`));
});
