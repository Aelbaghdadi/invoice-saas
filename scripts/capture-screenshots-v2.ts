import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const BASE = "https://invoice-saas-seven.vercel.app";
const OUT = path.join(__dirname, "..", "docs", "screenshots_v2");

const USERS = {
  admin: { email: "admin@demo.com", pass: "admin123" },
  worker: { email: "worker@demo.com", pass: "worker123" },
  client: { email: "azeddinebaghdadi2@gmail.com", pass: "25004036" },
};

async function login(page: any, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard/**", { timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function logout(page: any) {
  await page.goto(`${BASE}/api/auth/signout`, { waitUntil: "networkidle" });
  const btn = await page.$("button");
  if (btn) await btn.click();
  await page.waitForTimeout(1500);
}

async function capture(page: any, name: string) {
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`  -> ${name}.png`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // 1. Login page
  console.log("1. Capturing login...");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await capture(page, "01_login");

  // ============ ADMIN ============
  console.log("2. Capturing admin screens...");
  await login(page, USERS.admin.email, USERS.admin.pass);
  await capture(page, "02_admin_dashboard");

  // Clientes
  await page.goto(`${BASE}/dashboard/admin/clients`, { waitUntil: "networkidle" });
  await capture(page, "03_admin_clientes");

  // Gestores
  await page.goto(`${BASE}/dashboard/admin/workers`, { waitUntil: "networkidle" });
  await capture(page, "04_admin_gestores");

  // Facturas (todas)
  await page.goto(`${BASE}/dashboard/admin/invoices`, { waitUntil: "networkidle" });
  await capture(page, "05_admin_facturas");

  // Exportar
  await page.goto(`${BASE}/dashboard/admin/export`, { waitUntil: "networkidle" });
  await capture(page, "06_admin_exportar");

  // Cierres de periodo
  await page.goto(`${BASE}/dashboard/admin/closures`, { waitUntil: "networkidle" });
  await capture(page, "07_admin_cierres");

  // Auditoría
  await page.goto(`${BASE}/dashboard/admin/audit`, { waitUntil: "networkidle" });
  await capture(page, "08_admin_auditoria");

  // Ajustes
  await page.goto(`${BASE}/dashboard/admin/settings`, { waitUntil: "networkidle" });
  await capture(page, "09_admin_ajustes");

  await logout(page);

  // ============ WORKER ============
  console.log("3. Capturing worker screens...");
  await login(page, USERS.worker.email, USERS.worker.pass);
  await capture(page, "10_worker_dashboard");

  // Worker facturas
  await page.goto(`${BASE}/dashboard/worker/invoices`, { waitUntil: "networkidle" });
  await capture(page, "11_worker_facturas");

  // Worker subir facturas
  await page.goto(`${BASE}/dashboard/worker/upload`, { waitUntil: "networkidle" });
  await capture(page, "12_worker_subir");

  // Worker revision (buscar link)
  await page.goto(`${BASE}/dashboard/worker/invoices`, { waitUntil: "networkidle" });
  const reviewLink = await page.$eval('a[href*="review"]', (a: any) => a.href).catch(() => null);
  if (reviewLink) {
    await page.goto(reviewLink, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await capture(page, "13_worker_revision");
  } else {
    console.log("  (no review link found, skipping)");
  }

  await logout(page);

  // ============ CLIENT ============
  console.log("4. Capturing client screens...");
  await login(page, USERS.client.email, USERS.client.pass);
  await capture(page, "14_client_dashboard");

  // Client facturas
  await page.goto(`${BASE}/dashboard/client/invoices`, { waitUntil: "networkidle" });
  await capture(page, "15_client_facturas");

  // Client subir
  await page.goto(`${BASE}/dashboard/client/upload`, { waitUntil: "networkidle" });
  await capture(page, "16_client_subir");

  await browser.close();
  console.log("\nDone! Screenshots saved to docs/screenshots_v2/");
}

main().catch(console.error);
