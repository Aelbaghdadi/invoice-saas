/**
 * Reseed declarativo de la demo.
 *
 * Borra todos los datos no-admin de la firma indicada y los reemplaza
 * con el dataset declarado en demoSeedData.ts. Lee los PDFs ya
 * pre-construidos de scripts/seed-pdfs/ — NO genera nada con Python en
 * runtime, asi funciona en Vercel sin problemas.
 *
 * Lo usan:
 *  - scripts/seed-demo.ts  (CLI tras una build inicial de PDFs)
 *  - app/api/admin/reset-demo/route.ts  (boton del panel admin)
 */
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import {
  SEED_INVOICE_DEFS,
  SEED_CLIENTS,
  SEED_ACCOUNT_ENTRIES,
  type SeedInvoiceDef,
} from "@/lib/demoSeedData";

const DEMO_PASSWORD = "Demo1234!";

/** Convierte "DD/MM/YYYY" a Date. */
function parseDmy(s: string): Date {
  const [d, m, y] = s.split("/").map(Number);
  return new Date(y, m - 1, d);
}

/** Resuelve la ruta de los seed PDFs. En dev cwd es la raiz; en Vercel
 *  los archivos del repo estan tambien accesibles via cwd. */
function seedPdfPath(filename: string): string {
  return path.join(process.cwd(), "scripts", "seed-pdfs", filename);
}

export type ReseedResult = {
  ok: true;
  invoicesCreated: number;
  workersCreated: number;
  clientsCreated: number;
} | {
  ok: false;
  error: string;
};

/**
 * Reseed la demo. El admin se preserva (no se borra ni se modifica
 * su password). Se borran:
 *  - Todos los usuarios WORKER y CLIENT de la firma
 *  - Todos los Client de la firma con su cascade (invoices, issues, etc)
 *  - Storage del bucket "invoices" para esos clientes
 *
 * @param firmId  ID de la AdvisoryFirm a resetear
 * @param triggeredBy  userId del admin que dispara la accion (para audit)
 */
export async function reseedDemo(
  firmId: string,
  triggeredBy: string,
): Promise<ReseedResult> {
  // ── 1. Verificar PDFs disponibles antes de tocar nada ────────────────
  for (const def of SEED_INVOICE_DEFS) {
    const p = seedPdfPath(def.filename);
    if (!fs.existsSync(p)) {
      return {
        ok: false,
        error: `Falta el PDF pre-construido: ${def.filename}. Ejecuta 'npx tsx scripts/build-seed-pdfs.ts' y commitea scripts/seed-pdfs/.`,
      };
    }
  }

  // ── 2. Limpieza ──────────────────────────────────────────────────────
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
  await prisma.invoiceVatLine.deleteMany({ where: { invoice: { clientId: { in: clientIds } } } });
  await prisma.invoice.updateMany({ where: { clientId: { in: clientIds } }, data: { exportBatchId: null } });
  await prisma.exportBatch.deleteMany({ where: { userId: triggeredBy } });
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
      NOT: { id: triggeredBy }, // no borrar nunca el admin que dispara
    },
  });
  await prisma.passwordResetToken.deleteMany({});

  // ── 3. Limpiar storage de los clientIds antiguos ─────────────────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

  if (supabase && clientIds.length > 0) {
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
    } catch {
      // Si falla la limpieza de storage no abortamos: los archivos
      // huerfanos no rompen nada y tampoco hay forma de recuperarlos.
    }
  }

  // ── 4. Sembrar usuarios + clientes ───────────────────────────────────
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
    data: { ...SEED_CLIENTS.panaderia, advisoryFirmId: firmId, userId: userPanaderia.id },
  });
  const taller = await prisma.client.create({
    data: { ...SEED_CLIENTS.taller, advisoryFirmId: firmId, userId: userTaller.id },
  });

  await prisma.workerClientAssignment.createMany({
    data: [
      { workerId: ana.id, clientId: panaderia.id },
      { workerId: pedro.id, clientId: taller.id },
    ],
  });

  await prisma.accountEntry.createMany({
    data: [
      ...SEED_ACCOUNT_ENTRIES.panaderia.map((e) => ({
        clientId: panaderia.id,
        nif: e.nif,
        name: e.name,
        supplierAccount: e.supplierAccount,
        expenseAccount: e.expenseAccount,
        defaultVatRate: e.defaultVatRate as unknown as never,
      })),
      ...SEED_ACCOUNT_ENTRIES.taller.map((e) => ({
        clientId: taller.id,
        nif: e.nif,
        name: e.name,
        supplierAccount: e.supplierAccount,
        expenseAccount: e.expenseAccount,
        defaultVatRate: e.defaultVatRate as unknown as never,
      })),
    ],
  });

  // ── 5. Sembrar facturas con PDFs ─────────────────────────────────────
  const clientByKey: Record<"panaderia" | "taller", { id: string; name: string; cif: string }> = {
    panaderia: { id: panaderia.id, name: panaderia.name, cif: panaderia.cif },
    taller:    { id: taller.id,    name: taller.name,    cif: taller.cif },
  };

  let invoicesCreated = 0;
  for (const def of SEED_INVOICE_DEFS) {
    const c = clientByKey[def.client];
    const buf = fs.readFileSync(seedPdfPath(def.filename));

    const periodFolder = `${def.year}-${String(def.month).padStart(2, "0")}`;
    const storageKey = `${c.id}/${periodFolder}/${Date.now()}-${def.filename}`;

    let finalKey = storageKey;
    if (supabase) {
      const { error } = await supabase.storage
        .from("invoices")
        .upload(storageKey, buf, { contentType: "application/pdf", upsert: true });
      if (error) finalKey = `pending/${def.filename}`;
    } else {
      finalKey = `pending/${def.filename}`;
    }

    const inv = await prisma.invoice.create({
      data: {
        clientId: c.id,
        type: def.type,
        status: def.status,
        periodMonth: def.month,
        periodYear: def.year,
        filename: def.filename,
        storageKey: finalKey,
        fileType: "application/pdf",
        issuerName:    def.pdf.emisor.nombre,
        issuerCif:     def.pdf.emisor.cif,
        receiverName:  def.pdf.receptor.nombre,
        receiverCif:   def.pdf.receptor.cif,
        invoiceNumber: def.pdf.numero,
        invoiceDate:   parseDmy(def.pdf.fecha_emision),
        taxBase:       def.pdf.base as unknown as never,
        vatRate:       def.pdf.iva_rate as unknown as never,
        vatAmount:     def.pdf.iva as unknown as never,
        totalAmount:   def.pdf.total as unknown as never,
        isValid: def.status === "VALIDATED" ? true : null,
      },
    });

    // Una linea de IVA por factura sembrada (todas son single-rate).
    await prisma.invoiceVatLine.create({
      data: {
        invoiceId: inv.id,
        position: 0,
        taxBase:   def.pdf.base as unknown as never,
        vatRate:   def.pdf.iva_rate as unknown as never,
        vatAmount: def.pdf.iva as unknown as never,
      },
    });

    if (def.issues?.length) {
      await prisma.invoiceIssue.createMany({
        data: def.issues.map((i) => ({
          invoiceId: inv.id,
          type: i.type,
          description: i.description,
          field: i.field ?? null,
        })),
      });
    }
    invoicesCreated++;
  }

  return {
    ok: true,
    invoicesCreated,
    workersCreated: 2,
    clientsCreated: 2,
  };
}
