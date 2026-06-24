"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { notifyClientInvoiceValidated, notifyClientInvoiceRejected } from "@/lib/email";
import {
  filterFromInvoice,
  getNextInQueue,
  parseBucket,
  queueToSearchParams,
} from "@/lib/reviewQueue";
import { appendAuditLogs } from "@/lib/auditLog";
import { parseTaxId, isPersonaFisica } from "@/lib/validators";
import { applyRectificativeSign } from "@/lib/rectificative";
import { appError, type AppError } from "@/lib/errorCodes";
import { putObject, getObjectBytes, sanitizeFilenameForStorage, isStorageConfigured } from "@/lib/storage";

/** Resultado de las server actions de revision. El `error` puede ser:
 *  - AppError: cuando es un fallo "conocido" del dominio (tiene codigo)
 *  - string: legacy / errores sin clasificar aun
 *  - undefined / null: exito */
export type ReviewState = { error?: AppError | string } | null;

async function assertWorkerAccess(userId: string, role: string, clientId: string): Promise<ReviewState> {
  if (role !== "WORKER") return null;
  const assignment = await prisma.workerClientAssignment.findUnique({
    where: { workerId_clientId: { workerId: userId, clientId } },
  });
  if (!assignment) return { error: "No tienes acceso a esta factura." };
  return null;
}

type FieldData = {
  issuerName:    string;
  issuerCif:     string;
  receiverName:  string;
  receiverCif:   string;
  /** "PURCHASE" | "SALE" | "" — tipo confirmado en la revisión. */
  type:          string;
  invoiceNumber: string;
  invoiceDate:   string;
  /** JSON-encoded array de lineas: [{taxBase,vatRate,vatAmount}]. */
  vatLines:      string;
  irpfRate:      string;
  irpfAmount:    string;
  totalAmount:   string;
  accountingPeriodMonth: string;
  accountingPeriodYear:  string;
  supplierAccount: string;
  expenseAccount:  string;
  operationType:   string;
  retentionType:   string;
  retentionBase:   string;
  retentionRate:   string;
  retentionAmount: string;
  isRectificative:        string;  // "1" / "0"
  rectifiedInvoiceSeries: string;
  rectifiedInvoiceNumber: string;
  rectificativeType:      string;  // "BY_DIFFERENCE" / "BY_SUBSTITUTION" / ""
  art80Tres:              string;  // "1" / "0"
};

const VALID_OPERATION_TYPES = [
  "INTERIOR", "AGRARIA", "INTRACOM",
  "INVERSION_SP", "IMPORTACION", "IVA_NO_DEDUCIBLE",
] as const;
type ValidOperationType = (typeof VALID_OPERATION_TYPES)[number];

const VALID_RETENTION_TYPES = ["PROFESSIONAL", "RENT"] as const;
type ValidRetentionType = (typeof VALID_RETENTION_TYPES)[number];

const VALID_RECTIFICATIVE_TYPES = ["BY_DIFFERENCE", "BY_SUBSTITUTION"] as const;
type ValidRectificativeType = (typeof VALID_RECTIFICATIVE_TYPES)[number];

type ParsedVatLine = { taxBase: number; vatRate: number; vatAmount: number };

/** Parsea el JSON de lineas, descarta las vacias y normaliza a numeros.
 *  Devuelve [] si el JSON es invalido o no hay nada util. */
function parseVatLines(raw: string): ParsedVatLine[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const lines: ParsedVatLine[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const tb = typeof o.taxBase === "string" ? o.taxBase.trim() : "";
    const vr = typeof o.vatRate === "string" ? o.vatRate.trim() : "";
    const va = typeof o.vatAmount === "string" ? o.vatAmount.trim() : "";
    // Linea vacia: la ignoramos silenciosamente para que el form pueda
    // tener una fila placeholder sin guardarla.
    if (!tb && !vr && !va) continue;
    const taxBase = parseFloat(tb.replace(",", "."));
    const vatRate = parseFloat(vr.replace(",", "."));
    const vatAmount = parseFloat(va.replace(",", "."));
    if (isNaN(taxBase) || isNaN(vatRate) || isNaN(vatAmount)) continue;
    lines.push({ taxBase, vatRate, vatAmount });
  }
  return lines;
}

