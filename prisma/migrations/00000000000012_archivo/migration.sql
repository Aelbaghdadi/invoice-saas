-- CreateEnum
CREATE TYPE "OriginalMedium" AS ENUM ('ELECTRONIC', 'PAPER');

-- CreateEnum
CREATE TYPE "OriginalMediumSource" AS ENUM ('AUTO', 'TACO', 'MANUAL');

-- CreateEnum
CREATE TYPE "RetentionHoldReason" AS ENUM ('FIXED_ASSET', 'TAX_CREDITS', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "UploadBatchOrigin" AS ENUM ('UPLOAD', 'ARCHIVE');

-- AlterTable
ALTER TABLE "AdvisoryFirm" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "InvoiceArchive" (
    "invoiceId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadBatchId" TEXT,
    "uploadPosition" INTEGER,
    "splitPart" INTEGER NOT NULL DEFAULT 0,
    "paperBatchId" TEXT,
    "paperHeldByClient" BOOLEAN NOT NULL DEFAULT false,
    "originalMedium" "OriginalMedium",
    "originalMediumSource" "OriginalMediumSource",
    "originalMediumReason" TEXT,
    "pdfProducer" TEXT,
    "originalDocumentId" TEXT,
    "registerSeriesId" TEXT,
    "registerNumber" INTEGER,
    "registeredAt" TIMESTAMP(3),
    "retentionHold" BOOLEAN NOT NULL DEFAULT false,
    "retentionHoldReason" "RetentionHoldReason",
    "retentionHoldNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceArchive_pkey" PRIMARY KEY ("invoiceId")
);

-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" TEXT NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,
    "clientId" TEXT,
    "origin" "UploadBatchOrigin" NOT NULL DEFAULT 'UPLOAD',
    "createdById" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "periodType" "PeriodType",
    "periodMonth" INTEGER,
    "periodYear" INTEGER NOT NULL,
    "invoiceType" TEXT,
    "tacoNumber" INTEGER,
    "boxLabel" TEXT,
    "returnedAt" TIMESTAMP(3),
    "filedAt" TIMESTAMP(3),
    "filedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRegisterSeries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "InvoiceType" NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRegisterSeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceArchive_paperBatchId_idx" ON "InvoiceArchive"("paperBatchId");

-- CreateIndex
CREATE INDEX "InvoiceArchive_originalDocumentId_idx" ON "InvoiceArchive"("originalDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceArchive_registerSeriesId_registerNumber_key" ON "InvoiceArchive"("registerSeriesId", "registerNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceArchive_uploadBatchId_uploadPosition_splitPart_key" ON "InvoiceArchive"("uploadBatchId", "uploadPosition", "splitPart");

-- CreateIndex
CREATE INDEX "UploadBatch_advisoryFirmId_filedAt_idx" ON "UploadBatch"("advisoryFirmId", "filedAt");

-- CreateIndex
CREATE INDEX "UploadBatch_advisoryFirmId_boxLabel_idx" ON "UploadBatch"("advisoryFirmId", "boxLabel");

-- CreateIndex
CREATE INDEX "UploadBatch_clientId_createdAt_idx" ON "UploadBatch"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadBatch_advisoryFirmId_tacoNumber_key" ON "UploadBatch"("advisoryFirmId", "tacoNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRegisterSeries_clientId_type_year_key" ON "InvoiceRegisterSeries"("clientId", "type", "year");

-- CreateIndex
CREATE INDEX "Invoice_splitFromId_idx" ON "Invoice"("splitFromId");

-- AddForeignKey
ALTER TABLE "InvoiceArchive" ADD CONSTRAINT "InvoiceArchive_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArchive" ADD CONSTRAINT "InvoiceArchive_uploadBatchId_fkey" FOREIGN KEY ("uploadBatchId") REFERENCES "UploadBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArchive" ADD CONSTRAINT "InvoiceArchive_paperBatchId_fkey" FOREIGN KEY ("paperBatchId") REFERENCES "UploadBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArchive" ADD CONSTRAINT "InvoiceArchive_originalDocumentId_fkey" FOREIGN KEY ("originalDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceArchive" ADD CONSTRAINT "InvoiceArchive_registerSeriesId_fkey" FOREIGN KEY ("registerSeriesId") REFERENCES "InvoiceRegisterSeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_advisoryFirmId_fkey" FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRegisterSeries" ADD CONSTRAINT "InvoiceRegisterSeries_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Relleno de lo que ya existía ──────────────────────────────────────────
-- Idempotente: solo toca lo que falta, así que se puede volver a ejecutar tal
-- cual (por ejemplo, cuando el contenedor viejo ya está parado tras el
-- despliegue) y una segunda pasada no cambia nada. Cada sentencia acaba en «;»
-- al final de la línea y no lleva otro «;» dentro: archiveBackfill.test.ts la
-- parte así. Las fechas en crudo van en UTC, como las escribe Prisma.

-- archivo:backfill:inicio

-- a) Una fila de archivo por cada factura. La llegada es la creación de la factura.
INSERT INTO "InvoiceArchive" ("invoiceId", "receivedAt", "createdAt", "updatedAt")
SELECT i."id", i."createdAt", now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Invoice" i
ON CONFLICT ("invoiceId") DO NOTHING;

-- b) Partes de una división (también las de una parte que se volvió a dividir):
--    la llegada de su raíz…
WITH RECURSIVE fam AS (
  SELECT "id", "id" AS root FROM "Invoice" WHERE "splitFromId" IS NULL
  UNION ALL
  SELECT c."id", fam.root FROM "Invoice" c JOIN fam ON c."splitFromId" = fam."id"
)
UPDATE "InvoiceArchive" a
SET "receivedAt" = r."receivedAt", "updatedAt" = now() AT TIME ZONE 'UTC'
FROM fam JOIN "InvoiceArchive" r ON r."invoiceId" = fam.root
WHERE a."invoiceId" = fam."id" AND fam."id" <> fam.root
  AND a."receivedAt" IS DISTINCT FROM r."receivedAt";

--    …y splitPart 1..n numerado por la raíz, por createdAt e id. Las que ya
--    tienen parte se quedan como están, y las nuevas siguen desde la mayor.
WITH RECURSIVE fam AS (
  SELECT "id", "id" AS root FROM "Invoice" WHERE "splitFromId" IS NULL
  UNION ALL
  SELECT c."id", fam.root FROM "Invoice" c JOIN fam ON c."splitFromId" = fam."id"
), parts AS (
  SELECT fam."id", fam.root, i."createdAt", a."splitPart"
  FROM fam
  JOIN "Invoice" i ON i."id" = fam."id"
  JOIN "InvoiceArchive" a ON a."invoiceId" = fam."id"
  WHERE fam."id" <> fam.root
), numbered AS (
  SELECT p."id",
    MAX(p."splitPart") OVER (PARTITION BY p.root)
      + ROW_NUMBER() OVER (PARTITION BY p.root, p."splitPart" = 0 ORDER BY p."createdAt", p."id") AS n,
    p."splitPart"
  FROM parts p
)
UPDATE "InvoiceArchive" a
SET "splitPart" = numbered.n, "updatedAt" = now() AT TIME ZONE 'UTC'
FROM numbered
WHERE a."invoiceId" = numbered."id" AND numbered."splitPart" = 0;

-- c) Electrónico o papel, solo donde nadie lo ha decidido aún. Un XML es el
--    original electrónico. Una imagen o un PDF quedan «Por confirmar»: una
--    imagen puede ser la foto de un papel o lo que mandó el proveedor, y los PDF
--    los repasa /api/cron/archivo-detectar (capa de texto y productor), que solo
--    toca las filas con motivo backfill_pending.
UPDATE "InvoiceArchive" a
SET "originalMedium" = CASE WHEN i."fileType" ILIKE '%xml%' THEN 'ELECTRONIC'::"OriginalMedium" END,
    "originalMediumSource" = 'AUTO',
    "originalMediumReason" = CASE
      WHEN i."fileType" ILIKE '%xml%' THEN 'xml'
      WHEN i."fileType" ILIKE 'image/%' THEN 'image_unconfirmed'
      ELSE 'backfill_pending' END,
    "updatedAt" = now() AT TIME ZONE 'UTC'
FROM "Invoice" i
WHERE a."invoiceId" = i."id" AND i."splitFromId" IS NULL
  AND a."originalMediumSource" IS NULL;

--    Las partes de una división, el medio y el origen de su raíz.
WITH RECURSIVE fam AS (
  SELECT "id", "id" AS root FROM "Invoice" WHERE "splitFromId" IS NULL
  UNION ALL
  SELECT c."id", fam.root FROM "Invoice" c JOIN fam ON c."splitFromId" = fam."id"
)
UPDATE "InvoiceArchive" a
SET "originalMedium" = r."originalMedium",
    "originalMediumSource" = r."originalMediumSource",
    "originalMediumReason" = 'split',
    "pdfProducer" = r."pdfProducer",
    "updatedAt" = now() AT TIME ZONE 'UTC'
FROM fam JOIN "InvoiceArchive" r ON r."invoiceId" = fam.root
WHERE a."invoiceId" = fam."id" AND fam."id" <> fam.root
  AND a."originalMediumSource" IS NULL AND r."originalMediumSource" IS NOT NULL;

-- d) Nº de registro de lo ya exportado: VALIDATED o EXPORTED con algún
--    ExportBatchItem y sin número. Serie por cliente, tipo y año natural del
--    periodo de deducción (el contable o, si no hay, el del lote).
INSERT INTO "InvoiceRegisterSeries" ("id", "clientId", "type", "year", "lastNumber", "updatedAt")
SELECT gen_random_uuid()::text, s."clientId", s."type", s.y, 0, now() AT TIME ZONE 'UTC'
FROM (
  SELECT DISTINCT i."clientId", i."type", COALESCE(i."accountingPeriodYear", i."periodYear") AS y
  FROM "Invoice" i
  JOIN "InvoiceArchive" a ON a."invoiceId" = i."id"
  WHERE i."status" IN ('VALIDATED', 'EXPORTED') AND a."registerNumber" IS NULL
    AND EXISTS (SELECT 1 FROM "ExportBatchItem" e WHERE e."invoiceId" = i."id")
) s
ON CONFLICT ("clientId", "type", "year") DO NOTHING;

