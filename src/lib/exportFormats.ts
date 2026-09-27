import type { Invoice, Client, InvoiceVatLine } from "@prisma/client";
import * as XLSX from "xlsx";
import {
  OPERATION_TYPE_CODE,
  OPERATION_TYPE_LABEL,
  OPERATION_TYPE_OPTIONS,
  INTRACOM_GOODS_TYPE_LABEL,
  taxIdWithCountry,
  type OperationTypeName,
} from "@/lib/validators";
import { accountDirectionProblem, currencyProblem, missingDataProblems, type RuleInvoice } from "@/lib/invoiceRules";
import { goodsTypeFromSaleAccount } from "@/lib/intracomGoods";
import { invoiceBalanceDiffCents, isInvoiceBalanced } from "@/lib/invoiceBalance";
import { describeVatLineMismatch, vatLineMismatches, type CheckedLine } from "@/lib/vatLineChecks";
import { toCents } from "@/lib/money";
import { formatEur } from "@/lib/format";
import { findNumberingGaps } from "@/lib/invoiceNumbering";
import { isStandardVatRate, isSurchargeRate } from "@/lib/equivalenceSurcharge";
import { exportExclusionReason, type ExportExclusionBox, type ExportExclusionReason } from "@/lib/exportExclusions";

export type ExportFormat = "sage50" | "contasol" | "a3con" | "a3excel";

export type ExportConfig = {
  encoding?: string;    // "utf-8" | "windows-1252"
  delimiter?: string;   // ";" | "," | "\t"
  dateFormat?: string;  // "DD/MM/YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY"
};

export type InvoiceWithClient = Invoice & {
  client: Client;
  /** Cuantas hijas tiene si se dividio: la original no va al Excel. */
  _count?: { splitInvoices?: number };
  /** Desglose por tipo de IVA. Cuando esta presente y tiene >0 elementos,
   *  los exportadores emiten una fila por linea (a3 asesor "repetir fila
   *  cambiando %IVA y cuota"). Cuando esta vacio se cae a los campos
   *  planos de Invoice como linea unica. */
  vatLines?: InvoiceVatLine[];
};

/** Devuelve las lineas a exportar para una factura. Si la factura ya tiene
 *  desglose lo usa; si no, sintetiza una linea unica con los campos planos
 *  (compatibilidad con datos legacy y con los tests). */
type ExportVatLine = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  /** Recargo de equivalencia DE ESTA LINEA (0 si no lleva — a diferencia del
   *  modelo de datos, aqui A3 espera un numero, no un tercer estado null). */
  equivalenceSurchargeRate: number;
  equivalenceSurchargeAmount: number;
};

function getExportLines(inv: InvoiceWithClient): ExportVatLine[] {
  if (inv.vatLines && inv.vatLines.length > 0) {
    return inv.vatLines.map((l) => ({
      taxBase:   Number(l.taxBase),
      vatRate:   Number(l.vatRate),
      vatAmount: Number(l.vatAmount),
      equivalenceSurchargeRate:   l.equivalenceSurchargeRate   ? Number(l.equivalenceSurchargeRate)   : 0,
      equivalenceSurchargeAmount: l.equivalenceSurchargeAmount ? Number(l.equivalenceSurchargeAmount) : 0,
    }));
  }
  return [{
    taxBase:   inv.taxBase   ? Number(inv.taxBase)   : 0,
    vatRate:   inv.vatRate   ? Number(inv.vatRate)   : 0,
    vatAmount: inv.vatAmount ? Number(inv.vatAmount) : 0,
    // Datos legacy sin desglose: no hay donde guardar el recargo por linea.
    equivalenceSurchargeRate: 0,
    equivalenceSurchargeAmount: 0,
  }];
}

/** ¿Todo a 0? Bases, cuotas, recargo y retencion. Solo asi una rectificativa
 *  a cero no tiene nada que llevar a A3 (revision 2 del PR #7). */
const isZeroAmount = (v: number | null | undefined) => v == null || toCents(Number(v)) === 0;

function linesAllZero(inv: InvoiceWithClient): boolean {
  return checkedLines(inv).every((l) =>
    isZeroAmount(l.taxBase) && isZeroAmount(l.vatAmount) && isZeroAmount(l.equivalenceSurchargeAmount));
}

function allAmountsZero(inv: InvoiceWithClient): boolean {
  return linesAllZero(inv) && isZeroAmount(inv.irpfAmount == null ? null : Number(inv.irpfAmount));
}

/** Lineas para vatLineMismatches: como getExportLines, pero sin convertir
 *  en 0 un recargo que no esta (null). Con 0, una cuota de recargo sin % daba
 *  «la base × 0 % da 0,00 €» en el export mientras el formulario callaba. */