async function parseAndSave(invoiceId: string, userId: string, data: FieldData, validate: boolean, expectedUpdatedAt?: string) {
  const session = await auth();
  if (!session?.user) return { error: "No autorizado" };

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only modify invoices of assigned clients
  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr;

  // Check if the period is closed (use accounting period when set, fallback to upload period)
  const parseInt2 = (v: string) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const checkMonth = parseInt2(data.accountingPeriodMonth) ?? invoice.accountingPeriodMonth ?? invoice.periodMonth;
  const checkYear  = parseInt2(data.accountingPeriodYear)  ?? invoice.accountingPeriodYear  ?? invoice.periodYear;
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: {
        clientId: invoice.clientId,
        month: checkMonth,
        year: checkYear,
      },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: appError("ERR-VALIDATE-002", `Periodo ${checkMonth}/${checkYear} cerrado`) };
  }

  // Optimistic locking: reject if another user modified the invoice
  if (expectedUpdatedAt) {
    const expected = new Date(expectedUpdatedAt).getTime();
    const actual   = invoice.updatedAt.getTime();
    if (actual !== expected) {
      return { error: appError("ERR-VALIDATE-003", `expected=${expected} actual=${actual}`) };
    }
  }

  const parse = (v: string) => v.trim() === "" ? null : parseFloat(v.replace(",", "."));
  const parseDate = (v: string) => v.trim() === "" ? null : new Date(v);

  const vatLines = parseVatLines(data.vatLines);
  const isRectificativeFlag = data.isRectificative === "1";

  // Validacion de cada linea de IVA antes de calcular nada. Permitimos
  // importes negativos (abonos / rectificativas) sin exigir marcar el check:
  // una rectificativa es, de momento, simplemente una factura en negativo.
  for (const line of vatLines) {
    if (line.vatRate < 0 || line.vatRate > 100) {
      return { error: "El % IVA debe estar entre 0 y 100 en todas las lineas" };
    }
  }

  // Totales denormalizados sobre Invoice. vatRate solo tiene sentido cuando
  // hay una unica linea; multi-IVA -> null.
  const sumBase   = vatLines.reduce((s, l) => s + l.taxBase, 0);
  const sumAmount = vatLines.reduce((s, l) => s + l.vatAmount, 0);
  const denormVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;

  // Normalizar NIFs introducidos a mano por el gestor (quita guiones,
  // espacios, puntos y prefijos de pais). Evita guardar "B-12345678" o
  // "ES B12345678" cuando lo correcto es "B12345678".
  const issuerParsed   = parseTaxId(data.issuerCif);
  const receiverParsed = parseTaxId(data.receiverCif);

  // Tipo confirmado en la revisión (desplegable). Si la factura se subió como
  // "No lo sé", aquí queda fijado; al validar exigimos un tipo concreto.
  const submittedType = data.type === "PURCHASE" || data.type === "SALE" ? data.type : null;
  if (validate && !submittedType && invoice.typeUnconfirmed) {
    return { error: "Indica si la factura es emitida o recibida." };
  }
  const effectiveType: "PURCHASE" | "SALE" =
    submittedType ?? (invoice.type === "SALE" ? "SALE" : "PURCHASE");

  // Parte conocida (cliente) — la fuerza el sistema, no se acepta lo
  // que envie el form. PURCHASE: cliente = receptor; SALE: cliente = emisor.
  // Asi el gestor ni siquiera con devtools puede sustituir los datos
  // del Client por otros distintos.
  const isPurchase = effectiveType === "PURCHASE";
  const finalIssuerName      = isPurchase ? (data.issuerName || null)    : invoice.client.name;
  const finalIssuerCif       = isPurchase ? (issuerParsed.clean || null) : invoice.client.cif;
  const finalIssuerCountry   = isPurchase ? issuerParsed.countryCode     : null;
  const finalReceiverName    = isPurchase ? invoice.client.name          : (data.receiverName || null);
  const finalReceiverCif     = isPurchase ? invoice.client.cif           : (receiverParsed.clean || null);
  const finalReceiverCountry = isPurchase ? null                         : receiverParsed.countryCode;

  // Coherencia: el CIF de emisor y receptor no pueden ser iguales (seria
  // una factura del cliente consigo mismo). Sucede a menudo cuando el
  // OCR confunde los dos cuadros de la factura. Solo bloqueamos al
  // validar — guardar borrador con el conflicto se permite para que el
  // gestor pueda corregirlo en pasos.
  if (validate && finalIssuerCif && finalReceiverCif && finalIssuerCif === finalReceiverCif) {
    return { error: appError("ERR-VALIDATE-001", `cif=${finalIssuerCif}`) };
  }

  // Retencion IRPF: solo persistimos los campos si el tipo esta puesto.
  // Si el gestor "quita retencion" -> todos los campos a null.
  const retentionType: ValidRetentionType | null =
    (VALID_RETENTION_TYPES as readonly string[]).includes(data.retentionType)
      ? (data.retentionType as ValidRetentionType)
      : null;
  const retentionRateNum = retentionType ? parse(data.retentionRate) : null;
  const retentionBaseNum = retentionType ? parse(data.retentionBase) : null;
  // Cuota: si el form la mando, la usamos; si no, calculamos.
  const retentionAmountNum = retentionType
    ? (parse(data.retentionAmount)
        ?? (retentionBaseNum != null && retentionRateNum != null
            ? parseFloat(((retentionBaseNum * retentionRateNum) / 100).toFixed(2))
            : null))
    : null;

  const newData = {
    type:          effectiveType,
    // Al guardar con un tipo concreto, queda confirmado; si no se tocó y
    // seguía sin confirmar (guardar borrador), se mantiene el flag.
    typeUnconfirmed: submittedType ? false : invoice.typeUnconfirmed,
    issuerName:    finalIssuerName,
    issuerCif:     finalIssuerCif,
    issuerCountry: finalIssuerCountry,
    receiverName:    finalReceiverName,
    receiverCif:     finalReceiverCif,
    receiverCountry: finalReceiverCountry,
    invoiceNumber: data.invoiceNumber || null,
    invoiceDate:   parseDate(data.invoiceDate),
    taxBase:       vatLines.length > 0 ? sumBase   : null,
    vatRate:       denormVatRate,
    vatAmount:     vatLines.length > 0 ? sumAmount : null,
    irpfRate:      retentionRateNum,
    irpfAmount:    retentionAmountNum,
    retentionType,
    retentionBase: retentionBaseNum,
    totalAmount:   parse(data.totalAmount),
    accountingPeriodMonth: parseInt2(data.accountingPeriodMonth),
    accountingPeriodYear:  parseInt2(data.accountingPeriodYear),
    supplierAccount: data.supplierAccount || null,
    expenseAccount:  data.expenseAccount  || null,
    operationType:   (VALID_OPERATION_TYPES as readonly string[]).includes(data.operationType)
      ? (data.operationType as ValidOperationType)
      : "INTERIOR" as ValidOperationType,
    isRectificative:        isRectificativeFlag,
    rectifiedInvoiceSeries: isRectificativeFlag ? (data.rectifiedInvoiceSeries.trim() || null) : null,
    rectifiedInvoiceNumber: isRectificativeFlag ? (data.rectifiedInvoiceNumber.trim() || null) : null,
    rectificativeType:      isRectificativeFlag && (VALID_RECTIFICATIVE_TYPES as readonly string[]).includes(data.rectificativeType)
      ? (data.rectificativeType as ValidRectificativeType)
      : null,
    art80Tres:              isRectificativeFlag && data.art80Tres === "1",
  };

  // El total puede ser negativo (abono) sin necesidad de marcar el check.

  // Rectificativa: si el gestor la marca y los importes vienen en positivo,
  // los pasamos a negativo (abono). Misma regla que processInvoice
  // (lib/rectificative): si ya hay signos mixtos/negativos, se respetan.
  // Reflejamos el signo en newData y en las lineas que se persisten para que
  // calculo, auditoria y BD usen los mismos valores.
  const signedLines = isRectificativeFlag
    ? applyRectificativeSign({
        lines: vatLines,
        taxBase: newData.taxBase,
        vatAmount: newData.vatAmount,
        totalAmount: newData.totalAmount,
        irpfAmount: newData.irpfAmount,
        retentionBase: newData.retentionBase,
      })
    : { lines: vatLines, taxBase: newData.taxBase, vatAmount: newData.vatAmount, totalAmount: newData.totalAmount, irpfAmount: newData.irpfAmount, retentionBase: newData.retentionBase };
  newData.taxBase       = signedLines.taxBase;
  newData.vatAmount     = signedLines.vatAmount;
  newData.totalAmount   = signedLines.totalAmount;
  newData.irpfAmount    = signedLines.irpfAmount;
  newData.retentionBase = signedLines.retentionBase;

  // Math validation: Sigma(bases) + Sigma(cuotas) - IRPF = Total (el signo es
  // invariante: negar ambos lados no cambia la diferencia).
  let isValid: boolean | null = null;
  if (signedLines.lines.length > 0 && newData.totalAmount !== null) {
    const sBase = signedLines.lines.reduce((s, l) => s + l.taxBase, 0);
    const sAmount = signedLines.lines.reduce((s, l) => s + l.vatAmount, 0);
    const expected = sBase + sAmount - (newData.irpfAmount ?? 0);
    const diff = Math.abs(
      Math.round(expected * 100) - Math.round(newData.totalAmount * 100)
    );
    isValid = diff <= 2;
  }

  // Build audit log entries for changed fields
  const auditEntries: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  const trackedFields = [
    "type",
    "issuerName","issuerCif","receiverName","receiverCif",
    "invoiceNumber","taxBase","vatRate","vatAmount","irpfRate","irpfAmount","totalAmount",
    "operationType",
    "isRectificative","rectifiedInvoiceNumber","rectificativeType",
  ] as const;

  for (const field of trackedFields) {
    const oldVal = invoice[field] !== null && invoice[field] !== undefined
      ? String(invoice[field]) : null;
    const newVal = newData[field] !== null && newData[field] !== undefined
      ? String(newData[field]) : null;
    if (oldVal !== newVal) {
      auditEntries.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }

  if (validate && !isValid && isValid !== null) {
    // Allow validating with warning but don't block
  }

  // When saving without validating, transition to PENDING_REVIEW if coming from initial states
  // ANALYZED es legacy (pre-refactor); si aun existe en BD se acepta como draft.
  const draftStatuses = ["ANALYZED", "NEEDS_ATTENTION", "PENDING_REVIEW", "OCR_ERROR"];
  const saveStatus = !validate && draftStatuses.includes(invoice.status)
    ? "PENDING_REVIEW"
    : undefined;

  // Persistir factura + lineas en una transaccion. Borramos las lineas
  // previas y reinsertamos: la UI envia el array completo.
  await prisma.$transaction([
    prisma.invoiceVatLine.deleteMany({ where: { invoiceId } }),
    ...(signedLines.lines.length > 0
      ? [prisma.invoiceVatLine.createMany({
          data: signedLines.lines.map((l, i) => ({
            invoiceId,
            position:  i,
            taxBase:   l.taxBase,
            vatRate:   l.vatRate,
            vatAmount: l.vatAmount,
          })),
        })]
      : []),
    prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        ...newData,
        isValid,
        // Si la factura estaba pospuesta y el gestor la edita/valida,
        // la sacamos de la "cola de pospuestas" para que vuelva al
        // orden normal.
        deferredAt: null,
        ...(validate ? { status: "VALIDATED" as const } : saveStatus ? { status: saveStatus as "PENDING_REVIEW" } : {}),
      },
    }),
  ]);

  if (validate) {
    auditEntries.push({ field: "status", oldValue: invoice.status, newValue: "VALIDATED" });
    // Record status transition
    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId,
        fromStatus: invoice.status,
        toStatus: "VALIDATED",
        changedBy: userId,
      },
    });

    // Aprender plan de cuentas + operationType para la "otra parte"
    // (la que NO es el cliente). En PURCHASE es el emisor (proveedor),
    // en SALE es el receptor (cliente final). Asi indexamos por el NIF
    // que cambia entre facturas, no por el del Client que siempre es
    // el mismo.
    const learnNif  = (isPurchase ? newData.issuerCif  : newData.receiverCif )?.trim().toUpperCase();
    const learnName = (isPurchase ? newData.issuerName : newData.receiverName)?.trim();
    const learnSupplier = newData.supplierAccount?.trim();
    const learnExpense = newData.expenseAccount?.trim();
    // defaultVatRate solo lo aprendemos cuando hay un unico tipo (multi-IVA
    // no tiene un "tipo por defecto" significativo).
    const learnVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;
    // Retencion: solo se aprende si el NIF es persona fisica (DNI/NIE).
    // Una SL/SA no tiene retencion IRPF; si el gestor marco una por
    // error y la persistieramos, contaminariamos todas las facturas
    // siguientes del mismo proveedor (caso Parlem Telecom B66486598).
    const learnIsPF = isPersonaFisica(learnNif);
    const learnRetentionType = learnIsPF ? newData.retentionType : null;
    const learnRetentionRate = learnIsPF && newData.irpfRate != null ? newData.irpfRate : null;
    // Aprendemos tambien el tipo de operacion por NIF: la proxima factura
    // de este emisor pre-rellenara el operationType automaticamente.
    if (learnNif && (learnSupplier || learnExpense || newData.operationType)) {
      await prisma.accountEntry.upsert({
        where: { clientId_nif: { clientId: invoice.clientId, nif: learnNif } },
        create: {
          clientId: invoice.clientId,
          nif: learnNif,
          name: learnName || learnNif,
          supplierAccount: learnSupplier || "",
          expenseAccount: learnExpense || "",
          defaultVatRate: learnVatRate != null ? (learnVatRate as any) : null,
          defaultOperationType: newData.operationType,
          defaultRetentionType: learnRetentionType,
          defaultRetentionRate: learnRetentionRate != null ? (learnRetentionRate as any) : null,
        },
        update: {
          ...(learnName ? { name: learnName } : {}),
          ...(learnSupplier ? { supplierAccount: learnSupplier } : {}),
          ...(learnExpense ? { expenseAccount: learnExpense } : {}),
          ...(learnVatRate != null ? { defaultVatRate: learnVatRate as any } : {}),
          defaultOperationType: newData.operationType,
          // Si el gestor quita la retencion (o no aplica por no ser
          // persona fisica), tambien limpiamos lo aprendido para no
          // re-sugerirla la proxima vez.
          defaultRetentionType: learnRetentionType,
          defaultRetentionRate: learnRetentionRate != null ? (learnRetentionRate as any) : null,
        },
      });
    }
  }

  if (auditEntries.length > 0) {
    await appendAuditLogs(
      auditEntries.map((e) => ({
        invoiceId,
        userId,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
      })),
    );
  }

  return null; // no error
}