--    Dentro de cada serie, en el orden en que se habrían numerado al exportar:
--    primero el lote en el que la factura salió por primera vez, por su fecha
--    (ExportBatch.createdAt, que es también registeredAt: la de los items no
--    vale, porque se escriben después que el lote y los que creó
--    scripts/backfill-hardening.ts llevan la fecha del script). Dentro de cada
--    lote, el orden del archivo (compareArchiveOrder de src/lib/archiveRules.ts):
--    mes del periodo; en las emitidas, fecha y nº de factura en orden natural
--    (el corte de parseInvoiceNumber de src/lib/invoiceNumbering.ts, «F-2» antes
--    que «F-10»; detrás las que no tienen dígitos, sin mirar mayúsculas ni
--    espacios, y al final las vacías) y llegada; en las recibidas, llegada,
--    posición, parte y alta; y el id. Los textos se comparan por código
--    (COLLATE "C"), como en JS. Sigue desde el mayor número de la serie.
WITH s AS (
  SELECT i."id" AS "invoiceId", i."clientId", i."type",
    COALESCE(i."accountingPeriodYear", i."periodYear") AS y,
    COALESCE(i."accountingPeriodMonth", i."periodMonth") AS m,
    e."exportedAt", a."receivedAt", a."uploadPosition", a."splitPart", i."createdAt", i."invoiceDate",
    regexp_replace(COALESCE(i."invoiceNumber", ''), '^\s+|\s+$', '', 'g') AS num
  FROM "Invoice" i
  JOIN "InvoiceArchive" a ON a."invoiceId" = i."id"
  JOIN (
    SELECT bi."invoiceId", MIN(b."createdAt") AS "exportedAt"
    FROM "ExportBatchItem" bi
    JOIN "ExportBatch" b ON b."id" = bi."exportBatchId"
    GROUP BY bi."invoiceId"
  ) e ON e."invoiceId" = i."id"
  WHERE i."status" IN ('VALIDATED', 'EXPORTED') AND a."registerNumber" IS NULL
), top AS (
  SELECT "registerSeriesId", MAX("registerNumber") AS n
  FROM "InvoiceArchive" WHERE "registerSeriesId" IS NOT NULL
  GROUP BY "registerSeriesId"
), numbered AS (
  SELECT s."invoiceId", rs."id" AS "seriesId", s."exportedAt",
    GREATEST(rs."lastNumber", COALESCE(top.n, 0)) + ROW_NUMBER() OVER (
      PARTITION BY rs."id"
      ORDER BY s."exportedAt", s.m,
        CASE WHEN s."type" = 'SALE' THEN s."invoiceDate" END,
        CASE WHEN s."type" = 'SALE' THEN CASE WHEN p.parts IS NOT NULL THEN 0 WHEN s.num <> '' THEN 1 ELSE 2 END END,
        CASE WHEN s."type" = 'SALE' THEN upper(regexp_replace(COALESCE(p.parts[1], s.num), '\s', '', 'g')) COLLATE "C" END,
        CASE WHEN s."type" = 'SALE' THEN p.parts[2]::numeric END,
        CASE WHEN s."type" = 'SALE' THEN upper(regexp_replace(p.parts[3], '\s', '', 'g')) COLLATE "C" END,
        CASE WHEN s."type" = 'SALE' THEN s.num COLLATE "C" END,
        s."receivedAt",
        CASE WHEN s."type" = 'PURCHASE' THEN s."uploadPosition" END,
        CASE WHEN s."type" = 'PURCHASE' THEN s."splitPart" END,
        CASE WHEN s."type" = 'PURCHASE' THEN s."createdAt" END,
        s."invoiceId" COLLATE "C"
    ) AS n
  FROM s
  JOIN "InvoiceRegisterSeries" rs ON rs."clientId" = s."clientId" AND rs."type" = s."type" AND rs."year" = s.y
  LEFT JOIN top ON top."registerSeriesId" = rs."id"
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      regexp_match(s.num, '^(.*?)(\d+)(\s*[-/.]\s*(?:19|20)\d{2})$'),
      regexp_match(s.num, '^(.*?)(\d+)(\D*)$')
    ) AS parts
  ) p
)
UPDATE "InvoiceArchive" a
SET "registerSeriesId" = numbered."seriesId",
    "registerNumber" = numbered.n,
    "registeredAt" = numbered."exportedAt",
    "updatedAt" = now() AT TIME ZONE 'UTC'