function checkedLines(inv: InvoiceWithClient): CheckedLine[] {
  if (!inv.vatLines || inv.vatLines.length === 0) return getExportLines(inv);
  return inv.vatLines.map((l) => ({
    taxBase: Number(l.taxBase),
    vatRate: Number(l.vatRate),
    vatAmount: Number(l.vatAmount),
    equivalenceSurchargeRate: l.equivalenceSurchargeRate == null ? null : Number(l.equivalenceSurchargeRate),
    equivalenceSurchargeAmount: l.equivalenceSurchargeAmount == null ? null : Number(l.equivalenceSurchargeAmount),
  }));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null | undefined, dateFormat?: string): string {
  if (!d) return "";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();

  switch (dateFormat) {
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    case "MM/DD/YYYY": return `${mm}/${dd}/${yyyy}`;
    default:           return `${dd}/${mm}/${yyyy}`;
  }
}

/** Convert Prisma Decimal / number / null → "1.234,56" (Spanish format) */
function fmtAmt(v: unknown): string {
  if (v === null || v === undefined) return "0,00";
  return Number(v).toFixed(2).replace(".", ",");
}

function fmtPct(v: unknown): string {
  if (v === null || v === undefined) return "0,00";
  return Number(v).toFixed(2).replace(".", ",");
}

// ─── type codes ─────────────────────────────────────────────────────────────

function typeCode(type: string, format: ExportFormat): string {
  if (format === "a3con")    return type === "PURCHASE" ? "1" : "2";
  if (format === "contasol") return type === "PURCHASE" ? "C" : "V";
  return type === "PURCHASE" ? "R" : "E"; // sage50: R = recibida, E = emitida
}

// ─── headers ────────────────────────────────────────────────────────────────

const HEADERS: Record<ExportFormat, string[]> = {
  sage50: [
    "Tipo", "Fecha", "Nº Factura", "Nombre / Razón social", "NIF/CIF",
    "Base Imponible", "% IVA", "Cuota IVA", "% IRPF", "Cuota IRPF", "Total Factura",
  ],
  contasol: [
    "Tipo", "Fecha", "Número", "Proveedor / Cliente", "CIF",
    "Base1", "%IVA1", "CuotaIVA1", "%IRPF", "CuotaIRPF", "Total",
  ],
  a3con: [
    "Tipo", "Fecha", "Numero Factura", "CIF", "Razon Social",
    "Base Imponible", "Tipo IVA", "Cuota IVA", "Importe Total",
  ],
  a3excel: [], // A3 Excel uses its own headers in generateA3Excel()
};

// ─── row builder ─────────────────────────────────────────────────────────────

/** Construye una fila CSV para una linea de IVA concreta. Multi-IVA:
 *  llamamos varias veces con la misma factura cambiando solo la linea. */
function buildRow(
  inv: InvoiceWithClient,
  line: ExportVatLine,
  isFirstLine: boolean,
  format: ExportFormat,
  config?: ExportConfig,
): string[] {
  const tipo      = typeCode(inv.type, format);
  const fecha     = fmtDate(inv.invoiceDate, config?.dateFormat);
  const numero    = inv.invoiceNumber ?? "";
  const nombre    = inv.issuerName ?? "";
  const cif       = inv.issuerCif ?? "";
  const base      = fmtAmt(line.taxBase);
  const pctIva    = fmtPct(line.vatRate);
  const cuotaIva  = fmtAmt(line.vatAmount);
  // IRPF y total solo en la primera linea para que la suma cuadre
  // (a3 asesor importa el total una sola vez).
  const pctIrpf   = isFirstLine ? fmtPct(inv.irpfRate)    : "0,00";
  const cuotaIrpf = isFirstLine ? fmtAmt(inv.irpfAmount)  : "0,00";
  const total     = isFirstLine ? fmtAmt(inv.totalAmount) : "0,00";

  switch (format) {
    case "sage50":
      return [tipo, fecha, numero, nombre, cif, base, pctIva, cuotaIva, pctIrpf, cuotaIrpf, total];
    case "contasol":
      return [tipo, fecha, numero, nombre, cif, base, pctIva, cuotaIva, pctIrpf, cuotaIrpf, total];
    case "a3con":
      // a3con: aligned with A3 template (no IRPF)
      return [tipo, fecha, numero, cif, nombre, base, pctIva, cuotaIva, total];
    case "a3excel":
      // a3excel uses generateA3Excel(), not CSV row builder
      return [tipo, fecha, numero, cif, nombre, base, pctIva, cuotaIva, total];
  }
}

// ─── main export ─────────────────────────────────────────────────────────────

export function generateCsv(
  invoices: InvoiceWithClient[],
  format: ExportFormat,
  config?: ExportConfig,
): string {
  const SEP = config?.delimiter ?? ";";
  const header = HEADERS[format].join(SEP);
  const rows: string[] = [];
  for (const inv of invoices) {
    const lines = getExportLines(inv);
    lines.forEach((line, i) => {
      rows.push(buildRow(inv, line, i === 0, format, config).join(SEP));
    });
  }
  // BOM so Excel opens with correct encoding
  return "\uFEFF" + [header, ...rows].join("\r\n");
}

