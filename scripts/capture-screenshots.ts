import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const BASE = "http://localhost:3000";
const OUT = path.join(__dirname, "..", "docs", "screenshots");

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
  await page.waitForURL("**/dashboard/**", { timeout: 10000 });
  await page.waitForTimeout(1500);
}

async function logout(page: any) {
  await page.goto(`${BASE}/api/auth/signout`, { waitUntil: "networkidle" });
  await page.click("button");
  await page.waitForTimeout(1000);
}

async function capture(page: any, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`  -> ${name}.png`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // 1. Login page
  console.log("Capturing login...");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await capture(page, "01_login");

  // 2. Admin screens
  console.log("Capturing admin screens...");
  await login(page, USERS.admin.email, USERS.admin.pass);
  await capture(page, "02_admin_dashboard");

  await page.goto(`${BASE}/dashboard/admin/clients`, { waitUntil: "networkidle" });
  await capture(page, "03_admin_clientes");

  await page.goto(`${BASE}/dashboard/admin/invoices`, { waitUntil: "networkidle" });
  await capture(page, "04_admin_facturas");

  await page.goto(`${BASE}/dashboard/admin/export`, { waitUntil: "networkidle" });
  await capture(page, "05_admin_exportar");

  await page.goto(`${BASE}/dashboard/admin/audit`, { waitUntil: "networkidle" });
  await capture(page, "06_admin_auditoria");

  await page.goto(`${BASE}/dashboard/admin/settings`, { waitUntil: "networkidle" });
  await capture(page, "07_admin_ajustes");

  await page.goto(`${BASE}/dashboard/admin/batch`, { waitUntil: "networkidle" });
  await capture(page, "08_admin_lotes");

  await logout(page);

  // 3. Worker screens
  console.log("Capturing worker screens...");
  await login(page, USERS.worker.email, USERS.worker.pass);
  await capture(page, "09_worker_dashboard");

  await page.goto(`${BASE}/dashboard/worker/invoices`, { waitUntil: "networkidle" });
  await capture(page, "10_worker_facturas");

  // Find a review link
  const reviewLink = await page.$eval('a[href*="review"]', (a: any) => a.href).catch(() => null);
  if (reviewLink) {
    await page.goto(reviewLink, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await capture(page, "11_worker_revision");
  }

  await logout(page);

  // 4. Client screens
  console.log("Capturing client screens...");
  await login(page, USERS.client.email, USERS.client.pass);
  await capture(page, "12_client_dashboard");

  await page.goto(`${BASE}/dashboard/client/upload`, { waitUntil: "networkidle" });
  await capture(page, "13_client_subir");

  await page.goto(`${BASE}/dashboard/client/invoices`, { waitUntil: "networkidle" });
  await capture(page, "14_client_facturas");

  await browser.close();
  console.log("Done! Screenshots saved to docs/screenshots/");
}

main().catch(console.error);