FROM numbered
WHERE a."invoiceId" = numbered."invoiceId" AND a."registerNumber" IS NULL;

--    Cada contador, en el mayor número de su serie (solo sube).
UPDATE "InvoiceRegisterSeries" rs
SET "lastNumber" = top.n, "updatedAt" = now() AT TIME ZONE 'UTC'
FROM (
  SELECT "registerSeriesId", MAX("registerNumber") AS n
  FROM "InvoiceArchive" WHERE "registerSeriesId" IS NOT NULL
  GROUP BY "registerSeriesId"
) top
WHERE rs."id" = top."registerSeriesId" AND rs."lastNumber" < top.n;

-- archivo:backfill:fin

-- ─── Funciones y triggers del archivo ──────────────────────────────────────
-- Todos lanzan check_violation con un mensaje en castellano. Las guardas de
-- UPDATE no tienen bypass: ningún camino de la app las necesita. TRUNCATE (el
-- harness de tests) no dispara triggers de fila. Reversión de emergencia, a
-- mano y con la copia hecha: DROP TRIGGER de los diez (las tablas y columnas
-- se quedan; el código viejo las ignora).

-- La fila de archivo de cada factura nueva, también con createMany. Quien crea
-- la factura la rellena con un update en la misma transacción.
CREATE OR REPLACE FUNCTION invoice_archive_row()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "InvoiceArchive" ("invoiceId", "receivedAt", "createdAt", "updatedAt")
  VALUES (NEW."id", NEW."createdAt", NEW."createdAt", NEW."createdAt")
  ON CONFLICT ("invoiceId") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_archive_row
  AFTER INSERT ON "Invoice"
  FOR EACH ROW
  EXECUTE FUNCTION invoice_archive_row();