export async function saveInvoiceFields(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const id = formData.get("invoiceId") as string;
  const expectedUpdatedAt = formData.get("updatedAt") as string | null;
  const err = await parseAndSave(id, session.user.id, extractFields(formData), false, expectedUpdatedAt ?? undefined);
  return err ?? null;
}

export async function validateInvoice(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const id = formData.get("invoiceId") as string;
  const fallbackNext = formData.get("nextId") as string | null;
  const bucket = parseBucket(formData.get("bucket"));
  const expectedUpdatedAt = formData.get("updatedAt") as string | null;
  const err = await parseAndSave(id, session.user.id, extractFields(formData), true, expectedUpdatedAt ?? undefined);
  if (err) return err;

  // Notify client via email (after response)
  after(async () => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id },
        include: { client: { include: { user: { select: { email: true } } } } },
      });
      if (inv?.client?.user?.email) {
        await notifyClientInvoiceValidated({
          clientEmail: inv.client.user.email,
          clientName: inv.client.name,
          invoiceNumber: inv.invoiceNumber ?? "",
          filename: inv.filename,
        });
      }
    } catch (e) {
      console.error("[NOTIFY] Error notifying client:", e);
    }
  });

  // Recomputar el siguiente respetando el bucket actual (puede haber
  // cambiado desde que cargo la pagina: otro gestor valido, etc).
  const nextId = await resolveNextId(id, bucket, fallbackNext);
  // Invalidar el cache de la siguiente factura: Next.js la habia
  // prefetcheado mientras la actual aun estaba PENDING, asi que el
  // contador X/N quedaria desfasado (p.ej. "2/8" en vez de "2/7").
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  if (nextId) {
    const suffix = queueToSearchParams({ bucket }).toString();
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

/**
 * Dado un invoiceId recien procesado, devuelve el siguiente id pendiente
 * de la misma cola (mismo cliente + periodo + tipo + bucket). Si algo
 * falla (factura no encontrada, etc) cae en el fallback que venia del
 * formulario.
 */
async function resolveNextId(
  currentId: string,
  bucket: "clean" | "attention" | "all",
  fallback: string | null,
): Promise<string | null> {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: currentId },
      select: { clientId: true, periodMonth: true, periodYear: true, type: true },
    });
    if (!inv) return fallback || null;
    const filter = filterFromInvoice(inv, bucket);
    const next = await getNextInQueue(currentId, filter);
    return next ?? fallback ?? null;
  } catch {
    return fallback || null;
  }
}

