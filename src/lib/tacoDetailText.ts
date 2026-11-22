/**
 * Los textos de la cabecera de un taco, que comparten su detalle (5.7) y su
 * hoja (5.14). Sin BD: solo con lo que da loadTacoDetail.
 */
import type { TacoDetail } from "@/lib/tacoData";
import { tacoLabel } from "@/lib/paperLocation";
import { invoiceCountText } from "@/lib/tacoSplitReview";

const n = (value: number) => value.toLocaleString("es-ES");
const pages = (count: number) => `${n(count)} ${count === 1 ? "página" : "páginas"}`;

type CountsInput = Pick<TacoDetail, "kind" | "fileCount" | "rows" | "wholePdf" | "pdfPageCount" | "split" | "slots">;

/** «Taco 37», «Tanda digital» o «Taco 40 · papel ubicado a mano». */
export function tacoDetailTitle(detail: Pick<TacoDetail, "kind" | "tacoNumber">): string {
  if (detail.kind === "digital" || detail.tacoNumber == null) return "Tanda digital";
  return detail.kind === "archive" ? `${tacoLabel(detail.tacoNumber)} · papel ubicado a mano` : tacoLabel(detail.tacoNumber);
}

/** Las facturas de un taco entero dividido: los rangos que empiezan una. */
export function wholeTacoInvoiceCount(detail: Pick<TacoDetail, "slots">): number {
  return detail.slots.filter((slot) => slot.order != null).length;
}

/** «52 páginas · 50 con factura · 2 sin factura», «87 páginas del PDF · sin dividir», «12 ficheros»… */
export function tacoCountsLine(detail: CountsInput): string {
  if (detail.kind === "digital") return `${n(detail.fileCount)} ${detail.fileCount === 1 ? "fichero" : "ficheros"}`;
  if (detail.kind === "archive") return invoiceCountText(detail.rows.length);
  if (detail.wholePdf) {
    const total = `${pages(detail.pdfPageCount ?? 0)} del PDF`;
    return detail.split ? `${total} · ${invoiceCountText(wholeTacoInvoiceCount(detail))}` : `${total} · sin dividir`;
  }
  const empty = detail.slots.filter((slot) => slot.kind === "empty").length;
  const filled = detail.slots.length - empty;
  return [pages(detail.slots.length), `${n(filled)} con factura`, empty > 0 ? `${n(empty)} sin factura` : null]
    .filter(Boolean)
    .join(" · ");
}
