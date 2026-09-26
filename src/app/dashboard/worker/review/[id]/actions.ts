"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { revalidatePath, refresh } from "next/cache";
import { notifyClientInvoiceValidated, notifyClientInvoiceRejected } from "@/lib/email";
import {
  filterFromInvoice,
  getNextInQueue,
  parseBackHref,
  parseBucket,
  queueToSearchParams,
  type QueueBucket,
  type QueueFilter,
} from "@/lib/reviewQueue";
import { appendAuditLogs } from "@/lib/auditLog";
import { canAccessClient } from "@/lib/accessibleClients";
import { parseTaxId, isPersonaFisica, operationTypeLabel, OPERATION_TYPE_OPTIONS, OPERATION_TYPE_LABEL, type OperationTypeName } from "@/lib/validators";
import { learnAccountsForDirection } from "@/lib/accountingAccount";
import { accountEntryKey, entryNameMatches, NO_RELIABLE_NIF_PREFIX } from "@/lib/supplierMatching";
import {
  isIntracomOperation,
  goodsTypeFromOperationType,
  normalizeGoodsType,
  normalizeGoodsSource,
  normalizeGoodsTypeScope,
  goodsTypeLearning,
} from "@/lib/intracomGoods";
import { normalizeCurrency } from "@/lib/currency";
import { applyRectificativeSign } from "@/lib/rectificative";
import { foldSurchargeLines, completeReadSurcharges, surchargeAuditValue } from "@/lib/equivalenceSurcharge";
import { exportFingerprint, type FingerprintInvoice } from "@/lib/exportFingerprint";
import { appError, type AppError } from "@/lib/errorCodes";
import { putObject, getObjectBytes, sanitizeFilenameForStorage, isStorageConfigured } from "@/lib/storage";
import { NEEDS_REVIEW } from "@/lib/invoiceStatuses";
import { Prisma, type Invoice } from "@prisma/client";
import { EXPORT_TRANSACTION_OPTIONS } from "@/lib/exportBatch";

/** Resultado de las server actions de revision. El `error` puede ser:
 *  - AppError: cuando es un fallo "conocido" del dominio (tiene codigo)
 *  - string: legacy / errores sin clasificar aun
 *  - undefined / null: exito */
export type ReviewState = { error?: AppError | string } | null;

/** WORKER: el cliente tiene que estar asignado. ADMIN: tiene que ser de su
 *  asesoria. Antes solo se comprobaba al WORKER: cualquier otro rol pasaba sin
 *  mirar nada y podia tocar facturas de otra asesoria conociendo el id. */
async function assertInvoiceAccess(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  clientId: string,
): Promise<ReviewState> {
  if (await canAccessClient(session, clientId)) return null;
  return { error: "No tienes acceso a esta factura." };
}

/** Periodo en el que cuenta la factura: el contable si lo tiene, si no el del
 *  lote. Mismo criterio que la pagina de revision y que parseAndSave. */
function invoicePeriod(
  invoice: Pick<Invoice, "periodMonth" | "periodYear" | "accountingPeriodMonth" | "accountingPeriodYear">,
): { month: number; year: number } {
  return {
    month: invoice.accountingPeriodMonth ?? invoice.periodMonth,
    year: invoice.accountingPeriodYear ?? invoice.periodYear,
  };
}

/** Rechazar y dividir cambian la factura igual que guardar: con el periodo
 *  cerrado no se tocan (mismo criterio que rejectBatch). La pagina ya oculta
 *  los botones, pero puede estar abierta desde antes del cierre. */
