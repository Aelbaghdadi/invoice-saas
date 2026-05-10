import { Client } from "pg";

const db = new Client({ connectionString: process.env.DATABASE_URL });

await db.connect();
try {
  await db.query("BEGIN");
  await db.query('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_no_delete');

  const r1 = await db.query('DELETE FROM "AuditLog" WHERE "invoiceId" IS NOT NULL');
  const r2 = await db.query('DELETE FROM "InvoiceIssue"');
  const r3 = await db.query('DELETE FROM "InvoiceStatusHistory"');
  await db.query('DELETE FROM "ExportBatchItem"');
  await db.query('DELETE FROM "InvoiceExtraction"');
  await db.query('DELETE FROM "InvoiceVatLine"');
  await db.query('UPDATE "Invoice" SET "exportBatchId" = NULL');
  await db.query('DELETE FROM "ExportBatch"');
  const r4 = await db.query('DELETE FROM "Invoice"');

  await db.query('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_delete');
  await db.query("COMMIT");

  console.log(`✓ Eliminadas ${r4.rowCount} facturas, ${r1.rowCount} audit logs, ${r2.rowCount} issues, ${r3.rowCount} historial`);
} catch (e) {
  await db.query('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_delete').catch(() => {});
  await db.query("ROLLBACK");
  console.error("Error:", e.message);
  process.exit(1);
} finally {
  await db.end();
}
