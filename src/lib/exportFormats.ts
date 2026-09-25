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
import { isForeignCurrency } from "@/lib/currency";
import { goodsTypeFromSaleAccount } from "@/lib/intracomGoods";
import { invoiceBalanceDiffCents } from "@/lib/invoiceBalance";
import { formatEur } from "@/lib/format";
import { findNumberingGaps } from "@/lib/invoiceNumbering";
import { isStandardVatRate, isSurchargeRate } from "@/lib/equivalenceSurcharge";

export type ExportFormat = "sage50" | "contasol" | "a3con" | "a3excel";

export type ExportConfig = {
  encoding?: string;    // "utf-8" | "windows-1252"
  delimiter?: string;   // ";" | "," | "\t"
  dateFormat?: string;  // "DD/MM/YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY"
};

export type InvoiceWithClient = Invoice & {
  client: Client;
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
  const clientName = invoices[0]?.client.name.replace(/\s+/g, "_") ?? "cliente";
  const mm = String(month).padStart(2, "0");
  const ext = format === "a3excel" ? "xlsx" : "csv";
  return `facturas_${clientName}_${year}-${mm}_${format}.${ext}`;
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

export type A3ValidationWarning = {
  invoiceId: string;
  invoiceNumber: string | null;
  warnings: string[];
};

/** Validate invoices before A3 export, returns warnings (non-blocking) */
export function validateForA3Export(invoices: InvoiceWithClient[]): A3ValidationWarning[] {
  const results: A3ValidationWarning[] = [];

  for (const inv of invoices) {
    const warnings: string[] = [];
    const isPurchase = inv.type === "PURCHASE";
    const nif = isPurchase ? inv.issuerCif : inv.receiverCif;
    const country = isPurchase ? inv.issuerCountry : inv.receiverCountry;

    if (!nif) warnings.push("NIF vacío");

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
    if (!inv.invoiceDate) warnings.push("Fecha vacía");
    if (!inv.supplierAccount) warnings.push(isPurchase ? "Sin cuenta proveedor" : "Sin cuenta cliente");
    if (!inv.expenseAccount) warnings.push(isPurchase ? "Sin cuenta gasto" : "Sin cuenta ingreso");

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
      // El pais solo se detecta si el prefijo venia IMPRESO en la factura.
      // Una portuguesa que ponga "NIF 515160873" a secas se guarda sin pais y
      // sale sin prefijo, que es justo lo que A3 rechaza. El gestor lo arregla
      // tecleando el prefijo en la revision (parseTaxId lo vuelve a separar).
      if (!country || country.trim() === "ES") {
        warnings.push(
          "Operación intracomunitaria sin país en el NIF: A3 la rechazará "
          + "(«el NIF no existe en la tabla»). Corrige el NIF en la revisión con su prefijo, p.ej. PT515160873",
        );
      }
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

    if (isForeignCurrency(inv.currency)) {
      warnings.push(`Importes en ${inv.currency}: A3 solo admite euros. Conviértelos y márcala en euros en la revisión`);
    }

    // Total = 0: A3 rechaza asientos de valor cero. Lo marcamos como
    // warning serio para que el gestor o lo corrija o lo excluya del
    // export. En `generateA3Excel` se filtra fuera automáticamente.
    const totalNum = Number(inv.totalAmount ?? 0);
    if (Math.abs(totalNum) < 0.005) {
      warnings.push("Total = 0 (excluida del export — A3 no acepta importes cero)");
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

    // Base + IVA + Recargo - IRPF = Total. Suma sobre las lineas si las hay.
    if (inv.totalAmount && Math.abs(totalNum) >= 0.005) {
      const lines = getExportLines(inv);
      const sumBase = lines.reduce((s, l) => s + l.taxBase, 0);
      const sumAmt  = lines.reduce((s, l) => s + l.vatAmount, 0);
      const sumSurcharge = lines.reduce((s, l) => s + l.equivalenceSurchargeAmount, 0);
      const irpf    = inv.irpfAmount ? Number(inv.irpfAmount) : 0;
      if (Math.abs(sumBase) > 0 || Math.abs(sumAmt) > 0) {
        const diff = Math.abs(invoiceBalanceDiffCents({
          sumBase, sumAmount: sumAmt, sumSurcharge, irpf, total: totalNum,
        }));
        if (diff > 0) warnings.push(`Descuadre Base+IVA vs Total: ${formatEur(diff / 100)}`);
      }
    }

    if (warnings.length > 0) {
      results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, warnings });
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
  // no hay grupo fiable (ya avisa "NIF vacío" por separado).
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
      const existing = results.find((r) => r.invoiceId === invoiceId);
      if (existing) existing.warnings.push(warning);
      else results.push({ invoiceId, invoiceNumber: inv.invoiceNumber, warnings: [warning] });
    }
  }

  return results;
}

/** Generate A3 Excel workbook as Buffer */
export function generateA3Excel(
  invoices: InvoiceWithClient[],
  config?: ExportConfig,
): Buffer {
  const wb = XLSX.utils.book_new();

  // Filtrar facturas con total = 0: A3 rechaza asientos de importe cero
  // (puede pasar cuando una rectificativa anula exactamente a la original
  // y se intentan exportar juntas). El gestor recibe el warning previo
  // en validateForA3Export para que sepa lo que ha pasado.
  const exportable = invoices.filter((i) => {
    const total = Number(i.totalAmount ?? 0);
    return Math.abs(total) >= 0.005;
  });

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