/**
 * "Posponer" una factura: la marca con `deferredAt = now()` (sin
 * cambiar status) y salta a la siguiente. La cola ordena las pospuestas
 * al final, así no estorban al flujo principal. Se limpia automáticamente
 * cuando alguien edita o valida la factura.
 */
export async function deferInvoice(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const id = formData.get("invoiceId") as string;
  const fallbackNext = formData.get("nextId") as string | null;
  const bucket = parseBucket(formData.get("bucket"));

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr;

  await prisma.invoice.update({
    where: { id },
    data: { deferredAt: new Date() },
  });

  const nextId = await resolveNextId(id, bucket, fallbackNext);
  // Posponer no marca la factura como "hecha" — el contador X/N no
  // cambia. Solo invalidamos las listas para que los lotes muestren el
  // nuevo orden.
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  if (nextId) {
    const suffix = queueToSearchParams({ bucket }).toString();
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

export async function rejectInvoice(
  _prev: ReviewState,
  formData: FormData
): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const id = formData.get("invoiceId") as string;
  const reason = (formData.get("rejectionReason") as string)?.trim();
  const category = formData.get("rejectionCategory") as string | null;
  const fallbackNext = formData.get("nextId") as string | null;
  const bucket = parseBucket(formData.get("bucket"));

  if (!reason) {
    return { error: "Debes indicar el motivo del rechazo." };
  }

  const validCategories = ["ILLEGIBLE", "INCOMPLETE", "WRONG_PERIOD", "DUPLICATE", "OTHER"];
  if (category && !validCategories.includes(category)) {
    return { error: "Categoría de rechazo no válida." };
  }

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only reject invoices of assigned clients
  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr;

  await prisma.invoice.update({
    where: { id },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      ...(category ? { rejectionCategory: category as "ILLEGIBLE" | "INCOMPLETE" | "WRONG_PERIOD" | "DUPLICATE" | "OTHER" } : {}),
    },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId: id,
      fromStatus: invoice.status,
      toStatus: "REJECTED",
      changedBy: session.user.id,
      reason,
    },
  });

  await appendAuditLogs([{
    invoiceId: id,
    userId: session.user.id,
    field: "status",
    oldValue: invoice.status,
    newValue: "REJECTED",
  }]);

  // Notify client about rejection
  after(async () => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id },
        include: { client: { include: { user: { select: { email: true } } } } },
      });
      if (inv?.client?.user?.email) {
        await notifyClientInvoiceRejected({
          clientEmail: inv.client.user.email,
          clientName: inv.client.name,
          invoiceNumber: inv.invoiceNumber ?? "",
          filename: inv.filename,
          reason,
        });
      }
    } catch (e) {
      console.error("[NOTIFY] Error notifying client rejection:", e);
    }
  });

  const nextId = await resolveNextId(id, bucket, fallbackNext);
  // Mismo motivo que en validateInvoice: prefetch del siguiente puede
  // tener un contador X/N desfasado tras rechazar la actual.
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  if (nextId) {
    const suffix = queueToSearchParams({ bucket }).toString();
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

// ── División multi-ticket ──────────────────────────────────────────────────

export type SplitTicket = {
  /** Nombre descriptivo del ticket (ej: "ticket1"). */
  name: string;
  /** Data URL base64 del recorte (image/jpeg o image/png). */
  dataUrl: string;
};

/**
 * Divide una foto con múltiples tickets en sub-facturas independientes.
 * Cada sub-factura se sube a Supabase, se inserta en BD y se lanza OCR.
 * La factura original pasa a estado SPLIT_SOURCE y sale de la cola activa.
 */
export async function splitInvoice(
  invoiceId: string,
  tickets: SplitTicket[],
  bucket: string,
): Promise<{ error?: string }> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  if (!tickets.length || tickets.length > 20) {
    return { error: "Número de tickets inválido (1-20)" };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr as { error: string };

  if (!isStorageConfigured()) return { error: "Almacenamiento no configurado" };
  const createdIds: string[] = [];

  for (const ticket of tickets) {
    // Extraer el buffer del data URL (data:[mime];base64,[data])
    const match = ticket.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return { error: `Recorte inválido para "${ticket.name}"` };
    const mime = match[1] as string;
    const buffer = Buffer.from(match[2], "base64");

    const ext = mime === "image/png" ? "png" : "jpg";
    const safeName = sanitizeFilenameForStorage(`${ticket.name}.${ext}`);
    const storageKey = `${invoice.clientId}/${invoice.periodYear}-${String(invoice.periodMonth).padStart(2, "0")}/${Date.now()}-split-${safeName}`;
    const fileHash = createHash("sha256").update(buffer).digest("hex");

    try {
      await putObject(storageKey, buffer, mime);
    } catch (e) {
      return { error: `Error subiendo "${ticket.name}": ${e instanceof Error ? e.message : "fallo"}` };
    }

    const filename = `${ticket.name}.${ext}`;
    const document = await prisma.document.create({
      data: {
        filename,
        storageKey,
        fileType: mime,
        fileHash,
        sizeBytes: buffer.length,
        uploadedBy: session.user.id,
        clientId: invoice.clientId,
      },
    });

    const child = await prisma.invoice.create({
      data: {
        filename,
        storageKey,
        fileType: mime,
        fileHash,
        type: invoice.type,
        periodMonth: invoice.periodMonth,
        periodYear: invoice.periodYear,
        clientId: invoice.clientId,
        documentId: document.id,
        splitFromId: invoiceId,
      },
    });
    createdIds.push(child.id);
  }

  // Marcar la original como dividida
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "SPLIT_SOURCE" },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId,
      fromStatus: invoice.status,
      toStatus: "SPLIT_SOURCE",
      changedBy: session.user.id,
    },
  });

  await appendAuditLogs([{
    invoiceId,
    userId: session.user.id,
    field: "status",
    oldValue: invoice.status,
    newValue: "SPLIT_SOURCE",
  }]);

  // OCR en segundo plano para las sub-facturas
  const userId = session.user.id;
  after(async () => {
    const { processInvoice } = await import("@/lib/processInvoice");
    for (const childId of createdIds) {
      await processInvoice(childId, userId).catch((err) => {
        console.error(`[splitInvoice/processInvoice] ${childId} falló:`, err);
      });
    }
  });

  // Calcular el siguiente pendiente en la cola y redirigir
  const parsedBucket = parseBucket(bucket);
  const filter = filterFromInvoice(invoice, parsedBucket);
  const nextId = await getNextInQueue(invoiceId, filter);

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");

  const suffix = queueToSearchParams({ bucket: parsedBucket }).toString();
  if (nextId) {
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

// ── División PDF multi-factura ────────────────────────────────────────────────

export type PdfSplitPart = {
  /** Nombre descriptivo de la parte (ej: "factura1"). */
  name: string;
  /** Página inicial, 1-indexado. */
  startPage: number;
  /** Página final, 1-indexado, inclusive. */
  endPage: number;
};

/**
 * Divide un PDF con múltiples facturas en sub-facturas independientes
 * extrayendo los rangos de páginas indicados.
 * La factura original pasa a SPLIT_SOURCE y cada parte se lanza a OCR.
 */
export async function splitPdfInvoice(
  invoiceId: string,
  parts: PdfSplitPart[],
  bucket: string,
): Promise<{ error?: string }> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  if (parts.length < 2 || parts.length > 20) {
    return { error: "Número de partes inválido (2-20)" };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertWorkerAccess(session.user.id, session.user.role, invoice.clientId);
  if (accessErr) return accessErr as { error: string };

  if (!isStorageConfigured()) return { error: "Almacenamiento no configurado" };

  // Descargar el PDF original desde Garage
  let originalBytes: Buffer;
  try {
    originalBytes = await getObjectBytes(invoice.storageKey);
  } catch (e) {
    return { error: `No se pudo descargar el PDF: ${e instanceof Error ? e.message : "sin datos"}` };
  }

  // Cargar con pdf-lib y validar rangos
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(originalBytes);
  const totalPages = srcDoc.getPageCount();

  for (const part of parts) {
    if (!part.name.trim()) return { error: "Todas las partes deben tener un nombre." };
    if (part.startPage < 1 || part.endPage > totalPages || part.startPage > part.endPage) {
      return { error: `Rango inválido para "${part.name}": páginas ${part.startPage}-${part.endPage} (total: ${totalPages})` };
    }
  }

  const createdIds: string[] = [];

  for (const part of parts) {
    const newDoc = await PDFDocument.create();
    // copyPages devuelve las páginas en el mismo orden que el array de índices
    const pageIndices = Array.from(
      { length: part.endPage - part.startPage + 1 },
      (_, i) => part.startPage - 1 + i,
    );
    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    for (const p of copiedPages) newDoc.addPage(p);

    const pdfBytes = Buffer.from(await newDoc.save());
    const fileHash = createHash("sha256").update(pdfBytes).digest("hex");

    const safeName = sanitizeFilenameForStorage(`${part.name}.pdf`);
    const storageKey = `${invoice.clientId}/${invoice.periodYear}-${String(invoice.periodMonth).padStart(2, "0")}/${Date.now()}-split-${safeName}`;

    try {
      await putObject(storageKey, pdfBytes, "application/pdf");
    } catch (e) {
      return { error: `Error subiendo "${part.name}": ${e instanceof Error ? e.message : "fallo"}` };
    }

    const filename = `${part.name}.pdf`;
    const document = await prisma.document.create({
      data: {
        filename,
        storageKey,
        fileType: "application/pdf",
        fileHash,
        sizeBytes: pdfBytes.length,
        uploadedBy: session.user.id,
        clientId: invoice.clientId,
      },
    });

    const child = await prisma.invoice.create({
      data: {
        filename,
        storageKey,
        fileType: "application/pdf",
        fileHash,
        type: invoice.type,
        periodMonth: invoice.periodMonth,
        periodYear: invoice.periodYear,
        clientId: invoice.clientId,
        documentId: document.id,
        splitFromId: invoiceId,
      },
    });
    createdIds.push(child.id);
  }

  // Marcar la original como dividida
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "SPLIT_SOURCE" },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId,
      fromStatus: invoice.status,
      toStatus: "SPLIT_SOURCE",
      changedBy: session.user.id,
    },
  });

  await appendAuditLogs([{
    invoiceId,
    userId: session.user.id,
    field: "status",
    oldValue: invoice.status,
    newValue: "SPLIT_SOURCE",
  }]);

  // OCR en segundo plano para las sub-facturas
  const userId = session.user.id;
  after(async () => {
    const { processInvoice } = await import("@/lib/processInvoice");
    for (const childId of createdIds) {
      await processInvoice(childId, userId).catch((err) => {
        console.error(`[splitPdfInvoice/processInvoice] ${childId} falló:`, err);
      });
    }
  });

  const parsedBucket = parseBucket(bucket);
  const filter = filterFromInvoice(invoice, parsedBucket);
  const nextId = await getNextInQueue(invoiceId, filter);

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");

  const suffix = queueToSearchParams({ bucket: parsedBucket }).toString();
  if (nextId) {
    redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  }
  redirect("/dashboard/worker/invoices");
}