async function closedPeriodError(
  clientId: string,
  periods: { month: number; year: number }[],
  action: string,
): Promise<{ error: string } | null> {
  const seen = new Set<string>();
  for (const { month, year } of periods) {
    const key = `${month}/${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const closure = await prisma.periodClosure.findUnique({
      where: { clientId_month_year: { clientId, month, year } },
      select: { reopenedAt: true },
    });
    if (closure && !closure.reopenedAt) {
      return { error: `El periodo ${key} está cerrado: pide a un administrador que lo reabra en Cierres antes de ${action} la factura.` };
    }
  }
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
  /** ISO 4217. null si el formulario no lo envia: se conserva el guardado. */
  currency:      string | null;
  accountingPeriodMonth: string;
  accountingPeriodYear:  string;
  supplierAccount: string;
  expenseAccount:  string;
  operationType:   string;
  /** "BIENES" / "SERVICIOS" / "" — en ventas intracomunitarias (cuenta
   *  700/705). En compras lo dice el tipo de operacion (3/8) y se ignora. */
  intracomGoodsType: string;
  /** De donde sale la clasificacion: "IA" / "TERCERO" / "CUENTA" / "MANUAL". */
  intracomGoodsSource: string;
  /** Respuesta al validar a "¿este tercero va siempre asi?": "SIEMPRE" /
   *  "SOLO_ESTA" / "" (no se pregunto). */
  goodsTypeScope: string;
  /** Lo asignado al tercero que tenia delante el gestor al contestar
   *  ("BIENES" / "SERVICIOS" / ""). */
  goodsTypeAssignedSeen: string;
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

const VALID_RETENTION_TYPES = ["PROFESSIONAL", "RENT"] as const;
type ValidRetentionType = (typeof VALID_RETENTION_TYPES)[number];

const VALID_RECTIFICATIVE_TYPES = ["BY_DIFFERENCE", "BY_SUBSTITUTION"] as const;
type ValidRectificativeType = (typeof VALID_RECTIFICATIVE_TYPES)[number];

type ParsedVatLine = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  /** Recargo de equivalencia DE ESTA LINEA. null = esta linea no lo lleva —
   *  no confundir con 0. Va por linea, no por factura (ver Client.equivalenceSurchargeCustomer). */
  equivalenceSurchargeRate: number | null;
  equivalenceSurchargeAmount: number | null;
};

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
    const sr = typeof o.equivalenceSurchargeRate === "string" ? o.equivalenceSurchargeRate.trim() : "";
    const sa = typeof o.equivalenceSurchargeAmount === "string" ? o.equivalenceSurchargeAmount.trim() : "";
    const srNum = sr ? parseFloat(sr.replace(",", ".")) : NaN;
    const saNum = sa ? parseFloat(sa.replace(",", ".")) : NaN;
    lines.push({
      taxBase, vatRate, vatAmount,
      equivalenceSurchargeRate:   isNaN(srNum) ? null : srNum,
      equivalenceSurchargeAmount: isNaN(saNum) ? null : saNum,
    });
  }
  // La IA devuelve a veces el recargo como si fuera otra linea de IVA (tipo
  // 5,2 / 1,4 / 0,5) y el formulario la reenvia tal cual. Se pliega sobre su
  // linea antes de guardar: en A3 seria un IVA que no existe.
  return completeReadSurcharges(foldSurchargeLines(lines).lines);
}

async function parseAndSave(invoiceId: string, userId: string, data: FieldData, validate: boolean, expectedUpdatedAt?: string) {
  const session = await auth();
  if (!session?.user) return { error: "No autorizado" };

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: true,
      vatLines: { orderBy: { position: "asc" } },
      // Ultimo Excel en el que salio esta factura, con el snapshot de lo que
      // se le mando a A3: es contra eso contra lo que hay que comparar una
      // correccion, no contra la fila viva.
      exportBatchItems: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { exportBatchId: true, snapshot: true },
      },
    },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only modify invoices of assigned clients
  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
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
  // Con guard: un valor no parseable (raro con <input type="date">, pero
  // posible via API) produciria un Invalid Date que Prisma rechaza.
  const parseDate = (v: string) => {
    if (v.trim() === "") return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };

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

  // El tipo de operacion tiene que existir Y valer para el sentido de la
  // factura. La lista suelta que habia aqui no se actualizo al añadir
  // INTRACOM_SERVICIOS y lo convertia en INTERIOR sin avisar: a A3 llegaba
  // un 1 en vez de un 8, y encima se aprendia para el proveedor. Y un tipo
  // de compra en una emitida exporta un codigo que en expedidas significa
  // otra cosa (el 4 de la inversion del sujeto pasivo es "triangular").
  const allowedOperationTypes: readonly string[] =
    OPERATION_TYPE_OPTIONS[effectiveType === "SALE" ? "SALE" : "PURCHASE"];
  if (!allowedOperationTypes.includes(data.operationType)) {
    const direccion = effectiveType === "SALE" ? "SALE" : "PURCHASE";
    const etiqueta = data.operationType in OPERATION_TYPE_LABEL
      ? operationTypeLabel(data.operationType as OperationTypeName, direccion)
      : (data.operationType || "(vacío)");
    return {
      error: `El tipo de operación «${etiqueta}» no es válido para facturas ${effectiveType === "SALE" ? "emitidas" : "recibidas"}. Elige uno de la lista.`,
    };
  }
  const submittedOperationType = data.operationType as OperationTypeName;
  // Bienes o servicios: solo en intracomunitarias (fuera de ellas se descarta
  // para no dejar un dato residual). En compras lo dice el propio codigo
  // (3 bienes / 8 servicios); en ventas va aparte y decide la cuenta 700/705.
  const isIntracom = isIntracomOperation(effectiveType, submittedOperationType);
  const intracomGoodsType = !isIntracom
    ? null
    : effectiveType === "PURCHASE"
      ? goodsTypeFromOperationType(submittedOperationType)
      : normalizeGoodsType(data.intracomGoodsType);
  if (validate && isIntracom && !intracomGoodsType) {
    return { error: "Marca si la entrega intracomunitaria es de bienes o de servicios antes de validar." };
  }
  const intracomGoodsSource = intracomGoodsType ? normalizeGoodsSource(data.intracomGoodsSource) : null;

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
    currency:      data.currency === null ? invoice.currency : normalizeCurrency(data.currency),
    accountingPeriodMonth: parseInt2(data.accountingPeriodMonth),
    accountingPeriodYear:  parseInt2(data.accountingPeriodYear),
    supplierAccount: data.supplierAccount || null,
    expenseAccount:  data.expenseAccount  || null,
    operationType:   submittedOperationType,
    intracomGoodsType,
    intracomGoodsSource,
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

  // applyRectificativeSign ya firma tambien la cuota de recargo de cada
  // linea, asi que se guardan sus lineas tal cual: repegar el recargo de
  // vatLines por indice devolvia el recargo en positivo en un abono.
  const linesToSave = signedLines.lines.map((l) => ({
    ...l,
    equivalenceSurchargeRate:   l.equivalenceSurchargeRate   ?? null,
    equivalenceSurchargeAmount: l.equivalenceSurchargeAmount ?? null,
  }));
  const sumSurcharge = linesToSave.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0);

  // Math validation: Sigma(bases) + Sigma(cuotas) + Sigma(recargo) - IRPF =
  // Total (el signo es invariante: negar ambos lados no cambia la diferencia).
  let isValid: boolean | null = null;
  if (signedLines.lines.length > 0 && newData.totalAmount !== null) {
    const sBase = signedLines.lines.reduce((s, l) => s + l.taxBase, 0);
    const sAmount = signedLines.lines.reduce((s, l) => s + l.vatAmount, 0);
    const expected = sBase + sAmount + sumSurcharge - (newData.irpfAmount ?? 0);
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
    "invoiceNumber","taxBase","vatRate","vatAmount","irpfRate","irpfAmount","totalAmount","currency",
    "operationType","intracomGoodsType",
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

  // El recargo dejo de ser un campo de Invoice y paso a las lineas, con lo
  // que se quedo fuera de trackedFields: cambiarlo no dejaba rastro ninguno.
  // Se audita como un resumen por linea.
  const oldSurcharge = surchargeAuditValue(invoice.vatLines.map((l) => ({
    taxBase:   Number(l.taxBase),
    vatRate:   Number(l.vatRate),
    vatAmount: Number(l.vatAmount),
    equivalenceSurchargeRate:   l.equivalenceSurchargeRate   == null ? null : Number(l.equivalenceSurchargeRate),
    equivalenceSurchargeAmount: l.equivalenceSurchargeAmount == null ? null : Number(l.equivalenceSurchargeAmount),
  })));
  const newSurcharge = surchargeAuditValue(linesToSave);
  if (oldSurcharge !== newSurcharge) {
    auditEntries.push({ field: "equivalenceSurcharge", oldValue: oldSurcharge, newValue: newSurcharge });
  }

  if (validate && !isValid && isValid !== null) {
    // Allow validating with warning but don't block
  }

  // Volver a validar una factura ya validada (se vuelve a ella con "<" o desde
  // el listado para corregirla) es guardar la correccion: el estado no cambia,
  // asi que ni historial VALIDATED -> VALIDATED ni entrada de estado en la
  // auditoria.
  const alreadyValidated = invoice.status === "VALIDATED";
  // EXPORTED (legacy, "validada y exportada") se normaliza a VALIDATED al
  // corregirla, tambien sin validar: /api/export solo recoge VALIDATED con
  // exportBatchId null, y si se quedara EXPORTED una correccion que la saca
  // del lote no volveria nunca al Excel.
  const toValidated = (validate && !alreadyValidated) || invoice.status === "EXPORTED";

  // When saving without validating, transition to PENDING_REVIEW if coming from initial states
  // ANALYZED es legacy (pre-refactor); si aun existe en BD se acepta como draft.
  const draftStatuses = ["ANALYZED", "NEEDS_ATTENTION", "PENDING_REVIEW", "OCR_ERROR"];
  const saveStatus = !validate && draftStatuses.includes(invoice.status)
    ? "PENDING_REVIEW"
    : undefined;

  // ¿Esta correccion cambia lo que A3 tiene de esta factura?
  //
  // Se compara contra el snapshot del ultimo Excel en el que salio, no contra
  // la fila que hay ahora en BD. Asi, si el gestor corrige y luego deshace la
  // correccion, la factura vuelve a quedar como exportada en vez de colarse
  // en el siguiente fichero con una fila identica a la que A3 ya tiene.
  //  - difiere  -> exportBatchId a null: vuelve a la cola de exportacion.
  //  - coincide -> se le devuelve su lote: A3 ya tiene esos datos.
  // undefined = no hay nada que tocar (la factura nunca se exporto, o ya
  // estaba en el estado que toca).
  let nuevoExportBatchId: string | null | undefined;
  const ultimoExport = invoice.exportBatchItems[0] ?? null;
  if (ultimoExport) {
    let exportado: FingerprintInvoice | null = null;
    try {
      exportado = JSON.parse(ultimoExport.snapshot) as FingerprintInvoice;
    } catch {
      exportado = null; // snapshot ilegible: se trata como "difiere"
    }
    const coincide = exportado != null
      && exportFingerprint(exportado) === exportFingerprint({ ...invoice, ...newData, vatLines: linesToSave });
    const destino = coincide ? ultimoExport.exportBatchId : null;
    if (destino !== invoice.exportBatchId) {
      nuevoExportBatchId = destino;
      auditEntries.push({
        field: "reexport",
        oldValue: invoice.exportBatchId
          ? `exportada (lote ${invoice.exportBatchId})`
          : "pendiente de volver a exportar",
        newValue: destino
          ? `vuelve a coincidir con lo exportado (lote ${destino})`
          : "pendiente de volver a exportar",
      });
    }
  }

  // Persistir factura + lineas en una transaccion. Borramos las lineas
  // previas y reinsertamos: la UI envia el array completo.
  //
  // La escritura de la factura va la primera y condicionada al updatedAt que
  // se leyo: el bloqueo optimista de arriba solo mira la lectura, y una
  // exportacion que confirma entre la lectura y esta escritura dejaba la
  // correccion aplicada sobre una factura ya exportada con los datos viejos
  // (F-049). El export pone updatedAt al reservar, asi que aqui no cuadra.
  //
  // Si el export tiene la fila reservada, esta escritura espera a su COMMIT, que
  // puede tardar hasta el timeout del export: con los 5 s por defecto de Prisma
  // la transaccion caducaba (P2028), la accion lanzaba y el gestor perdia lo
  // tecleado. Esta accion no lanza nunca: todo sale como { error }.
  let saved: boolean;
  try {
    saved = await prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.updateMany({
        where: { id: invoiceId, updatedAt: invoice.updatedAt },
        data: {
          ...newData,
          isValid,
          // Si la factura estaba pospuesta y el gestor la edita/valida,
          // la sacamos de la "cola de pospuestas" para que vuelva al
          // orden normal.
          deferredAt: null,
          // Va en la misma escritura que los datos corregidos: si se hiciera
          // aparte y fallara, quedaria la factura corregida pero marcada como
          // exportada, y ya no habria forma de que volviera al Excel.
          ...(nuevoExportBatchId !== undefined ? { exportBatchId: nuevoExportBatchId } : {}),
          ...(toValidated
            ? { status: "VALIDATED" as const }
            : saveStatus ? { status: saveStatus as "PENDING_REVIEW" } : {}),
        },
      });
      // Ha cambiado desde la lectura: no se escribe nada mas.
      if (updated.count === 0) return false;

      await tx.invoiceVatLine.deleteMany({ where: { invoiceId } });
      if (linesToSave.length > 0) {
        await tx.invoiceVatLine.createMany({
          data: linesToSave.map((l, i) => ({
            invoiceId,
            position:  i,
            taxBase:   l.taxBase,
            vatRate:   l.vatRate,
            vatAmount: l.vatAmount,
            equivalenceSurchargeRate:   l.equivalenceSurchargeRate,
            equivalenceSurchargeAmount: l.equivalenceSurchargeAmount,
          })),
        });
      }
      return true;
    }, { timeout: EXPORT_TRANSACTION_OPTIONS.timeout + 5_000, maxWait: 5_000 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028") {
      return { error: appError("ERR-VALIDATE-003", `P2028 al escribir: ${err.message}`) };
    }
    console.error(`[review] no se pudo guardar la factura ${invoiceId}:`, err);
    return { error: appError("ERR-SYS-001", `guardar ${invoiceId}: ${err instanceof Error ? err.message : String(err)}`) };
  }
  if (!saved) {
    return { error: appError("ERR-VALIDATE-003", `updatedAt=${invoice.updatedAt.getTime()} al escribir`) };
  }

  if (toValidated) {
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
  }

  if (validate) {
    // Aprender plan de cuentas + operationType para la "otra parte"
    // (la que NO es el cliente). En PURCHASE es el emisor (proveedor),
    // en SALE es el receptor (cliente final). Asi indexamos por el NIF
    // que cambia entre facturas, no por el del Client que siempre es
    // el mismo.
    const learnNif  = (isPurchase ? newData.issuerCif  : newData.receiverCif )?.trim().toUpperCase();
    const learnName = (isPurchase ? newData.issuerName : newData.receiverName)?.trim();
    const learnCountry = isPurchase ? newData.issuerCountry : newData.receiverCountry;
    // Clave de identidad del tercero: el NIF si es fiable, o el nombre
    // normalizado si no (proveedores extranjeros sin NIF/VAT valido, ej.
    // chinos). Usar el NIF basura tal cual arriesgaria fusionar en una sola
    // fila a dos proveedores distintos que comparten el mismo identificador
    // no fiable. El pais ya resuelto es necesario porque learnNif llega SIN
    // prefijo (issuerCif/receiverCif se guardan limpios) — sin el, un VAT
    // extranjero real se validaria como NIF espanol y fallaria por error.
    const learnKey = accountEntryKey(learnNif, learnName, learnCountry);
    // Cada cuenta se aprende en la columna de SU sentido: la ficha guarda a la
    // vez la pareja de proveedor (40x/41x + gasto) y la de cliente (43x +
    // ingreso), que en A3 son dos fichas del mismo tercero. Ademas se
    // descarta la cuenta de la familia contraria (un 43x tecleado en una
    // compra): se usa en esa factura, pero no se guarda.
    const learnDirection = isPurchase ? "PURCHASE" as const : "SALE" as const;
    const learnedAccounts = learnAccountsForDirection(
      newData.supplierAccount, newData.expenseAccount, learnDirection,
    );
    const learnParty  = isPurchase ? learnedAccounts.supplierAccount : learnedAccounts.customerAccount;
    const learnResult = isPurchase ? learnedAccounts.expenseAccount  : learnedAccounts.incomeAccount;
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
    // Dos terceros distintos pueden compartir numero (dos proveedores chinos
    // con 418306763): si la fila que hay bajo esta clave es de otro nombre,
    // no la sobreescribimos con los datos de este.
    const existingEntry = learnKey
      ? await prisma.accountEntry.findUnique({
          where: { clientId_nif: { clientId: invoice.clientId, nif: learnKey } },
          select: { nif: true, name: true, intracomGoodsTypePurchase: true, intracomGoodsTypeSale: true },
        })
      : null;
    const otherThirdParty = existingEntry != null && !entryNameMatches(existingEntry, learnName);
    // Bienes/servicios "siempre" para este tercero: solo se guarda si el
    // gestor lo confirmo al validar. Una excepcion (solo esta factura, o
    // distinta de lo asignado) no toca lo aprendido: si no, la siguiente
    // factura de este tercero saldria con el tipo 3/8 o la cuenta 700/705
    // de la excepcion.
    // Va por sentido: un tercero que es proveedor y cliente puede vendernos
    // bienes y comprarnos servicios.
    const goodsLearning = goodsTypeLearning({
      scope: normalizeGoodsTypeScope(data.goodsTypeScope),
      goodsType: intracomGoodsType,
      existingPreference: (isPurchase
        ? existingEntry?.intracomGoodsTypePurchase
        : existingEntry?.intracomGoodsTypeSale) ?? null,
      seenPreference: normalizeGoodsType(data.goodsTypeAssignedSeen),
    });
    const goodsPreference = goodsLearning.preference
      ? (isPurchase
          ? { intracomGoodsTypePurchase: goodsLearning.preference }
          : { intracomGoodsTypeSale: goodsLearning.preference })
      : {};
    if (learnKey && !otherThirdParty && (learnParty || learnResult || newData.operationType)) {
      await prisma.accountEntry.upsert({
        where: { clientId_nif: { clientId: invoice.clientId, nif: learnKey } },
        create: {
          clientId: invoice.clientId,
          nif: learnKey,
          name: learnName || learnNif || learnKey,
          ...learnedAccounts,
          defaultVatRate: learnVatRate != null ? (learnVatRate as any) : null,
          defaultOperationType: newData.operationType,
          defaultRetentionType: learnRetentionType,
          defaultRetentionRate: learnRetentionRate != null ? (learnRetentionRate as any) : null,
          ...goodsPreference,
        },
        update: {
          ...(learnName ? { name: learnName } : {}),
          ...(learnParty ? (isPurchase
            ? { supplierAccount: learnParty }
            : { customerAccount: learnParty }) : {}),
          // La cuenta de resultado de una excepcion (bienes/servicios solo
          // para esta factura) no se aprende: la siguiente factura de este
          // tercero saldria con la 700/705 de la excepcion.
          ...(learnResult && !goodsLearning.isException ? (isPurchase
            ? { expenseAccount: learnResult }
            : { incomeAccount: learnResult }) : {}),
          ...(learnVatRate != null ? { defaultVatRate: learnVatRate as any } : {}),
          ...(goodsLearning.isException ? {} : { defaultOperationType: newData.operationType }),
          ...goodsPreference,
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
  if (err) return err;
  // Sin esto la pagina seguia con el updatedAt de antes de guardar, y el
  // siguiente Guardar o Validar fallaba con "modificada por otro usuario".
  refresh();
  return null;
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
  const back = parseBackHref(formData.get("back"));
  const expectedUpdatedAt = formData.get("updatedAt") as string | null;
  // Lote y estado de ANTES de guardar. Si al validar se cambia el tipo
  // (recibida -> emitida), la factura pasa al otro lote, y la siguiente tiene
  // que salir del lote en el que estaba trabajando el gestor.
  const before = await prisma.invoice.findUnique({
    where: { id },
    select: { status: true, clientId: true, periodMonth: true, periodYear: true, type: true },
  }).catch(() => null);
  const wasValidated = before != null && (before.status === "VALIDATED" || before.status === "EXPORTED");
  // La siguiente se recalcula (otro gestor puede haber validado alguna desde
  // que cargo la pagina), pero con el orden de ANTES de guardar: guardar quita
  // deferredAt y una pospuesta vuelve a su sitio del lote, con lo que la
  // siguiente ya no seria la que anunciaba la pagina. Guardar no cambia las
  // demas, asi que el calculo previo sigue valiendo. Una ya validada no navega.
  const nextId = wasValidated
    ? null
    : await resolveNextId(id, before ? filterFromInvoice(before, bucket) : null, fallbackNext);
  const err = await parseAndSave(id, session.user.id, extractFields(formData), true, expectedUpdatedAt ?? undefined);
  if (err) return err;

  // Correccion de una factura ya validada: se guarda y el gestor se queda en
  // ella (vino a corregirla, no a seguir el lote). Al cliente ya se le aviso
  // la primera vez.
  if (wasValidated) {
    revalidatePath("/dashboard/worker/invoices");
    revalidatePath("/dashboard/admin/invoices");
    revalidatePath("/dashboard/admin/export");
    refresh();
    return null;
  }

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

  // Invalidar el cache de la siguiente factura: Next.js la habia
  // prefetcheado mientras la actual aun estaba PENDING, asi que el
  // contador X/N quedaria desfasado (p.ej. "2/8" en vez de "2/7").
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  goToNext(nextId, bucket, back);
}

/**
 * Siguiente pendiente de la cola (mismo cliente + periodo + tipo + bucket)
 * despues de la actual, o null si no queda ninguna. El id que manda el
 * formulario (calculado al abrir la pagina) solo se usa si la consulta
 * falla: si la consulta dice que no queda ninguna, ese id puede ser una
 * factura que otro gestor ya ha validado mientras tanto.
 */
async function resolveNextId(
  currentId: string,
  filter: QueueFilter | null,
  fallback: string | null,
): Promise<string | null> {
  if (!filter) return fallback || null;
  try {
    return await getNextInQueue(currentId, filter);
  } catch {
    return fallback || null;
  }
}

/** A la siguiente pendiente, conservando la cola y el listado de origen; si
 *  no queda ninguna, de vuelta a ese listado. */
function goToNext(nextId: string | null, bucket: QueueBucket, back: string | null): never {
  const suffix = queueToSearchParams({ bucket, back }).toString();
  if (nextId) redirect(`/dashboard/worker/review/${nextId}${suffix ? `?${suffix}` : ""}`);
  redirect(back ?? "/dashboard/worker/invoices");
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
  const back = parseBackHref(formData.get("back"));

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
  if (accessErr) return accessErr;

  // Posponer una ya validada la mandaria al final del lote y descolocaria las
  // flechas, sin ningun sentido: ya no esta en la cola. Lo mismo el
  // formulario, que solo ofrece Posponer en estos estados.
  if (!NEEDS_REVIEW.includes(invoice.status)) {
    return { error: "Solo se pueden posponer las facturas que están por revisar." };
  }

  // Antes de marcarla: una vez pospuesta es la ultima del lote, y desde ahi
  // la siguiente pendiente daba la vuelta y volvia a la primera del lote en
  // vez de ir a la que sigue a esta.
  const nextId = await resolveNextId(id, filterFromInvoice(invoice, bucket), fallbackNext);
  await prisma.invoice.update({
    where: { id },
    data: { deferredAt: new Date() },
  });

  // Posponer no marca la factura como "hecha" — el contador X/N no
  // cambia. Solo invalidamos las listas para que los lotes muestren el
  // nuevo orden.
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  goToNext(nextId, bucket, back);
}

/**
 * El gestor confirma que la fila del plan de cuentas encontrada por NIF es
 * este mismo tercero aunque el nombre no coincida (A3 corta los nombres, un
 * autonomo sale escrito de otra forma, nombre comercial...). Se le pone a la
 * fila el nombre que el gestor tiene en pantalla (puede haber corregido el del
 * OCR sin guardar): al validar con ese nombre vuelve a aprender. La fila se
 * busca con el NIF y el tipo guardados; el formulario no ofrece el boton si
 * el gestor los ha cambiado. Solo toca AccountEntry; la factura no cambia.
 */
export async function confirmThirdPartyName(invoiceId: string, typedName: string): Promise<ReviewState> {
  try {
    return await applyThirdPartyName(invoiceId, typeof typedName === "string" ? typedName : "");
  } catch (e) {
    console.error("[confirmThirdPartyName]", e);
    return { error: "No se pudo actualizar el plan de cuentas. Inténtalo de nuevo." };
  }
}

async function applyThirdPartyName(invoiceId: string, typedName: string): Promise<ReviewState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      clientId: true, type: true,
      issuerCif: true, issuerCountry: true,
      receiverCif: true, receiverCountry: true,
    },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
  if (accessErr) return accessErr;

  const isSale = invoice.type === "SALE";
  const name = (typedName ?? "").trim().slice(0, 200);
  if (!name) return { error: "Escribe el nombre del tercero antes de confirmar." };
  const key = accountEntryKey(
    isSale ? invoice.receiverCif : invoice.issuerCif,
    name,
    isSale ? invoice.receiverCountry : invoice.issuerCountry,
  );
  if (!key || key.startsWith(NO_RELIABLE_NIF_PREFIX)) {
    return { error: "Este tercero no tiene un NIF fiable: el plan de cuentas lo busca por nombre." };
  }

  try {
    const updated = await prisma.accountEntry.updateMany({
      where: { clientId: invoice.clientId, nif: key },
      data: { name },
    });
    if (updated.count === 0) return { error: "Ese NIF ya no está en el plan de cuentas." };
  } catch (e) {
    console.error("[confirmThirdPartyName]", e);
    return { error: "No se pudo actualizar el plan de cuentas. Inténtalo de nuevo." };
  }

  revalidatePath(`/dashboard/worker/review/${invoiceId}`);
  return null;
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
  const back = parseBackHref(formData.get("back"));

  if (!reason) {
    return { error: "Debes indicar el motivo del rechazo." };
  }

  const validCategories = ["ILLEGIBLE", "INCOMPLETE", "WRONG_PERIOD", "DUPLICATE", "OTHER"];
  if (category && !validCategories.includes(category)) {
    return { error: "Categoría de rechazo no válida." };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { exportBatchItems: { take: 1, select: { id: true } } },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  // Workers can only reject invoices of assigned clients
  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
  if (accessErr) return accessErr;

  // Con las flechas se llega a facturas ya terminadas. Una que ya salio en un
  // Excel esta en la contabilidad de A3: rechazarla aqui no la quita de alli
  // y al cliente le llegaria un rechazo de algo ya contabilizado.
  if (invoice.exportBatchItems.length > 0) {
    return { error: "Esta factura ya se exportó a A3 y no se puede rechazar. Si hay que corregirla, corrígela y vuelve a exportarla." };
  }
  if (invoice.status === "REJECTED") {
    return { error: "Esta factura ya está rechazada." };
  }
  const periodErr = await closedPeriodError(invoice.clientId, [invoicePeriod(invoice)], "rechazar");
  if (periodErr) return periodErr;

  // Condicionado al updatedAt leido: si una exportacion la reservo mientras
  // tanto, no se rechaza una factura que ya esta camino de A3 (F-049).
  const rejected = await prisma.invoice.updateMany({
    where: { id, updatedAt: invoice.updatedAt },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      ...(category ? { rejectionCategory: category as "ILLEGIBLE" | "INCOMPLETE" | "WRONG_PERIOD" | "DUPLICATE" | "OTHER" } : {}),
    },
  });
  if (rejected.count === 0) {
    return { error: appError("ERR-VALIDATE-003", `updatedAt=${invoice.updatedAt.getTime()} al rechazar`) };
  }

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

  const nextId = await resolveNextId(id, filterFromInvoice(invoice, bucket), fallbackNext);
  // Mismo motivo que en validateInvoice: prefetch del siguiente puede
  // tener un contador X/N desfasado tras rechazar la actual.
  if (nextId) revalidatePath(`/dashboard/worker/review/${nextId}`);
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  goToNext(nextId, bucket, back);
}

// ── División multi-ticket ──────────────────────────────────────────────────

/** Periodos que toca una division: el de la original y el del lote, que es
 *  donde se crean las hijas (sin periodo contable). Con este cerrado quedarian
 *  hijas pendientes que no se pueden validar hasta que lo reabran. */
function splitPeriods(
  invoice: Pick<Invoice, "periodMonth" | "periodYear" | "accountingPeriodMonth" | "accountingPeriodYear">,
): { month: number; year: number }[] {
  return [invoicePeriod(invoice), { month: invoice.periodMonth, year: invoice.periodYear }];
}

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
  back?: string | null,
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
    include: { client: true, exportBatchItems: { take: 1, select: { id: true } } },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
  if (accessErr) return accessErr as { error: string };

  // Ya esta en A3 como una sola factura: dividirla aqui dejaria el asiento
  // de alli sin su original.
  if (invoice.exportBatchItems.length > 0) {
    return { error: "Esta factura ya se exportó a A3 y no se puede dividir." };
  }
  // Antes de subir nada: si no, quedarian recortes huerfanos en el almacenamiento.
  const periodErr = await closedPeriodError(invoice.clientId, splitPeriods(invoice), "dividir");
  if (periodErr) return periodErr;

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
        // La hija hereda la moneda: si su recorte no la muestra, el OCR no
        // la veria y el aviso de "no es euro" desapareceria en silencio.
        currency: invoice.currency,
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
  const nextId = await resolveNextId(invoiceId, filterFromInvoice(invoice, parsedBucket), null);

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");

  goToNext(nextId, parsedBucket, parseBackHref(back));
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
  back?: string | null,
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
    include: { client: true, exportBatchItems: { take: 1, select: { id: true } } },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await assertInvoiceAccess(session, invoice.clientId);
  if (accessErr) return accessErr as { error: string };

  // Ya esta en A3 como una sola factura: dividirla aqui dejaria el asiento
  // de alli sin su original.
  if (invoice.exportBatchItems.length > 0) {
    return { error: "Esta factura ya se exportó a A3 y no se puede dividir." };
  }
  // Antes de subir nada: si no, quedarian partes huerfanas en el almacenamiento.
  const periodErr = await closedPeriodError(invoice.clientId, splitPeriods(invoice), "dividir");
  if (periodErr) return periodErr;

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
        // La hija hereda la moneda: si su recorte no la muestra, el OCR no
        // la veria y el aviso de "no es euro" desapareceria en silencio.
        currency: invoice.currency,
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
  const nextId = await resolveNextId(invoiceId, filterFromInvoice(invoice, parsedBucket), null);

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");

  goToNext(nextId, parsedBucket, parseBackHref(back));
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
    currency:      fd.get("currency") as string | null,
    accountingPeriodMonth: fd.get("accountingPeriodMonth") as string ?? "",
    accountingPeriodYear:  fd.get("accountingPeriodYear")  as string ?? "",
    supplierAccount: fd.get("supplierAccount") as string ?? "",
    expenseAccount:  fd.get("expenseAccount")  as string ?? "",
    operationType:   fd.get("operationType")   as string ?? "INTERIOR",
    intracomGoodsType: fd.get("intracomGoodsType") as string ?? "",
    intracomGoodsSource: fd.get("intracomGoodsSource") as string ?? "",
    goodsTypeScope:    fd.get("goodsTypeScope")    as string ?? "",
    goodsTypeAssignedSeen: fd.get("goodsTypeAssignedSeen") as string ?? "",
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