-- Nada borra una factura ni un original. Solo el reset de una asesoría marcada
-- isDemo a mano, dentro de una transacción con SET LOCAL
-- app.allow_audit_mutation = 'true' (la misma llave que la auditoría). Borrar
-- un cliente con facturas o documentos tampoco: la cascada llega aquí con el
-- cliente ya borrado y no encuentra su asesoría. Dos IF anidados para que la
-- consulta solo se haga con la llave puesta.
CREATE OR REPLACE FUNCTION archive_no_delete_by_client()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    IF EXISTS (
      SELECT 1 FROM "Client" c
      JOIN "AdvisoryFirm" f ON f."id" = c."advisoryFirmId"
      WHERE c."id" = OLD."clientId" AND f."isDemo"
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Archivo: no se borran facturas ni originales (% %).', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_no_delete_by_client
  BEFORE DELETE ON "Invoice"
  FOR EACH ROW
  EXECUTE FUNCTION archive_no_delete_by_client();

CREATE TRIGGER archive_no_delete_by_client
  BEFORE DELETE ON "Document"
  FOR EACH ROW
  EXECUTE FUNCTION archive_no_delete_by_client();

-- La fila de archivo solo se va con su factura: es la cascada de un borrado
-- que el trigger de "Invoice" ya dejó pasar (llave e isDemo). Sin llave propia:
-- con la factura viva no se borra nunca.
CREATE OR REPLACE FUNCTION archive_row_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Invoice" WHERE "id" = OLD."invoiceId") THEN
    RAISE EXCEPTION 'Archivo: la fila de archivo de una factura no se borra (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_row_no_delete
  BEFORE DELETE ON "InvoiceArchive"
  FOR EACH ROW
  EXECUTE FUNCTION archive_row_no_delete();

-- El fichero de una factura o de un documento no cambia: ni su clave en el
-- almacenamiento ni su huella, que solo se puede rellenar si estaba vacía.
CREATE OR REPLACE FUNCTION archive_file_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'Archivo: no se cambia el fichero (% %, storageKey).', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(OLD."fileHash", '') <> '' AND NEW."fileHash" IS DISTINCT FROM OLD."fileHash" THEN
    RAISE EXCEPTION 'Archivo: no se cambia la huella del fichero (% %, fileHash).', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_file_guard
  BEFORE UPDATE OF "storageKey", "fileHash" ON "Invoice"
  FOR EACH ROW
  EXECUTE FUNCTION archive_file_guard();

CREATE TRIGGER archive_file_guard
  BEFORE UPDATE OF "storageKey", "fileHash" ON "Document"
  FOR EACH ROW
  EXECUTE FUNCTION archive_file_guard();

-- Una factura con nº de registro no cambia de cliente: el número es de la serie
-- de ese cliente.
CREATE OR REPLACE FUNCTION invoice_registered_client_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."clientId" IS DISTINCT FROM OLD."clientId" AND EXISTS (
    SELECT 1 FROM "InvoiceArchive"
    WHERE "invoiceId" = OLD."id" AND ("registerNumber" IS NOT NULL OR "registerSeriesId" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Archivo: una factura con nº de registro no cambia de cliente (factura %).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_registered_client_guard
  BEFORE UPDATE OF "clientId" ON "Invoice"
  FOR EACH ROW
  EXECUTE FUNCTION invoice_registered_client_guard();

-- La fila de archivo. El nº de registro se pone entero (serie, número y fecha a
-- la vez) y en la serie del cliente, el tipo y el año de deducción de la
-- factura; puesto, no cambia. La tanda de llegada y la posición, puestas,
-- tampoco; y el taco donde se guarda el papel no vuelve a vacío. El original en
-- otro formato sí se puede quitar: queda en la auditoría y el Document no se
-- borra.
CREATE OR REPLACE FUNCTION archive_row_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."registerNumber" IS NOT NULL AND (
       NEW."registerNumber" IS DISTINCT FROM OLD."registerNumber"
    OR NEW."registerSeriesId" IS DISTINCT FROM OLD."registerSeriesId"
    OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt"
  ) THEN
    RAISE EXCEPTION 'Archivo: el nº de registro no cambia (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF num_nulls(NEW."registerSeriesId", NEW."registerNumber", NEW."registeredAt") NOT IN (0, 3) THEN
    RAISE EXCEPTION 'Archivo: el nº de registro se pone con su serie y su fecha (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."registerNumber" IS NULL AND NEW."registerNumber" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "InvoiceRegisterSeries" s
    JOIN "Invoice" i ON i."id" = NEW."invoiceId"
    WHERE s."id" = NEW."registerSeriesId" AND s."clientId" = i."clientId" AND s."type" = i."type"
      AND s."year" = COALESCE(i."accountingPeriodYear", i."periodYear")
  ) THEN
    RAISE EXCEPTION 'Archivo: la serie del nº de registro no es la del cliente, el tipo y el año de la factura (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."uploadBatchId" IS NOT NULL AND NEW."uploadBatchId" IS DISTINCT FROM OLD."uploadBatchId" THEN
    RAISE EXCEPTION 'Archivo: la tanda de llegada no cambia (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."uploadPosition" IS NOT NULL AND NEW."uploadPosition" IS DISTINCT FROM OLD."uploadPosition" THEN
    RAISE EXCEPTION 'Archivo: la posición en la tanda no cambia (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paperBatchId" IS NOT NULL AND NEW."paperBatchId" IS NULL THEN
    RAISE EXCEPTION 'Archivo: el papel no se queda sin taco (factura %).', OLD."invoiceId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_row_guard
  BEFORE UPDATE ON "InvoiceArchive"
  FOR EACH ROW
  EXECUTE FUNCTION archive_row_guard();

-- Una serie de registro no cambia de cliente, tipo ni año (cambiaría lo que
-- significan todos sus números), y su contador solo sube: si bajara, la
-- siguiente reserva repetiría números.
CREATE OR REPLACE FUNCTION register_series_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."year" IS DISTINCT FROM OLD."year"
  THEN
    RAISE EXCEPTION 'Archivo: una serie de registro no cambia de cliente, tipo ni año (serie %).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."lastNumber" < OLD."lastNumber" THEN
    RAISE EXCEPTION 'Archivo: el último nº de una serie de registro no baja (serie %).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER register_series_guard
  BEFORE UPDATE ON "InvoiceRegisterSeries"
  FOR EACH ROW
  EXECUTE FUNCTION register_series_guard();

-- El nº de un taco, puesto, no cambia: está escrito en la hoja y en el papel.
CREATE OR REPLACE FUNCTION taco_number_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."tacoNumber" IS NOT NULL AND NEW."tacoNumber" IS DISTINCT FROM OLD."tacoNumber" THEN
    RAISE EXCEPTION 'Archivo: el nº de un taco no cambia (Taco %).', OLD."tacoNumber"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER taco_number_guard
  BEFORE UPDATE OF "tacoNumber" ON "UploadBatch"
  FOR EACH ROW
  EXECUTE FUNCTION taco_number_guard();