export function suggestFilename(
  invoices: InvoiceWithClient[],
  format: ExportFormat,
  month: number,
  year: number,
): string {
  return exportFilename(invoices[0]?.client.name ?? null, format, month, year);
}

/** Nombre del fichero de un export a partir del cliente y el periodo. Lo usa
 *  tambien "Volver a descargar", que ya no tiene las facturas a mano. */
export function exportFilename(
  clientName: string | null,
  format: ExportFormat,
  month: number,
  year: number,
): string {
  const name = clientName?.replace(/\s+/g, "_") ?? "cliente";
  const mm = String(month).padStart(2, "0");
  return `facturas_${name}_${year}-${mm}_${format}.${exportExtension(format)}`;
}

export function exportExtension(format: ExportFormat): "xlsx" | "csv" {
  return format === "a3excel" ? "xlsx" : "csv";
}

// ─── A3 Excel export (.xlsx) ────────────────────────────────────────────────

// Cabeceras EXACTAS de la plantilla oficial A3 (Libro_de_Facturas_*).
// Mantenemos los typos del original ("Cutoa") para que el mapeo en el
// wizard A3 sea por nombre y no tengamos que cambiarlo. 16 columnas
// totales — la columna B "Fecha de Contabilizacion" es la obligatoria
// según el cliente, A "Fecha de Expedición" puede ir en blanco.
const A3_HEADERS = [
  "Fecha de Expedición",         // A — opcional, se puede dejar en blanco
  "Fecha de Contabilizacion",    // B — OBLIGATORIA, sin tilde en plantilla
  "Concepto",                    // C
  "Numero Factura",              // D
  "Nif",                         // E — plantilla usa "Nif" con minúsculas
  "Nombre",                      // F
  "Tipo de Operación",           // G
  "Cuenta Cliente/Proveedor",    // H
  "Cuenta de Compras/Ventas",    // I
  "Base",                        // J
  "% IVA",                       // K
  "Cuota IVA",                   // L
  "% Rec. Equiv.",               // M
  "Cutoa Rec. Equiv.",           // N — sic, "Cutoa" con typo igual que plantilla
  "% Retención IRPF",            // O
  "Cuota Retención IRPF",        // P
];

function buildA3Row(
  inv: InvoiceWithClient,
  line: ExportVatLine,
  isFirstLine: boolean,
  config?: ExportConfig,
): (string | number | null)[] {
  const isPurchase = inv.type === "PURCHASE";
  // NIF y pais SIEMPRE del mismo lado: en una venta el NIF sale del receptor,
  // asi que el pais tiene que ser receiverCountry (issuerCountry es el del
  // propio cliente y vale null). Se calculan juntos para que no se despareje.
  const terceroCif     = isPurchase ? inv.issuerCif     : inv.receiverCif;
  const terceroCountry = isPurchase ? inv.issuerCountry : inv.receiverCountry;
  // Codigo numerico de tipo de operacion para A3. Si por algun motivo
  // viene null/desconocido, caemos a 1 (Interior) que es el caso comun.
  const opTypeCode = inv.operationType
    ? OPERATION_TYPE_CODE[inv.operationType as OperationTypeName] ?? 1
    : 1;
  // Retencion IRPF: solo se emite en la PRIMERA fila del multi-IVA para
  // que A3 no sume varias veces. En las filas siguientes va a 0.
  // Para rectificativas, la retencion respeta el signo de la base.
  const retentionRate   = isFirstLine && inv.irpfRate   ? Number(inv.irpfRate)   : 0;
  const retentionAmount = isFirstLine && inv.irpfAmount ? Number(inv.irpfAmount) : 0;
  // Recargo de equivalencia: a diferencia de la retencion, va POR LINEA (cada
  // tipo de IVA puede llevar su propio recargo, o ninguno) — no se limita a
  // la primera fila del multi-IVA.
  const surchargeRate   = line.equivalenceSurchargeRate;
  const surchargeAmount = line.equivalenceSurchargeAmount;
  // Fecha de Contabilizacion (col B): obligatoria segun plantilla A3.
  // Por defecto = fecha de la factura. El gestor puede sobreescribirla
  // en el Excel exportado si quiere registrar el asiento en otro mes.
  const fechaFactura = fmtDate(inv.invoiceDate, config?.dateFormat);
  // Sufijo _R en facturas rectificativas: A3 no permite importar dos
  // facturas con mismo NIF + numero, asi que la rectificativa lleva
  // siempre _R para diferenciarla de la original sin colisionar.
  const baseNumber = inv.invoiceNumber ?? "";
  const exportNumber = inv.isRectificative && baseNumber
    ? `${baseNumber}_R`
    : baseNumber;
  return [
    fechaFactura,                                              // A: Fecha expedición (opcional)
    fechaFactura,                                              // B: Fecha contabilización (OBLIGATORIA)
    exportNumber,                                              // C: Concepto
    exportNumber,                                              // D: Numero factura (con _R si rectificativa)
    taxIdWithCountry(terceroCif, terceroCountry),              // E: NIF (con prefijo de pais: A3 lo exige)
    (isPurchase ? inv.issuerName : inv.receiverName) ?? "",   // F: Nombre
    opTypeCode,                                                // G: Tipo operación (1/2/3/4/6/7/8)
    inv.supplierAccount ?? "",                                 // H: Cuenta proveedor/cliente
    inv.expenseAccount ?? "",                                  // I: Cuenta compras/ventas
    line.taxBase,                                              // J: Base (signo respetado en rectificativa)
    line.vatRate,                                              // K: % IVA
    line.vatAmount,                                            // L: Cuota IVA (signo respetado)
    surchargeRate,                                              // M: % Rec. Equiv.
    surchargeAmount,                                            // N: Cutoa Rec. Equiv.
    retentionRate,                                             // O: % Retención IRPF
    retentionAmount,                                           // P: Cuota Retención IRPF
  ];
}

