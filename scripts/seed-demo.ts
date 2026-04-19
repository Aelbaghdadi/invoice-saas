/**
 * Seed de demo (simplificado) — borra datos no-admin y siembra 2 clientes
 * (uno por gestor) con 3 facturas cada uno (estados variados), cada una
 * con un PDF real generado y subido a Supabase Storage al path real
 *   invoices/{clientId}/{YYYY-MM}/{timestamp}-{filename}
 *
 * Ademas genera 3 PDFs en scripts/demo-pdfs/ (sin subir) para probar
 * el flujo de upload manualmente durante la demo.
 *
 * Uso:
 *   SEED_CONFIRM=yes npx tsx scripts/seed-demo.ts
 */

import { PrismaClient, type InvoiceStatus, type InvoiceType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import "dotenv/config";

if (process.env.SEED_CONFIRM !== "yes") {
  console.error("⛔ Safety stop. Re-ejecuta con SEED_CONFIRM=yes");
  process.exit(1);
}

const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.com";
const DEMO_PASSWORD = "Demo1234!";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SCRIPTS_DIR = __dirname;
const GEN_PY = path.join(SCRIPTS_DIR, "gen-sample-invoice.py");
const DEMO_PDF_DIR = path.join(SCRIPTS_DIR, "demo-pdfs");

type PdfConfig = {
  emisor: { nombre: string; cif: string; direccion: string; cp_ciudad: string };
  receptor: { nombre: string; cif: string; direccion: string; cp_ciudad: string };
  numero: string;
  fecha_emision: string;
  fecha_vencimiento?: string;
  periodo?: string;
  conceptos: string[][];
  base: number;
  iva_rate: number;
  iva: number;
  total: number;
  forma_pago?: string;
  color_primary?: string;
  color_accent?: string;
  logo_texto?: string;
  titulo_cabecera?: string;
  subtitulo_izq?: string;
  subtitulo_der?: string;
  datos_extra_titulo?: string;
  datos_extra?: Record<string, string>;
};

function generatePdf(cfg: PdfConfig, outPath: string) {
  const tmp = path.join(os.tmpdir(), `invoice-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg), "utf8");
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const r = spawnSync(py, [GEN_PY, tmp, outPath], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`gen-sample-invoice.py fallo: ${r.stderr || r.stdout}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin || admin.role !== "ADMIN" || !admin.advisoryFirmId) {
    throw new Error(`Admin ${ADMIN_EMAIL} no encontrado o sin advisoryFirm`);
  }
  const firmId = admin.advisoryFirmId;
  console.log(`✓ Admin ${admin.name} (firm ${firmId})`);

  // ── LIMPIEZA ───────────────────────────────────────────────────────────
  console.log("\n🧹 Limpiando datos anteriores...");
  const clientIds = (
    await prisma.client.findMany({
      where: { advisoryFirmId: firmId },
      select: { id: true },
    })
  ).map((c) => c.id);

  await prisma.auditLog.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.invoiceIssue.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.invoiceStatusHistory.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.exportBatchItem.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.invoiceExtraction.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.invoice.updateMany({ where: { clientId: { in: clientIds } }, data: { exportBatchId: null } });
  await prisma.exportBatch.deleteMany({});
  await prisma.invoice.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.document.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.periodClosure.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.accountEntry.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.workerClientAssignment.deleteMany({ where: { clientId: { in: clientIds } } });

  const linkedUserIds = (
    await prisma.client.findMany({
      where: { advisoryFirmId: firmId, userId: { not: null } },
      select: { userId: true },
    })
  ).map((c) => c.userId!);

  await prisma.client.deleteMany({ where: { advisoryFirmId: firmId } });
  await prisma.user.deleteMany({
    where: {
      OR: [{ advisoryFirmId: firmId, role: "WORKER" }, { id: { in: linkedUserIds } }],
      NOT: { id: admin.id },
    },
  });
  await prisma.passwordResetToken.deleteMany({});
  console.log("✓ Limpieza completada");

  // ── Supabase client ───────────────────────────────────────────────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  if (!supabase) {
    console.warn("⚠️  Supabase vars faltan — los PDFs no se subiran (storageKey sera placeholder).");
  } else {
    // Borrar PDFs previos del bucket para los clientIds que vamos a borrar
    try {
      for (const cid of clientIds) {
        const { data: folders } = await supabase.storage.from("invoices").list(cid);
        if (!folders) continue;
        for (const f of folders) {
          const { data: files } = await supabase.storage.from("invoices").list(`${cid}/${f.name}`);
          if (files && files.length) {
            await supabase.storage
              .from("invoices")
              .remove(files.map((x) => `${cid}/${f.name}/${x.name}`));
          }
        }
      }
      console.log("✓ PDFs previos eliminados de Storage");
    } catch (e) {
      console.warn(`⚠️  No se pudieron limpiar PDFs de Storage: ${(e as Error).message}`);
    }
  }

  // ── Usuarios y clientes ───────────────────────────────────────────────
  console.log("\n🌱 Sembrando gestores, clientes y facturas con PDFs reales...");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const ana = await prisma.user.create({
    data: { email: "ana.gestor@demo.com", name: "Ana Martínez", passwordHash, role: "WORKER", advisoryFirmId: firmId },
  });
  const pedro = await prisma.user.create({
    data: { email: "pedro.gestor@demo.com", name: "Pedro Sánchez", passwordHash, role: "WORKER", advisoryFirmId: firmId },
  });

  const userPanaderia = await prisma.user.create({
    data: { email: "cliente.panaderia@demo.com", name: "Luisa Fernández", passwordHash, role: "CLIENT" },
  });
  const userTaller = await prisma.user.create({
    data: { email: "cliente.taller@demo.com", name: "Javier Pérez", passwordHash, role: "CLIENT" },
  });

  const panaderia = await prisma.client.create({
    data: {
      name: "Panadería La Espiga S.L.", cif: "B12345674",
      email: "admin@panaderia-laespiga.es", accountingProgram: "Sage50",
      advisoryFirmId: firmId, userId: userPanaderia.id,
    },
  });
  const taller = await prisma.client.create({
    data: {
      name: "Taller Mecánico Pérez", cif: "A58818501",
      email: "contacto@tallerperez.es", accountingProgram: "A3Con",
      advisoryFirmId: firmId, userId: userTaller.id,
    },
  });

  await prisma.workerClientAssignment.createMany({
    data: [
      { workerId: ana.id, clientId: panaderia.id },
      { workerId: pedro.id, clientId: taller.id },
    ],
  });

  await prisma.accountEntry.createMany({
    data: [
      { clientId: panaderia.id, nif: "A95758389", name: "Iberdrola Clientes S.A.U.", supplierAccount: "4000001", expenseAccount: "6280001", defaultVatRate: 21 as any },
      { clientId: panaderia.id, nif: "A28015865", name: "Telefónica España S.A.", supplierAccount: "4000002", expenseAccount: "6290001", defaultVatRate: 21 as any },
      { clientId: taller.id, nif: "A78374114", name: "Repsol Comercializadora S.A.", supplierAccount: "4100001", expenseAccount: "6000001", defaultVatRate: 21 as any },
      { clientId: taller.id, nif: "A95758389", name: "Iberdrola Clientes S.A.U.", supplierAccount: "4100002", expenseAccount: "6280001", defaultVatRate: 21 as any },
    ],
  });

  // ── Definicion de facturas con PDFs reales ────────────────────────────
  type InvDef = {
    client: { id: string; name: string; cif: string };
    type: InvoiceType;
    status: InvoiceStatus;
    month: number;
    year: number;
    filename: string;
    pdf: PdfConfig;
    issues?: { type: any; description: string; field?: string }[];
    rejectionReason?: string;
  };

  const panaderiaAddr = { direccion: "Calle Mayor 42", cp_ciudad: "28013 Madrid" };
  const tallerAddr = { direccion: "Polígono Industrial Sur, Nave 7", cp_ciudad: "28914 Leganés" };

  const invoicesData: InvDef[] = [
    // ── PANADERIA (Ana) · Abril 2026 · COMPRAS ─────────────────────────
    {
      client: panaderia, type: "PURCHASE", status: "VALIDATED", month: 4, year: 2026,
      filename: "iberdrola-abril.pdf",
      pdf: {
        emisor: { nombre: "Iberdrola Clientes S.A.U.", cif: "A95758389", direccion: "Calle Tomás Redondo, 1", cp_ciudad: "28033 Madrid" },
        receptor: { nombre: panaderia.name, cif: panaderia.cif, ...panaderiaAddr },
        numero: "F-2026-04412", fecha_emision: "05/04/2026", fecha_vencimiento: "20/04/2026",
        periodo: "01/03/2026 - 31/03/2026",
        conceptos: [
          ["Suministro electrico marzo 2026", "820 kWh", "0,148 EUR/kWh", "121,36 EUR"],
          ["Termino de potencia (30 dias)", "4,6 kW", "6,196 EUR/kW", "28,50 EUR"],
          ["Alquiler equipo de medida", "1 ud.", "1,14 EUR", "1,14 EUR"],
        ],
        base: 151.00, iva_rate: 21, iva: 31.71, total: 182.71,
        logo_texto: "IBERDROLA", titulo_cabecera: "FACTURA ELECTRICA",
        subtitulo_izq: "Energia para un futuro sostenible",
        color_primary: "#1A5F3F", color_accent: "#88C540",
        forma_pago: "Domiciliacion bancaria - IBAN ES12 **** **** **** 3456",
        datos_extra_titulo: "PUNTO DE SUMINISTRO",
        datos_extra: { "CUPS:": "ES0021000001234567AB", "Tarifa:": "2.0TD", "Direccion:": "Calle Mayor 42, 28013 Madrid" },
      },
    },
    {
      client: panaderia, type: "PURCHASE", status: "PENDING_REVIEW", month: 4, year: 2026,
      filename: "telefonica-abril.pdf",
      pdf: {
        emisor: { nombre: "Telefónica España S.A.", cif: "A28015865", direccion: "Gran Vía 28", cp_ciudad: "28013 Madrid" },
        receptor: { nombre: panaderia.name, cif: panaderia.cif, ...panaderiaAddr },
        numero: "TLF-0889-2026", fecha_emision: "08/04/2026", fecha_vencimiento: "28/04/2026",
        periodo: "01/03/2026 - 31/03/2026",
        conceptos: [
          ["Fibra optica 600Mb + fijo", "1 mes", "59,90 EUR", "59,90 EUR"],
          ["Linea movil profesional", "1 mes", "25,10 EUR", "25,10 EUR"],
        ],
        base: 85.00, iva_rate: 21, iva: 17.85, total: 102.85,
        logo_texto: "TELEFONICA", titulo_cabecera: "FACTURA DE SERVICIOS",
        color_primary: "#0066A1", color_accent: "#00B8D4",
        forma_pago: "Cargo en cuenta el 28/04/2026",
      },
    },
    {
      client: panaderia, type: "PURCHASE", status: "NEEDS_ATTENTION", month: 4, year: 2026,
      filename: "ferreteria-descuadre.pdf",
      pdf: {
        emisor: { nombre: "Ferretería Industrial López", cif: "B45678919", direccion: "Av. de Castilla 14", cp_ciudad: "28850 Torrejón de Ardoz" },
        receptor: { nombre: panaderia.name, cif: panaderia.cif, ...panaderiaAddr },
        numero: "FI-0043", fecha_emision: "10/04/2026",
        conceptos: [
          ["Bandejas horno acero inox 60x40", "8 ud.", "18,00 EUR", "144,00 EUR"],
          ["Guantes termicos", "4 ud.", "9,00 EUR", "36,00 EUR"],
        ],
        base: 180.00, iva_rate: 21, iva: 37.80, total: 230.00,
        logo_texto: "FERR. IND.", titulo_cabecera: "FACTURA",
        color_primary: "#7C2D12", color_accent: "#F59E0B",
        forma_pago: "Transferencia bancaria 30 dias",
      },
      issues: [
        { type: "LOW_CONFIDENCE", description: 'Campo "Nombre emisor" con baja confianza OCR (52%).', field: "issuerName" },
        { type: "MATH_MISMATCH", description: "El total (230.00) no coincide con Base + IVA (217.80). Diferencia: 12.20€." },
      ],
    },

    // ── TALLER (Pedro) · Abril 2026 · COMPRAS ──────────────────────────
    {
      client: taller, type: "PURCHASE", status: "VALIDATED", month: 4, year: 2026,
      filename: "repsol-gasoil.pdf",
      pdf: {
        emisor: { nombre: "Repsol Comercializadora S.A.", cif: "A78374114", direccion: "Méndez Álvaro 44", cp_ciudad: "28045 Madrid" },
        receptor: { nombre: taller.name, cif: taller.cif, ...tallerAddr },
        numero: "FR-00283-26", fecha_emision: "04/04/2026", fecha_vencimiento: "04/05/2026",
        conceptos: [
          ["Gasoleo B agricola", "350 L", "1,089 EUR/L", "381,15 EUR"],
          ["Desplazamiento", "1 ud.", "18,85 EUR", "18,85 EUR"],
        ],
        base: 400.00, iva_rate: 21, iva: 84.00, total: 484.00,
        logo_texto: "REPSOL", titulo_cabecera: "FACTURA COMBUSTIBLE",
        color_primary: "#E30613", color_accent: "#FFC72C",
        forma_pago: "Giro SEPA 30 dias",
      },
    },
    {
      client: taller, type: "PURCHASE", status: "PENDING_REVIEW", month: 4, year: 2026,
      filename: "piezas-recambios.pdf",
      pdf: {
        emisor: { nombre: "Recambios Del Sur S.L.", cif: "B91234567", direccion: "Pol. Ind. La Negrilla C/ 3", cp_ciudad: "41016 Sevilla" },
        receptor: { nombre: taller.name, cif: taller.cif, ...tallerAddr },
        numero: "RS-2026-1241", fecha_emision: "11/04/2026", fecha_vencimiento: "11/05/2026",
        conceptos: [
          ["Pastillas de freno delanteras (Audi A4)", "1 jgo", "68,00 EUR", "68,00 EUR"],
          ["Filtro aceite universal", "4 ud.", "6,25 EUR", "25,00 EUR"],
          ["Aceite motor 5W30 5L", "2 ud.", "38,50 EUR", "77,00 EUR"],
        ],
        base: 170.00, iva_rate: 21, iva: 35.70, total: 205.70,
        logo_texto: "RECAMBIOS", titulo_cabecera: "FACTURA",
        color_primary: "#1E3A8A", color_accent: "#60A5FA",
        forma_pago: "Pagare a 30 dias",
      },
    },
    {
      client: taller, type: "PURCHASE", status: "NEEDS_ATTENTION", month: 4, year: 2026,
      filename: "iberdrola-taller-duplicada.pdf",
      pdf: {
        emisor: { nombre: "Iberdrola Clientes S.A.U.", cif: "A95758389", direccion: "Calle Tomás Redondo, 1", cp_ciudad: "28033 Madrid" },
        receptor: { nombre: taller.name, cif: taller.cif, ...tallerAddr },
        numero: "IBE-TAL-0981", fecha_emision: "07/04/2026",
        conceptos: [
          ["Suministro electrico nave industrial marzo 2026", "560 kWh", "0,148 EUR/kWh", "82,88 EUR"],
          ["Termino de potencia", "10 kW", "1,212 EUR/kW", "12,12 EUR"],
        ],
        base: 95.00, iva_rate: 21, iva: 19.95, total: 114.95,
        logo_texto: "IBERDROLA", titulo_cabecera: "FACTURA ELECTRICA",
        subtitulo_izq: "Energia para un futuro sostenible",
        color_primary: "#1A5F3F", color_accent: "#88C540",
        forma_pago: "Domiciliacion bancaria",
      },
      issues: [
        { type: "POSSIBLE_DUPLICATE", description: 'Posible duplicado: factura IBE-TAL-0981 de A95758389 ya registrada anteriormente.' },
      ],
    },
  ];

  // ── Generar + subir PDF + crear Invoice ──────────────────────────────
  const tmpPdfDir = path.join(os.tmpdir(), `seed-pdfs-${Date.now()}`);
  fs.mkdirSync(tmpPdfDir, { recursive: true });

  let count = 0;
  for (const d of invoicesData) {
    const localPdf = path.join(tmpPdfDir, d.filename);
    generatePdf(d.pdf, localPdf);

    const periodFolder = `${d.year}-${String(d.month).padStart(2, "0")}`;
    const storageKey = `${d.client.id}/${periodFolder}/${Date.now()}-${d.filename}`;

    let finalKey = storageKey;
    if (supabase) {
      const buf = fs.readFileSync(localPdf);
      const { error } = await supabase.storage
        .from("invoices")
        .upload(storageKey, buf, { contentType: "application/pdf", upsert: true });
      if (error) {
        console.warn(`   ⚠️  upload ${d.filename}: ${error.message}`);
        finalKey = `pending/${d.filename}`;
      }
    } else {
      finalKey = `pending/${d.filename}`;
    }

    const inv = await prisma.invoice.create({
      data: {
        clientId: d.client.id,
        type: d.type,
        status: d.status,
        periodMonth: d.month,
        periodYear: d.year,
        filename: d.filename,
        storageKey: finalKey,
        fileType: "application/pdf",
        issuerName: d.pdf.emisor.nombre,
        issuerCif: d.pdf.emisor.cif,
        receiverName: d.pdf.receptor.nombre,
        receiverCif: d.pdf.receptor.cif,
        invoiceNumber: d.pdf.numero,
        invoiceDate: parseDmy(d.pdf.fecha_emision),
        taxBase: d.pdf.base as any,
        vatRate: d.pdf.iva_rate as any,
        vatAmount: d.pdf.iva as any,
        totalAmount: d.pdf.total as any,
        rejectionReason: d.rejectionReason ?? null,
        isValid: d.status === "VALIDATED" ? true : null,
      },
    });

    if (d.issues?.length) {
      await prisma.invoiceIssue.createMany({
        data: d.issues.map((i) => ({
          invoiceId: inv.id,
          type: i.type,
          description: i.description,
          field: i.field ?? null,
        })),
      });
    }
    count++;
    console.log(`   ✓ ${d.filename}  →  ${d.client.name}  [${d.status}]`);
  }
  console.log(`✓ ${count} facturas con PDFs reales subidos`);

  // ── PDFs extra en local para upload manual en la demo ─────────────────
  console.log("\n📄 Generando PDFs extra en scripts/demo-pdfs/ para upload manual...");
  fs.mkdirSync(DEMO_PDF_DIR, { recursive: true });

  const extraPdfs: { filename: string; cfg: PdfConfig }[] = [
    {
      filename: "mercadona-compras-panaderia.pdf",
      cfg: {
        emisor: { nombre: "Mercadona S.A.", cif: "A46103834", direccion: "C/ Valencia 5", cp_ciudad: "46016 Tavernes Blanques" },
        receptor: { nombre: "Panadería La Espiga S.L.", cif: "B12345674", direccion: "Calle Mayor 42", cp_ciudad: "28013 Madrid" },
        numero: "T-4821-0415", fecha_emision: "15/04/2026",
        conceptos: [
          ["Harina trigo W320 25kg", "12 sacos", "14,80 EUR", "177,60 EUR"],
          ["Levadura fresca 500g", "20 ud.", "2,50 EUR", "50,00 EUR"],
          ["Sal marina 5kg", "4 ud.", "1,72 EUR", "6,88 EUR"],
        ],
        base: 234.50, iva_rate: 10, iva: 23.45, total: 257.95,
        logo_texto: "MERCADONA", titulo_cabecera: "TICKET FACTURA",
        color_primary: "#009739", color_accent: "#FFC72C",
        forma_pago: "Tarjeta de credito 4556 **** **** 3421",
      },
    },
    {
      filename: "endesa-luz-taller.pdf",
      cfg: {
        emisor: { nombre: "Endesa Energía S.A.U.", cif: "A81948077", direccion: "Ribera del Loira 60", cp_ciudad: "28042 Madrid" },
        receptor: { nombre: "Taller Mecánico Pérez", cif: "A58818501", direccion: "Polígono Industrial Sur, Nave 7", cp_ciudad: "28914 Leganés" },
        numero: "END-2026-8812", fecha_emision: "12/04/2026", fecha_vencimiento: "02/05/2026",
        periodo: "01/03/2026 - 31/03/2026",
        conceptos: [
          ["Suministro electrico nave industrial", "1.820 kWh", "0,155 EUR/kWh", "282,10 EUR"],
          ["Termino de potencia", "10 kW", "2,190 EUR/kW", "21,90 EUR"],
        ],
        base: 304.00, iva_rate: 21, iva: 63.84, total: 367.84,
        logo_texto: "ENDESA", titulo_cabecera: "FACTURA ELECTRICA",
        color_primary: "#002F5F", color_accent: "#00A0E1",
        forma_pago: "Domiciliacion bancaria",
        datos_extra_titulo: "PUNTO DE SUMINISTRO",
        datos_extra: { "CUPS:": "ES0031405234821XY", "Tarifa:": "3.0TD", "Potencia:": "10 kW" },
      },
    },
    {
      filename: "amazon-oficina.pdf",
      cfg: {
        emisor: { nombre: "Amazon EU S.à r.l.", cif: "B85800949", direccion: "Avda. de Burgos 118", cp_ciudad: "28050 Madrid" },
        receptor: { nombre: "Panadería La Espiga S.L.", cif: "B12345674", direccion: "Calle Mayor 42", cp_ciudad: "28013 Madrid" },
        numero: "AMZ-INV-408821", fecha_emision: "14/04/2026",
        conceptos: [
          ["Impresora multifuncion laser", "1 ud.", "189,00 EUR", "189,00 EUR"],
          ["Toner compatible HP", "2 ud.", "18,00 EUR", "36,00 EUR"],
          ["Papel A4 500 hojas (pack 5)", "1 ud.", "21,00 EUR", "21,00 EUR"],
        ],
        base: 246.00, iva_rate: 21, iva: 51.66, total: 297.66,
        logo_texto: "AMAZON", titulo_cabecera: "FACTURA",
        color_primary: "#232F3E", color_accent: "#FF9900",
        forma_pago: "Tarjeta de credito",
      },
    },
  ];

  for (const e of extraPdfs) {
    const out = path.join(DEMO_PDF_DIR, e.filename);
    generatePdf(e.cfg, out);
    console.log(`   ✓ ${e.filename}`);
  }

  console.log("\n✅ Seed completado.\n");
  console.log("Credenciales:");
  console.log(`   Admin:   ${ADMIN_EMAIL}               → (tu password actual)`);
  console.log(`   Gestor:  ana.gestor@demo.com          → ${DEMO_PASSWORD}   (cliente: Panadería)`);
  console.log(`   Gestor:  pedro.gestor@demo.com        → ${DEMO_PASSWORD}   (cliente: Taller)`);
  console.log(`   Cliente: cliente.panaderia@demo.com   → ${DEMO_PASSWORD}`);
  console.log(`   Cliente: cliente.taller@demo.com      → ${DEMO_PASSWORD}`);
  console.log(`\nPDFs extra para subir a mano: ${path.relative(process.cwd(), DEMO_PDF_DIR)}`);

  await prisma.$disconnect();
}

function parseDmy(s: string): Date {
  const [d, m, y] = s.split("/").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
