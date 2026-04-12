/**
 * Backfill script for hardening migration.
 *
 * Run with: npx tsx scripts/backfill-hardening.ts
 *
 * Safe to run multiple times (idempotent).
 *
 * 1. Converts ANALYZED → PENDING_REVIEW
 * 2. Creates ExportBatchItem records for EXPORTED invoices that have exportBatchId
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("=== Backfill: Hardening Migration ===\n");

  // 1. Convert ANALYZED → PENDING_REVIEW
  const analyzed = await prisma.invoice.updateMany({
    where: { status: "ANALYZED" },
    data: { status: "PENDING_REVIEW" },
  });
  console.log(`[1] ANALYZED → PENDING_REVIEW: ${analyzed.count} facturas actualizadas`);

  // 2. Create ExportBatchItem for EXPORTED invoices with exportBatchId
  const exported = await prisma.invoice.findMany({
    where: {
      status: "EXPORTED",
      exportBatchId: { not: null },
    },
    include: { client: true },
  });

  let created = 0;
  for (const inv of exported) {
    // Skip if ExportBatchItem already exists
    const existing = await prisma.exportBatchItem.findUnique({
      where: {
        exportBatchId_invoiceId: {
          exportBatchId: inv.exportBatchId!,
          invoiceId: inv.id,
        },
      },
    });
    if (existing) continue;

    await prisma.exportBatchItem.create({
      data: {
        exportBatchId: inv.exportBatchId!,
        invoiceId: inv.id,
        snapshot: JSON.stringify({
          issuerName: inv.issuerName,
          issuerCif: inv.issuerCif,
          receiverName: inv.receiverName,
          receiverCif: inv.receiverCif,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          taxBase: inv.taxBase,
          vatRate: inv.vatRate,
          vatAmount: inv.vatAmount,
          irpfRate: inv.irpfRate,
          irpfAmount: inv.irpfAmount,
          totalAmount: inv.totalAmount,
          type: inv.type,
          clientName: inv.client.name,
          clientCif: inv.client.cif,
        }),
      },
    });
    created++;
  }
  console.log(`[2] ExportBatchItem creados: ${created} (de ${exported.length} facturas EXPORTED)`);

  console.log("\n=== Backfill completado ===");
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
