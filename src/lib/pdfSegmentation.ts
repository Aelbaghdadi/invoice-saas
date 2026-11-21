import { parseTaxId } from "@/lib/validators";
import { ocrText } from "@/lib/ocrText";

/**
 * Separacion automatica de un PDF con varias facturas (un taco escaneado tal
 * cual llega a la asesoria). Gemini lee cada pagina (classifyPdfPagesWithGemini)
 * y aqui se decide, sin IA, que paginas forman cada factura y cuales sobran.
 *
 * Criterio conservador: ante cualquier duda (lectura incompleta, ninguna
 * factura) no se separa nada y el PDF sigue el flujo de siempre. Partir mal
 * una factura de varias paginas es peor que no partir un taco: eso ultimo el
 * gestor lo arregla con «Dividir».
 */

export const PAGE_KINDS = ["FACTURA", "ALBARAN", "EN_BLANCO", "OTRO"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Lo que Gemini ve en una pagina. */
export type PageReading = {
  /** 1-indexada. */
  page: number;
  kind: PageKind;
  /** La pagina es la primera de una factura (cabecera con numero, emisor...). */
  startsInvoice: boolean;
  invoiceNumber: string | null;
  issuerCif: string | null;
};

export type PdfSegmentation = {
  /** Paginas (1-indexadas, en orden) de cada factura. */
  invoices: number[][];
  /** Paginas que no van a ninguna factura: albaranes, en blanco, relleno. */
  discarded: { page: number; kind: Exclude<PageKind, "FACTURA"> }[];
};

export const DISCARDED_KIND_LABEL: Record<Exclude<PageKind, "FACTURA">, string> = {
  ALBARAN: "albarán",
  EN_BLANCO: "en blanco",
  OTRO: "otro documento",
};

function sameInvoiceNumber(a: string | null, b: string | null): boolean | null {
  const clean = (v: string | null) => (v ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!clean(a) || !clean(b)) return null;
  return clean(a) === clean(b);
}

function sameIssuer(a: string | null, b: string | null): boolean | null {
  const clean = (v: string | null) => parseTaxId(v).clean.toUpperCase();
  if (!clean(a) || !clean(b)) return null;
  return clean(a) === clean(b);
}

/**
 * Agrupa las paginas en facturas. Una pagina de factura abre una nueva si no
 * hay ninguna abierta, si trae otro numero u otro emisor, o si Gemini la marca
 * como inicio y no repite el numero de la abierta (las facturas largas repiten
 * la cabecera en cada pagina y Gemini a veces las marca como inicio).
 *
 * Devuelve null si la lectura no cubre todas las paginas o no hay facturas.
 */
export function segmentPages(readings: PageReading[], numPages: number): PdfSegmentation | null {
  if (numPages < 1 || readings.length !== numPages) return null;
  const byPage = [...readings].sort((a, b) => a.page - b.page);
  if (byPage.some((r, i) => r.page !== i + 1)) return null;

  const invoices: number[][] = [];
  const discarded: PdfSegmentation["discarded"] = [];
  let current: { pages: number[]; invoiceNumber: string | null; issuerCif: string | null } | null = null;

  for (const reading of byPage) {
    if (reading.kind !== "FACTURA") {
      discarded.push({ page: reading.page, kind: reading.kind });
      continue;
    }
    const numberMatch = current ? sameInvoiceNumber(current.invoiceNumber, reading.invoiceNumber) : null;
    const issuerMatch = current ? sameIssuer(current.issuerCif, reading.issuerCif) : null;
    const opensNew = !current
      || numberMatch === false
      || issuerMatch === false
      || (reading.startsInvoice && numberMatch !== true);
    if (opensNew) {
      current = { pages: [], invoiceNumber: reading.invoiceNumber, issuerCif: reading.issuerCif };
      invoices.push(current.pages);
    }
    current!.pages.push(reading.page);
    current!.invoiceNumber ??= reading.invoiceNumber;
    current!.issuerCif ??= reading.issuerCif;
  }

  if (invoices.length === 0) return null;
  return { invoices, discarded };
}

/** Solo se separa si hay algo que separar: varias facturas o paginas que sobran. */
export function worthSplitting(segmentation: PdfSegmentation | null): segmentation is PdfSegmentation {
  return !!segmentation && (segmentation.invoices.length > 1 || segmentation.discarded.length > 0);
}

/** Resumen para la auditoria: «3 facturas · descartadas: p. 4 (albarán), p. 7 (en blanco)». */
export function segmentationSummary(segmentation: PdfSegmentation): string {
  const count = segmentation.invoices.length;
  const invoices = `${count} ${count === 1 ? "factura" : "facturas"}`;
  if (segmentation.discarded.length === 0) return invoices;
  const pages = segmentation.discarded.map((d) => `p. ${d.page} (${DISCARDED_KIND_LABEL[d.kind]})`).join(", ");
  return `${invoices} · descartadas: ${pages}`;
}

/** Normaliza la respuesta de Gemini; null si no tiene la forma esperada. */
export function parsePageReadings(parsed: unknown): PageReading[] | null {
  const pages = (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return null;
  const readings: PageReading[] = [];
  for (const raw of pages) {
    const r = raw as Record<string, unknown>;
    const page = Number(r?.page);
    const kind = String(r?.kind ?? "").toUpperCase();
    if (!Number.isInteger(page) || !(PAGE_KINDS as readonly string[]).includes(kind)) return null;
    readings.push({
      page,
      kind: kind as PageKind,
      startsInvoice: r.startsInvoice === true,
      invoiceNumber: ocrText(r.invoiceNumber),
      issuerCif: ocrText(r.issuerCif)?.replace(/\s/g, "") ?? null,
    });
  }
  return readings;
}
