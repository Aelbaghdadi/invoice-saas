/**
 * Genera los 6 PDFs que usa el seed de demo y los deja en
 * scripts/seed-pdfs/ para commitearlos al repo. Los ejecuta una vez
 * cualquier desarrollador localmente (necesita Python + reportlab) y
 * a partir de ahi el reset de demo en Vercel los lee de disco.
 *
 * Uso:
 *   npx tsx scripts/build-seed-pdfs.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SEED_INVOICE_DEFS } from "@/lib/demoSeedData";

const OUT_DIR = path.join(__dirname, "seed-pdfs");
const GEN_PY = path.join(__dirname, "gen-sample-invoice.py");

function generatePdf(cfg: unknown, outPath: string) {
  const tmp = path.join(os.tmpdir(), `seed-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg), "utf8");
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const r = spawnSync(py, [GEN_PY, tmp, outPath], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Python fallo: ${r.stderr || r.stdout}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let n = 0;
  for (const def of SEED_INVOICE_DEFS) {
    const out = path.join(OUT_DIR, def.filename);
    generatePdf(def.pdf, out);
    console.log(`  ✓ ${def.filename}`);
    n++;
  }
  console.log(`\nOK ${n} PDFs en ${OUT_DIR}`);
  console.log(`Ahora committea scripts/seed-pdfs/ al repo.`);
}

main();
