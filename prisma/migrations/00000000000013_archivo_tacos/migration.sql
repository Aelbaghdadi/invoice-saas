-- CreateEnum
CREATE TYPE "PaperScanMode" AS ENUM ('PER_INVOICE', 'WHOLE_PDF');

-- CreateEnum
CREATE TYPE "PaperBoxMode" AS ENUM ('PER_CLIENT_YEAR', 'SHARED');

-- AlterTable
ALTER TABLE "AdvisoryFirm" ADD COLUMN     "paperBoxMode" "PaperBoxMode" NOT NULL DEFAULT 'PER_CLIENT_YEAR',
ADD COLUMN     "paperScanMode" "PaperScanMode" NOT NULL DEFAULT 'PER_INVOICE';

-- AlterTable
ALTER TABLE "UploadBatch" ADD COLUMN     "pdfDocumentId" TEXT,
ADD COLUMN     "pdfPageCount" INTEGER,
ADD COLUMN     "pdfSplitAt" TIMESTAMP(3),
ADD COLUMN     "pdfSplitById" TEXT,
ADD COLUMN     "routingCandidateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT,
ADD COLUMN     "wholePdf" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_pdfDocumentId_key" ON "UploadBatch"("pdfDocumentId");

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_pdfDocumentId_fkey" FOREIGN KEY ("pdfDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Guarda de la tanda (migración 13) ─────────────────────────────────────
-- Lo que fija una tanda no cambia: asesoría, cliente, candidatos, origen,
-- quién y cuándo la creó (es la llegada de sus facturas), su lote, su tipo y
-- su PDF. Su nº de ficheros no baja, y solo crece en un taco de factura a
-- factura sin anular («Completar el taco»). Un taco entero nace con su PDF
-- (se crea al subirlo), es de un cliente y de un fichero, y se divide una
-- vez. Un taco puesto a mano (ARCHIVE) siempre tiene nº. Solo un taco (con
-- nº) se guarda en una caja o se devuelve. Solo se anula un taco subido, una
-- vez y con motivo; anulado, ya no se divide, no crece ni cambia de caja (si
-- ya estaba guardado, se queda donde está). El cliente, los candidatos y el
-- PDF son de la asesoría de la tanda. Sin bypass: ningún camino de la app lo
-- necesita, y TRUNCATE (los tests) no dispara triggers de fila. Los borrados
-- (reset de la demo, cascada de un cliente) tampoco: la guarda es de INSERT y
-- UPDATE.
CREATE OR REPLACE FUNCTION upload_batch_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."wholePdf" AND (NEW."tacoNumber" IS NULL OR NEW."origin" <> 'UPLOAD'
      OR NEW."clientId" IS NULL OR NEW."fileCount" <> 1
      OR NEW."pdfDocumentId" IS NULL OR NEW."pdfPageCount" IS NULL OR NEW."pdfPageCount" < 1) THEN
    RAISE EXCEPTION 'Archivo: un taco entero es un taco subido, de un solo cliente, de un solo fichero y con su PDF (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW."wholePdf" AND num_nulls(NEW."pdfDocumentId", NEW."pdfPageCount", NEW."pdfSplitAt", NEW."pdfSplitById") <> 4 THEN
    RAISE EXCEPTION 'Archivo: solo un taco entero lleva PDF y división (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."pdfSplitAt", NEW."pdfSplitById") NOT IN (0, 2) THEN
    RAISE EXCEPTION 'Archivo: la división de un taco entero va con quién la hizo (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" = 'ARCHIVE' AND NEW."tacoNumber" IS NULL THEN
    RAISE EXCEPTION 'Archivo: el papel ubicado a mano va en un taco con nº (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tacoNumber" IS NULL AND num_nulls(NEW."boxLabel", NEW."returnedAt", NEW."filedAt", NEW."filedById") <> 4 THEN
    RAISE EXCEPTION 'Archivo: solo un taco con nº se guarda en una caja o se devuelve (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."voidedAt", NEW."voidedById", NEW."voidReason") NOT IN (0, 3)
     OR (NEW."voidedAt" IS NOT NULL AND (NEW."tacoNumber" IS NULL OR NEW."origin" <> 'UPLOAD'
         OR char_length(NEW."voidReason") NOT BETWEEN 2 AND 200)) THEN
    RAISE EXCEPTION 'Archivo: solo se anula un taco subido, una vez y con su motivo (tanda %).', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Cliente, candidatos y PDF no cambian (abajo): basta con mirarlos al crearla.
    IF (NEW."clientId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "Client" c WHERE c."id" = NEW."clientId" AND c."advisoryFirmId" = NEW."advisoryFirmId"))
       OR (NEW."clientId" IS NOT NULL AND cardinality(NEW."routingCandidateIds") > 0)
       OR EXISTS (
          SELECT 1 FROM unnest(NEW."routingCandidateIds") AS cand(id)
          WHERE NOT EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = cand.id AND c."advisoryFirmId" = NEW."advisoryFirmId"))
       OR (NEW."pdfDocumentId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "Document" d WHERE d."id" = NEW."pdfDocumentId" AND d."clientId" = NEW."clientId")) THEN
      RAISE EXCEPTION 'Archivo: el cliente, los candidatos o el PDF de la tanda no son de su asesoría (tanda %).', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."advisoryFirmId" IS DISTINCT FROM OLD."advisoryFirmId"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."routingCandidateIds" IS DISTINCT FROM OLD."routingCandidateIds"
      OR NEW."origin" IS DISTINCT FROM OLD."origin"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."wholePdf" IS DISTINCT FROM OLD."wholePdf"
      OR NEW."periodType" IS DISTINCT FROM OLD."periodType"
      OR NEW."periodMonth" IS DISTINCT FROM OLD."periodMonth"
      OR NEW."periodYear" IS DISTINCT FROM OLD."periodYear"
      OR NEW."invoiceType" IS DISTINCT FROM OLD."invoiceType"
      OR NEW."pdfDocumentId" IS DISTINCT FROM OLD."pdfDocumentId"
      OR NEW."pdfPageCount" IS DISTINCT FROM OLD."pdfPageCount" THEN
      RAISE EXCEPTION 'Archivo: una tanda no cambia de asesoría, cliente, origen, lote, tipo ni PDF (tanda %).', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."fileCount" < OLD."fileCount" OR (NEW."fileCount" > OLD."fileCount" AND (
        OLD."tacoNumber" IS NULL OR OLD."wholePdf" OR OLD."origin" <> 'UPLOAD' OR OLD."voidedAt" IS NOT NULL)) THEN
      RAISE EXCEPTION 'Archivo: el nº de ficheros de una tanda no baja, y solo crece en un taco de factura a factura sin anular (tanda %).', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."pdfSplitAt" IS NOT NULL AND (NEW."pdfSplitAt" IS DISTINCT FROM OLD."pdfSplitAt"
        OR NEW."pdfSplitById" IS DISTINCT FROM OLD."pdfSplitById") THEN
      RAISE EXCEPTION 'Archivo: un taco entero se divide una sola vez (tanda %).', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
        OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
        OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason"
        OR NEW."pdfSplitAt" IS DISTINCT FROM OLD."pdfSplitAt") THEN
      RAISE EXCEPTION 'Archivo: un taco anulado no cambia de motivo ni se divide (tanda %).', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."boxLabel" IS DISTINCT FROM OLD."boxLabel"
        OR NEW."returnedAt" IS DISTINCT FROM OLD."returnedAt"
        OR NEW."filedAt" IS DISTINCT FROM OLD."filedAt"
        OR NEW."filedById" IS DISTINCT FROM OLD."filedById") THEN
      RAISE EXCEPTION 'Archivo: un taco anulado no cambia de caja ni se devuelve (tanda %).', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS upload_batch_guard ON "UploadBatch";