function extractFields(fd: FormData): FieldData {
  return {
    issuerName:    fd.get("issuerName")    as string ?? "",
    issuerCif:     fd.get("issuerCif")     as string ?? "",
    receiverName:  fd.get("receiverName")  as string ?? "",
    receiverCif:   fd.get("receiverCif")   as string ?? "",
    type:          fd.get("type")          as string ?? "",
    invoiceNumber: fd.get("invoiceNumber") as string ?? "",
    invoiceDate:   fd.get("invoiceDate")   as string ?? "",
    vatLines:      fd.get("vatLines")      as string ?? "",
    irpfRate:      fd.get("irpfRate")      as string ?? "",
    irpfAmount:    fd.get("irpfAmount")    as string ?? "",
    totalAmount:   fd.get("totalAmount")   as string ?? "",
    accountingPeriodMonth: fd.get("accountingPeriodMonth") as string ?? "",
    accountingPeriodYear:  fd.get("accountingPeriodYear")  as string ?? "",
    supplierAccount: fd.get("supplierAccount") as string ?? "",
    expenseAccount:  fd.get("expenseAccount")  as string ?? "",
    operationType:   fd.get("operationType")   as string ?? "INTERIOR",
    retentionType:   fd.get("retentionType")   as string ?? "",
    retentionBase:   fd.get("retentionBase")   as string ?? "",
    retentionRate:   fd.get("retentionRate")   as string ?? "",
    retentionAmount: fd.get("retentionAmount") as string ?? "",
    isRectificative:        fd.get("isRectificative")        as string ?? "0",
    rectifiedInvoiceSeries: fd.get("rectifiedInvoiceSeries") as string ?? "",
    rectifiedInvoiceNumber: fd.get("rectifiedInvoiceNumber") as string ?? "",
    rectificativeType:      fd.get("rectificativeType")      as string ?? "",
    art80Tres:              fd.get("art80Tres")              as string ?? "0",
  };
}