export type A3Severity = "bloqueante" | "aviso" | "fuera";

export type A3ValidationWarning = {
  invoiceId: string;
  invoiceNumber: string | null;
  /** bloqueante: no entra en el fichero ni se marca como exportada hasta que
   *  se corrija. fuera: tampoco entra, pero no hay nada que corregir (la
   *  original de una division, una rectificativa a cero); su texto va en
   *  warnings. aviso: entra, pero conviene mirarlo. */
  severity: A3Severity;
  /** Por que se queda fuera (vacio si solo tiene avisos). */
  blockers: string[];
  /** Lo que conviene mirar pero no impide exportarla. */
  warnings: string[];
  /** Lleva un aviso de salto de numeracion: solo lo calcula el export, asi
   *  que la vista previa lo manda siempre, aunque recorte los demas avisos. */
  numberingGap?: boolean;
};

function ruleInvoice(inv: InvoiceWithClient): RuleInvoice {
  const isPurchase = inv.type === "PURCHASE";
  return {
    type: isPurchase ? "PURCHASE" : "SALE",
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    totalAmount: inv.totalAmount == null ? null : Number(inv.totalAmount),
    irpfAmount: inv.irpfAmount == null ? null : Number(inv.irpfAmount),
    lines: getExportLines(inv),
    isRectificative: Boolean(inv.isRectificative),
    thirdPartyTaxId: isPurchase ? inv.issuerCif : inv.receiverCif,
    thirdPartyCountry: (isPurchase ? inv.issuerCountry : inv.receiverCountry) ?? null,
    operationType: inv.operationType ?? null,
    supplierAccount: inv.supplierAccount,
    expenseAccount: inv.expenseAccount,
    simplifiedSupplierAccount: inv.client?.simplifiedSupplierAccount ?? null,
    currency: inv.currency ?? null,
  };
}

/**
 * Lo que impide exportar una factura (F-025): los mismos datos minimos que
 * exige validar (invoiceRules). Una validada antes de estas reglas puede no
 * tenerlos: se queda fuera del fichero y sin marcar, igual que las de total
 * 0, hasta que se corrija.
 *
 * El descuadre NO bloquea a proposito: las validadas antes del PR #7 se
 * validaron con una tolerancia de 2 centimos, y A3 no recibe el total
 * (calcula el asiento con base, cuota y retencion), asi que el fichero sale
 * bien. Se queda como aviso.
 *
 * El NIF usa el mismo texto que validar (con la pista de la cuenta generica),
 * para no confundirlo con el aviso «Sin NIF: en esta operación no es
 * obligatorio...» de las que pueden ir sin el.
 */
export function a3BlockingProblems(inv: InvoiceWithClient): string[] {
  const rule = ruleInvoice(inv);
  const isPurchase = rule.type === "PURCHASE";
  const blockers: string[] = [];
  const currency = currencyProblem(rule);
  if (currency) blockers.push(`Importes en ${inv.currency}: A3 solo admite euros. Conviértelos y márcala en euros en la revisión`);
  for (const problem of missingDataProblems(rule)) {
    switch (problem.rule) {
      case "sin_nif":
      case "sin_nif_iva":
        // El export solo lo usa un administrador: no puede mandarle a
        // «pedir a un administrador» que configure la generica.
        blockers.push(problem.message
          .replace("pide a un administrador que configure la cuenta genérica del cliente", "configura la cuenta genérica en la ficha del cliente y ponla en la factura desde la revisión")
          .replace(/\.$/, ""));
        break;
      case "sin_numero":
        blockers.push("Número de factura vacío");
        break;
      case "sin_fecha":
        blockers.push("Fecha vacía");
        break;
      case "sin_lineas":
        blockers.push("Sin líneas de IVA con base distinta de 0");
        break;
      case "sin_total":
        blockers.push("Total vacío");
        break;
      case "sin_cuentas":
        if (!inv.supplierAccount?.trim()) blockers.push(isPurchase ? "Sin cuenta proveedor" : "Sin cuenta cliente");
        if (!inv.expenseAccount?.trim()) blockers.push(isPurchase ? "Sin cuenta gasto" : "Sin cuenta ingreso");
        break;
    }
  }
  return blockers;
}