CREATE TRIGGER upload_batch_guard
  BEFORE INSERT OR UPDATE ON "UploadBatch"
  FOR EACH ROW
  EXECUTE FUNCTION upload_batch_guard();

-- ─── La tanda y el taco de una fila de archivo son de su asesoría (13) ────
-- Función aparte: la 12 (archive_row_guard) no se toca. Solo al poner o
-- cambiar la tanda de llegada o el taco del papel (la fila nace sin ninguno
-- de los dos, con invoice_archive_row). Una factura del buzón es del cliente
-- «Sin clasificar» de la misma asesoría. El taco del papel tiene nº: una
-- tanda digital no es un sitio donde buscar papel, la ubicación no la
-- tendría en cuenta y la 12 ya no deja volver a vacío.
CREATE OR REPLACE FUNCTION archive_batch_firm_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF ((NEW."uploadBatchId" IS NOT NULL AND NEW."uploadBatchId" IS DISTINCT FROM OLD."uploadBatchId")
      OR (NEW."paperBatchId" IS NOT NULL AND NEW."paperBatchId" IS DISTINCT FROM OLD."paperBatchId"))
     AND EXISTS (
       SELECT 1
       FROM "Invoice" i
       JOIN "Client" c ON c."id" = i."clientId"
       JOIN "UploadBatch" b ON b."id" IN (NEW."uploadBatchId", NEW."paperBatchId")
       WHERE i."id" = NEW."invoiceId" AND b."advisoryFirmId" <> c."advisoryFirmId") THEN
    RAISE EXCEPTION 'Archivo: la tanda o el taco son de otra asesoría (factura %).', NEW."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paperBatchId" IS NOT NULL AND NEW."paperBatchId" IS DISTINCT FROM OLD."paperBatchId"
     AND EXISTS (SELECT 1 FROM "UploadBatch" b WHERE b."id" = NEW."paperBatchId" AND b."tacoNumber" IS NULL) THEN
    RAISE EXCEPTION 'Archivo: el papel solo se pone en un taco con nº (factura %).', NEW."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS archive_batch_firm_guard ON "InvoiceArchive";
CREATE TRIGGER archive_batch_firm_guard
  BEFORE UPDATE OF "uploadBatchId", "paperBatchId" ON "InvoiceArchive"
  FOR EACH ROW
  EXECUTE FUNCTION archive_batch_firm_guard();