/**
 * Revisa las facturas antes de exportar. Entradas de las facturas con algo
 * que decir, con su severidad: «bloqueante» (no entra en el fichero hasta
 * que se corrija), «aviso» (entra) o «fuera» (no entra y no hay nada que
 * corregir: la original de una division, una rectificativa todo a cero).
 * Primero las bloqueantes, luego los avisos y al final las de fuera; dentro
 * de cada una, en el orden de las facturas. Sin recortar: eso lo hace la
 * vista previa. Casi siempre es una entrada por factura; una «fuera» con un
 * salto de numeracion da dos: la gris y un aviso aparte con el salto, que
 * dice que esa factura no va al Excel.
 */
export function validateForA3Export(invoices: InvoiceWithClient[]): A3ValidationWarning[] {
  const results: A3ValidationWarning[] = [];

  for (const inv of invoices) {
    // Lo que no hace falta llevar a A3 no se revisa ni va a la caja roja
    // (revision 1 del PR #7): la original de una division (van sus hijas) y
    // una rectificativa a cero (A3 no acepta importes cero).
    const outside = a3ExclusionReason(inv);
    if (a3ExclusionBox(inv) === "fuera") {
      results.push({
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, severity: "fuera", blockers: [],
        warnings: [outside === "dividida"
          ? "Es la original de una división: van al Excel las facturas que salieron de ella, no esta"
          : "Rectificativa con total 0: no va al Excel (A3 no acepta importes cero)"],
      });
      continue;
    }
    const blockers = a3BlockingProblems(inv);
    const warnings: string[] = [];
    const isPurchase = inv.type === "PURCHASE";
    const nif = isPurchase ? inv.issuerCif : inv.receiverCif;
    const country = isPurchase ? inv.issuerCountry : inv.receiverCountry;

    // Sin NIF donde no es obligatorio (ventas nacionales, importaciones,
    // inversion del sujeto pasivo, tickets con la cuenta generica) no
    // bloquea: se avisa. En intracomunitarias si bloquea (NIF-IVA, arriba).
    if (!nif && !blockers.some((b) => b.includes("NIF"))) {
      warnings.push("Sin NIF: en esta operación no es obligatorio, pero irá a A3 sin NIF");
    }

    // El codigo de la columna G sale de un mapa unico compartido por las dos
    // hojas, pero en expedidas los codigos significan otra cosa: el 4 es
    // "operacion triangular", no inversion del sujeto pasivo. Una venta con
    // un tipo heredado del aprendizaje por NIF (que no distingue sentido)
    // entraria mal en el 303/349 sin que nadie lo vea. Avisamos hasta que el
    // mapa este bifurcado por sentido.
    if (!isPurchase && inv.operationType
        && !OPERATION_TYPE_OPTIONS.SALE.includes(inv.operationType as OperationTypeName)) {
      warnings.push(
        `Tipo de operación "${OPERATION_TYPE_LABEL[inv.operationType as OperationTypeName]}" no es válido en facturas emitidas `
        + `(exportaría el código ${OPERATION_TYPE_CODE[inv.operationType as OperationTypeName]}, que en expedidas significa otra cosa)`,
      );
    }

    // Intracomunitaria con IVA declarado: mismo aviso que en revision, pero
    // aqui es la ultima linea de defensa antes de que el fichero salga hacia
    // A3. No bloqueamos el export (el gestor puede tener un motivo real),
    // pero no debe poder pasar inadvertido.
    const isIntracomOp = inv.operationType === "INTRACOM" || inv.operationType === "INTRACOM_SERVICIOS";
    if (isIntracomOp) {
      const lines = getExportLines(inv);
      const sumVat = lines.reduce((s, l) => s + l.vatAmount, 0);
      if (Math.abs(sumVat) > 0.01) {
        warnings.push("Operación intracomunitaria con IVA declarado (debería ir a 0%)");
      }
      // Sin pais en el NIF (la portuguesa que imprime "NIF 515160873" a
      // secas) es bloqueante: lo pone a3BlockingProblems (sin_nif_iva).
    }
    // Prefijo extranjero con operacion Interior: el NIF sale con prefijo pero
    // la columna G va a 1, y el 303/349 sale mal. Uno de los dos esta mal.
    // Sin tipo de operacion, buildA3Row emite el codigo 1 (Interior): para
    // este aviso cuenta igual que si lo llevara puesto.
    if (country && country.trim() !== "ES" && (!inv.operationType || inv.operationType === "INTERIOR")) {
      warnings.push(
        `NIF con prefijo extranjero (${country.trim()}) pero tipo de operación Interior: `
        + "revisa cuál de los dos está mal antes de exportar",
      );
    }

    // Venta intracomunitaria sin clasificar bienes/servicios: necesaria para
    // la Clave del modelo 349. No bloquea el export (nuestro formato A3
    // actual no tiene una columna para transmitirla — ver nota en
    // generateA3Excel), pero debe quedar visible para que el gestor la
    // resuelva antes de declarar el 349 aparte.
    if (!isPurchase && inv.operationType === "INTRACOM" && !inv.intracomGoodsType) {
      warnings.push("Venta intracomunitaria sin clasificar como bienes/servicios (necesario para el modelo 349)");
    }
    // En ventas la cuenta de ingreso es la que distingue bienes (700) de
    // servicios (705): si no cuadra con lo marcado, A3 lo contabiliza mal.
    if (!isPurchase && inv.operationType === "INTRACOM" && inv.intracomGoodsType) {
      const goodsFromAccount = goodsTypeFromSaleAccount(inv.expenseAccount);
      if (goodsFromAccount && goodsFromAccount !== inv.intracomGoodsType) {
        warnings.push(
          `Venta intracomunitaria marcada como ${INTRACOM_GOODS_TYPE_LABEL[inv.intracomGoodsType].toLowerCase()} `
          + `con la cuenta ${inv.expenseAccount}: los bienes van a la 700 y los servicios a la 705`,
        );
      }
    }

    // Se queda fuera del fichero (ver a3ExclusionReason): no se marca como
    // exportada y sigue pendiente hasta que se corrija.
    const totalNum = Number(inv.totalAmount ?? 0);
    if (outside === "total_cero") {
      // Una rectificativa a cero con importes (-100 al 21 % y +110 al 10 %)
      // cuadra, pero A3 nunca recibiria esos importes del 303. Si A3 admite
      // filas con base y total 0 esta pendiente del asesor: hasta entonces se
      // queda fuera y el texto dice que hacer con ella.
      blockers.unshift(!inv.isRectificative
        ? "Total = 0: no entra en el Excel ni se marca como exportada (A3 no acepta importes cero). Corrígela en la revisión"
        : linesAllZero(inv)
          // Lineas a 0 y retencion: 0 − retencion no es 0, no cuadra.
          ? `Rectificativa con total 0 pero con retención de ${formatEur(Math.abs(Number(inv.irpfAmount ?? 0)))}: no cuadra; corrígela en la revisión`
          : "Rectificativa con total 0 pero con importes en las líneas: A3 no admite total 0; regístrala a mano en A3. "
            + "Si ya la has registrado, no la registres otra vez: seguirá saliendo aquí");
    }

    // Un "tipo de IVA" que en realidad es el del recargo (5,2 / 1,4 / 0,5)
    // es el recargo colado como una linea de IVA mas. La factura cuadra igual
    // con el total, asi que ningun otro aviso lo ve, pero A3 se trae un IVA
    // que no existe (paso con 6 facturas, 3 ya exportadas).
    const tiposRaros = Array.from(new Set(
      getExportLines(inv).map((l) => l.vatRate).filter((r) => !isStandardVatRate(r)),
    ));
    if (tiposRaros.length > 0) {
      warnings.push(
        `Tipo de IVA no habitual (${tiposRaros.map((r) => `${r}%`).join(", ")})`
        + (tiposRaros.some(isSurchargeRate)
            ? ": parece el recargo de equivalencia metido como línea de IVA"
            : ""),
      );
    }

    // Cada cuota tiene que ser su base × % (F-022): el total no lo ve si las
    // cuotas estan cruzadas entre tipos, y A3 se lleva el desglose tal cual.
    for (const m of vatLineMismatches(checkedLines(inv), inv.operationType)) {
      warnings.push(describeVatLineMismatch(m));
    }
    // Cuota de recargo sin %: vatLineMismatches no la mira (no hay % con el
    // que comparar), pero a A3 le llegaria M = 0 y N = la cuota.
    checkedLines(inv).forEach((l, i) => {
      if (l.equivalenceSurchargeRate == null && l.equivalenceSurchargeAmount != null && toCents(l.equivalenceSurchargeAmount) !== 0) {
        warnings.push(`Línea ${i + 1}: cuota de recargo sin %: A3 recibirá 0 %`);
      }
    });

    // Cuentas del sentido contrario: validar ya no lo deja, pero una validada
    // antes de la regla pasaria sin que nadie lo vea. Aviso, no bloqueo: en
    // produccion no hay ninguna y el asiento puede ser intencionado.
    const direction = accountDirectionProblem(ruleInvoice(inv));
    // Sin el punto final, como los demas avisos: se unen con «; ».
    if (direction) warnings.push(direction.message.replace(/\.$/, ""));

    // Base + IVA + Recargo - IRPF = Total. Suma sobre las lineas si las hay.
    if (inv.totalAmount && Math.abs(totalNum) >= 0.005) {
      const lines = getExportLines(inv);
      const sumBase = lines.reduce((s, l) => s + l.taxBase, 0);
      const sumAmt  = lines.reduce((s, l) => s + l.vatAmount, 0);
      const sumSurcharge = lines.reduce((s, l) => s + l.equivalenceSurchargeAmount, 0);
      const irpf    = inv.irpfAmount ? Number(inv.irpfAmount) : 0;
      if (Math.abs(sumBase) > 0 || Math.abs(sumAmt) > 0) {
        const balance = { sumBase, sumAmount: sumAmt, sumSurcharge, irpf, total: totalNum };
        if (!isInvoiceBalanced(balance)) {
          warnings.push(`Descuadre Base+IVA vs Total: ${formatEur(Math.abs(invoiceBalanceDiffCents(balance)) / 100)}`);
        }
      }
    }

    if (blockers.length > 0 || warnings.length > 0) {
      results.push({
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
        severity: blockers.length > 0 ? "bloqueante" : "aviso",
        blockers, warnings,
      });
    }
  }

  // Huecos en la numeracion: SOLO en emitidas.
  //
  // Las emitidas las numera el propio cliente y tienen que ir correlativas,
  // asi que un salto es una factura que falta o un numero que se salto al
  // emitirla. En las recibidas no: cada proveedor numera para TODOS sus
  // clientes a la vez, asi que entre dos facturas suyas hay saltos siempre
  // (Galma le factura a un monton de tiendas y entre una suya y la siguiente
  // se cuelan 30 de otras). Avisar de eso era ruido en cada exportacion.
  // Confirmado por el asesor el 2026-09-24.
  //
  // Se agrupa por emisor, que en emitidas es el propio cliente: una asesoria
  // exporta varios clientes a la vez y cada uno lleva su numeracion. Sin NIF
  // no hay grupo fiable (la falta de NIF ya se avisa o bloquea por separado).
  // Map en vez de results.find: con miles de facturas era cuadratico.
  const byInvoiceId = new Map(results.map((r) => [r.invoiceId, r]));
  const bySeries = new Map<string, InvoiceWithClient[]>();
  for (const inv of invoices) {
    if (inv.type !== "SALE") continue;
    if (!inv.issuerCif) continue;
    const list = bySeries.get(inv.issuerCif) ?? [];
    list.push(inv);
    bySeries.set(inv.issuerCif, list);
  }
  for (const group of bySeries.values()) {
    const gaps = findNumberingGaps(group.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber })));
    for (const [invoiceId, gap] of gaps) {
      const inv = group.find((i) => i.id === invoiceId)!;
      const shown = gap.missing.slice(0, 5);
      const list = shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}`
        : shown[0];
      const more = gap.missing.length > shown.length ? ` (y ${gap.missing.length - shown.length} más)` : "";
      const who = `${inv.issuerName ?? "el emisor"} (${inv.issuerCif})`;
      const warning =
        `Salto de numeración en las facturas emitidas de ${who}: entre la ${gap.previousNumber} y la ${inv.invoiceNumber} `
        + `${gap.missing.length === 1 ? "falta la factura" : "faltan las facturas"} ${list}${more}. `
        + `Revisa si falta subirla o si se saltó el número al emitirla`;
      const existing = byInvoiceId.get(invoiceId);
      // De una «fuera» no puede colgar: saldria en la caja gris, bajo «no hay
      // nada que corregir». Va en una entrada de aviso aparte.
      if (existing && existing.severity !== "fuera") {
        existing.warnings.push(warning);
        existing.numberingGap = true;
      } else {
        // La de la caja ambar se exporta igualmente, salvo esta: se dice.
        const text = existing ? `No va al Excel (sale abajo, en gris). ${warning}` : warning;
        const entry: A3ValidationWarning = {
          invoiceId, invoiceNumber: inv.invoiceNumber, severity: "aviso", blockers: [], warnings: [text], numberingGap: true,
        };
        results.push(entry);
        if (!existing) byInvoiceId.set(invoiceId, entry);
      }
    }
  }

  // En el orden de las facturas: las entradas de los saltos se anadian al
  // final y el recorte de la vista previa se las llevaba las primeras.
  const position = new Map(invoices.map((inv, i) => [inv.id, i]));
  results.sort((a, b) => (position.get(a.invoiceId) ?? 0) - (position.get(b.invoiceId) ?? 0));

  // Estable: dentro de cada gravedad se mantiene el orden de las facturas.
  return [
    ...results.filter((r) => r.severity === "bloqueante"),
    ...results.filter((r) => r.severity === "aviso"),
    ...results.filter((r) => r.severity === "fuera"),
  ];
}

/**
 * Por que una factura se queda fuera del Excel de A3, o null si entra:
 *  - total_cero: A3 rechaza asientos de importe cero (puede pasar cuando una
 *    rectificativa anula exactamente a la original y se exportan juntas).
 *  - dividida: es la original de una division; van las facturas que
 *    salieron de ella, o contaria dos veces.
 *  - bloqueante: le falta algo de a3BlockingProblems (F-025).
 */
export function a3ExclusionReason(inv: InvoiceWithClient): ExportExclusionReason | null {
  return exportExclusionReason(inv) ?? (a3BlockingProblems(inv).length > 0 ? "bloqueante" : null);
}

/** En que caja va una excluida (ver ExportExclusionBox), o null si entra en
 *  el fichero. Es la misma decision que da severidad «fuera» en
 *  validateForA3Export. */
export function a3ExclusionBox(inv: InvoiceWithClient): ExportExclusionBox | null {
  const reason = a3ExclusionReason(inv);
  if (!reason) return null;
  if (reason === "dividida") return "fuera";
  if (reason === "total_cero" && inv.isRectificative && allAmountsZero(inv)) return "fuera";
  // Rectificativa a cero con importes en las lineas: cuadra y no hay nada que
  // corregir, pero A3 no la admite (pendiente del asesor): a mano.
  if (reason === "total_cero" && inv.isRectificative && !linesAllZero(inv)) return "a_mano";
  return "corregir";
}

/**
 * Separa lo que entra en el Excel de lo que no. La usan el generador y la
 * ruta de exportacion: solo lo que va en el fichero se marca como exportado
 * y entra en el lote (F-009).
 */
export function partitionA3Exportable<T extends InvoiceWithClient>(
  invoices: T[],
): { exportable: T[]; excluded: { invoice: T; reason: ExportExclusionReason }[] } {
  const exportable: T[] = [];
  const excluded: { invoice: T; reason: ExportExclusionReason }[] = [];
  for (const invoice of invoices) {
    const reason = a3ExclusionReason(invoice);
    if (reason) excluded.push({ invoice, reason });
    else exportable.push(invoice);
  }
  return { exportable, excluded };
}

/** Generate A3 Excel workbook as Buffer */
export function generateA3Excel(
  invoices: InvoiceWithClient[],
  config?: ExportConfig,
): Buffer {
  const wb = XLSX.utils.book_new();

  // Las excluidas (ver a3ExclusionReason) no salen en el fichero; el gestor
  // las ve antes en los avisos de validateForA3Export.
  const { exportable } = partitionA3Exportable(invoices);

  const purchases = exportable.filter((i) => i.type === "PURCHASE");
  const sales = exportable.filter((i) => i.type === "SALE");

  const makeSheet = (items: InvoiceWithClient[]) => {
    // A3: una fila por linea de IVA. Para multi-IVA, todo se repite igual
    // (NIF, fecha, num factura...) excepto Base/%IVA/Cuota. La retencion
    // IRPF se emite SOLO en la primera fila para no sumar varias veces.
    const rows: (string | number | null)[][] = [];
    for (const inv of items) {
      const exportLines = getExportLines(inv);
      exportLines.forEach((line, i) => {
        rows.push(buildA3Row(inv, line, i === 0, config));
      });
    }
    const ws = XLSX.utils.aoa_to_sheet([A3_HEADERS, ...rows]);

    // Set column widths (16 cols, alineadas con plantilla A3 oficial)
    ws["!cols"] = [
      { wch: 16 }, // A: Fecha expedición
      { wch: 16 }, // B: Fecha contabilización
      { wch: 20 }, // C: Concepto
      { wch: 16 }, // D: Nº Factura
      { wch: 16 }, // E: Nif (cabe un VAT con prefijo, p.ej. FR + 11 digitos)
      { wch: 30 }, // F: Nombre
      { wch: 12 }, // G: Tipo op.
      { wch: 16 }, // H: Cuenta cli/prov
      { wch: 16 }, // I: Cuenta compras/ventas
      { wch: 12 }, // J: Base
      { wch: 8 },  // K: % IVA
      { wch: 12 }, // L: Cuota IVA
      { wch: 10 }, // M: % Rec. Equiv.
      { wch: 12 }, // N: Cutoa Rec. Equiv.
      { wch: 12 }, // O: % Retención IRPF
      { wch: 14 }, // P: Cuota Retención IRPF
    ];

    return ws;
  };

  if (purchases.length > 0) {
    XLSX.utils.book_append_sheet(wb, makeSheet(purchases), "Facturas recibidas");
  }
  if (sales.length > 0) {
    XLSX.utils.book_append_sheet(wb, makeSheet(sales), "Facturas expedidas");
  }

  // If no invoices of either type, create an empty sheet
  if (purchases.length === 0 && sales.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([A3_HEADERS]), "Facturas");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
