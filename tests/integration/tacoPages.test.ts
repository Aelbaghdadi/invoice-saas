// Entrega B, I5: las pantallas de los tacos como funciones (como
// archivePages.test.ts): la pestaña Tacos, el detalle de una tanda o taco, la
// hoja para imprimir y los avisos del Resumen. Cada una comprueba el rol y el
// acceso (B-R20) ella misma.
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InvoiceStatus, OriginalMedium, OriginalMediumSource, UploadBatch } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeTaco, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import ArchivePage from "@/app/dashboard/archivo/page";
import TacosPage from "@/app/dashboard/archivo/tacos/page";
import TacoDetailPage from "@/app/dashboard/archivo/tandas/[id]/page";
import TacoSheetPage from "@/app/imprimir/taco/[id]/page";
import { PrintButton } from "@/app/imprimir/taco/[id]/PrintButton";
import { convertToTacoAction } from "@/app/dashboard/archivo/tacoActions";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { ArchiveAlerts } from "@/components/archive/ArchiveSummary";
import { TacoList } from "@/components/archive/TacoList";
import { TacoSlotsTable } from "@/components/archive/TacoSlotsTable";
import { TacoDetailActions, type TacoDetailActionsProps } from "@/components/archive/TacoDetailActions";
import type { TacoAlerts, TacoDetail, TacoListRow } from "@/lib/tacoData";
import type { TacoListParams } from "@/lib/tacoListParams";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

/** Los elementos de ese componente en el árbol que devuelve una página. */
function find<P>(node: ReactNode, type: unknown, out: ReactElement<P>[] = []): ReactElement<P>[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node as ReactElement<P>);
    find((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

/** El texto que lleva el árbol (sin ejecutar los componentes que contiene). */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** El HTML de la hoja, sin lo que necesita el navegador (el refresco y el botón de imprimir). */
function sheetHtml(node: ReactNode): string {
  const strip = (n: ReactNode): ReactNode => {
    if (Array.isArray(n)) return n.map(strip);
    if (!isValidElement(n)) return n;
    if (n.type === AutoRefresh || n.type === PrintButton) return null;
    const props = n.props as { children?: ReactNode };
    return props.children === undefined ? n : createElement(n.type as string, { ...(n.props as object), key: n.key }, strip(props.children));
  };
  return renderToStaticMarkup(strip(node) as ReactElement).replace(/<!-- -->/g, "");
}

/** El digest de lo que lanza la página (redirect o notFound), o null. */
const thrown = (page: Promise<unknown>) =>
  page.then(() => null, (e: { digest?: string; message?: string }) => e?.digest ?? e?.message ?? String(e));

const tacosPage = (sp: TacoListParams = {}) => TacosPage({ searchParams: Promise.resolve(sp) });
const detailPage = (id: string) => TacoDetailPage({ params: Promise.resolve({ id }) });
const sheetPage = (id: string) => TacoSheetPage({ params: Promise.resolve({ id }) });

type ArrivalOptions = {
  medium?: OriginalMedium | null;
  source?: OriginalMediumSource | null;
  reason?: string | null;
  status?: InvoiceStatus;
  number?: string;
  client?: { id: string };
  splitPart?: number;
  splitFromId?: string;
  filename?: string;
  fileHash?: string;
  rejectionReason?: string;
};

/** Una factura que llegó en `batch`, en su posición; por defecto papel del taco (PAPER/TACO). */
async function arrivedIn(batch: Pick<UploadBatch, "id" | "createdAt">, position: number, options: ArrivalOptions = {}) {
  const invoice = await makeInvoice(options.client ?? a.client, {
    status: options.status ?? "VALIDATED",
    ...(options.number ? { invoiceNumber: options.number } : {}),
    ...(options.splitFromId ? { splitFromId: options.splitFromId } : {}),
    ...(options.filename ? { filename: options.filename } : {}),
    ...(options.fileHash ? { fileHash: options.fileHash } : {}),
    ...(options.rejectionReason ? { rejectionReason: options.rejectionReason } : {}),
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: {
      uploadBatchId: batch.id,
      uploadPosition: position,
      splitPart: options.splitPart ?? 0,
      receivedAt: batch.createdAt,
      originalMedium: options.medium === undefined ? "PAPER" : options.medium,
      originalMediumSource: options.source === undefined ? "TACO" : options.source,
      originalMediumReason: options.reason === undefined ? "taco" : options.reason,
    },
  });
  return invoice;
}

const listRows = async (sp: TacoListParams = {}) => find<{ rows: TacoListRow[] }>(await tacosPage(sp), TacoList)[0]?.props.rows ?? [];
const listNumbers = async (sp: TacoListParams = {}) => (await listRows(sp)).map((row) => row.tacoNumber);
const detailOf = async (id: string) => find<{ detail: TacoDetail }>(await detailPage(id), TacoSlotsTable)[0]?.props.detail;

describe("/dashboard/archivo/tacos", () => {
  it("el administrador ve todos; el gestor, los de sus clientes, los de varios con uno suyo y nada de un cliente que le quitaron", async () => {
    const outsider = await prisma.client.create({ data: { name: "Ajeno SL", cif: "B70000001", advisoryFirmId: a.firm.id } });
    const mine = await makeTaco(a);
    const several = await makeTaco(a, { clientId: null, candidateIds: [a.client.id, outsider.id], createdById: a.admin.id });
    // Lo subió el gestor, pero el cliente no es suyo: no lo ve (B-R20).
    const notMine = await makeTaco(a, { clientId: outsider.id, createdById: a.worker.id });
    await makeTaco(b);

    signInAs(a.admin);
    expect((await listNumbers()).sort()).toEqual([mine.tacoNumber, several.tacoNumber, notMine.tacoNumber].sort());
    signInAs(a.worker);
    expect((await listNumbers()).sort()).toEqual([mine.tacoNumber, several.tacoNumber].sort());
    signInAs(await makeUser(a.firm.id, "WORKER", "gestorsolo"));
    expect(await listNumbers()).toEqual([]);
    signInAs(a.clientUser);
    expect(await thrown(tacosPage())).toMatch(/^NEXT_REDIRECT;push;\/dashboard;/);
  });

  it("los filtros de estado (anulados y subidas digitales incluidos), cliente, año y caja", async () => {
    const unfiled = await makeTaco(a);
    await arrivedIn(unfiled, 1);
    const boxed = await makeTaco(a, { filed: { boxLabel: "Cliente A SL · 2026 · Caja 3" } });
    const returned = await makeTaco(a, { filed: { returned: true } });
    const pending = await makeTaco(a, { wholePdf: { pageCount: 9 } });
    const voided = await makeTaco(a, { voided: { reason: "Subido por error" } });
    const empty = await makeTaco(a, { period: { periodType: "MONTHLY", periodMonth: 3, periodYear: 2025 } });
    const several = await makeTaco(a, { clientId: null, candidateIds: [a.client.id], filed: { boxLabel: "Caja 12" } });
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 5 });
    await makeTaco(a, { tacoNumber: null, createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });

    signInAs(a.admin);
    const all = await listRows();
    expect(all.map((row) => row.tacoNumber).sort()).toEqual(
      [unfiled, boxed, returned, pending, voided, empty, several].map((t) => t.tacoNumber).sort(),
    );
    // El taco entero sin dividir ni guardar también es papel sin guardar; el vacío, no.
    expect((await listNumbers({ estado: "sin-guardar" })).sort()).toEqual([unfiled.tacoNumber, pending.tacoNumber].sort());
    expect((await listNumbers({ estado: "guardados" })).sort()).toEqual([boxed.tacoNumber, several.tacoNumber].sort());
    expect(await listNumbers({ estado: "devueltos" })).toEqual([returned.tacoNumber]);
    expect(await listNumbers({ estado: "por-dividir" })).toEqual([pending.tacoNumber]);
    expect(await listNumbers({ estado: "anulados" })).toEqual([voided.tacoNumber]);
    const digitalRows = await listRows({ estado: "digitales" });
    expect(digitalRows.map((row) => row.id)).toEqual([digital.id]);
    expect(digitalRows[0]).toMatchObject({ tacoNumber: null, pagesText: "5", state: null });

    expect(await listNumbers({ cliente: "varios" })).toEqual([several.tacoNumber]);
    expect(await listNumbers({ year: "2025" })).toEqual([empty.tacoNumber]);
    expect(await listNumbers({ caja: "caja 12" })).toEqual([several.tacoNumber]);
    expect(await listNumbers({ caja: "CLIENTE a" })).toEqual([boxed.tacoNumber]);

    const byNumber = new Map(all.map((row) => [row.tacoNumber, row]));
    expect(byNumber.get(unfiled.tacoNumber)).toMatchObject({ stateLabel: "Sin guardar", pagesText: "3 · 2 sin factura", lotLabel: "Septiembre 2026 · Recibidas" });
    expect(byNumber.get(boxed.tacoNumber)).toMatchObject({ stateLabel: "En «Cliente A SL · 2026 · Caja 3»" });
    expect(byNumber.get(pending.tacoNumber)).toMatchObject({ stateLabel: "Por dividir", pagesText: "9 del PDF (sin dividir)" });
    expect(byNumber.get(voided.tacoNumber)).toMatchObject({ stateLabel: "Anulado", voidReason: "Subido por error" });
    expect(byNumber.get(empty.tacoNumber)).toMatchObject({ stateLabel: "Vacío" });
    expect(byNumber.get(several.tacoNumber)).toMatchObject({ clientName: null });

    // «Guardar en caja…» en la fila con el mismo criterio que «Sin guardar»: también el taco entero «Por dividir».
    const fileable = all.filter((row) => row.canFile).map((row) => row.tacoNumber).sort();
    expect(fileable).toEqual([unfiled.tacoNumber, pending.tacoNumber].sort());
    const html = renderToStaticMarkup(createElement(TacoList, { rows: await listRows({ estado: "sin-guardar" }), digital: false }));
    // Uno por fila, y con nombre aunque en el móvil solo se vea el icono.
    expect(html.match(/<button[^>]*aria-label="Guardar en caja…"[^>]*title="Guardar en caja…"/g)).toHaveLength(2);
    expect(html.match(/<a[^>]*aria-label="Imprimir hoja"[^>]*title="Imprimir hoja"/g)).toHaveLength(2);
  });
});

describe("/dashboard/archivo/tandas/[id]", () => {
  it("las páginas con sus huecos, la rechazada, varias facturas en el mismo papel y las huellas para «Completar el taco»", async () => {
    const taco = await makeTaco(a, { fileCount: 4 });
    await arrivedIn(taco, 1, { number: "UNO", fileHash: "a".repeat(64) });
    await arrivedIn(taco, 3, { number: "TRES", status: "REJECTED", rejectionReason: "No es una factura" });
    const root = await arrivedIn(taco, 4, { status: "SPLIT_SOURCE", number: "RAIZ", fileHash: "b".repeat(64) });
    for (const part of [1, 2, 3]) await arrivedIn(taco, 4, { number: `P${part}`, splitFromId: root.id, splitPart: part });

    signInAs(a.admin);
    const detail = (await detailOf(taco.id))!;
    expect(detail.slots.map((slot) => [slot.page, slot.kind, slot.label, slot.rows.map((row) => row.invoiceNumber)])).toEqual([
      [1, "invoices", null, ["UNO"]],
      [2, "empty", "Sin factura (duplicada o no subida)", []],
      [3, "invoices", null, ["TRES"]],
      [4, "invoices", "3 facturas en el mismo papel", ["P1", "P2", "P3"]],
    ]);
    expect(detail.slots[2].rows[0]).toMatchObject({ status: "REJECTED", rejectionReason: "No es una factura" });
    const page = await detailPage(taco.id);
    expect(textOf(page)).toContain("4 páginas · 3 con factura · 1 sin factura");
    const [actions] = find<TacoDetailActionsProps>(page, TacoDetailActions);
    expect(actions.props.complete).toMatchObject({
      fileCount: 4,
      takenPages: [1, 3, 4],
      occupied: expect.arrayContaining([{ position: 1, fileHash: "a".repeat(64) }, { position: 4, fileHash: "b".repeat(64) }]),
      meta: { clientId: a.client.id, periodType: "MONTHLY", periodMonth: 9, periodYear: 2026, type: "PURCHASE" },
    });
    expect(actions.props).toMatchObject({ canFile: true, canVoid: false, canConvert: false, canSplit: false });
  });

  it("«No es papel» tras «Era papel», y el botón de «Era papel» en una tanda digital", async () => {
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 2 });
    await arrivedIn(digital, 1, { number: "ESCANEO", medium: null, source: null, reason: null });
    await arrivedIn(digital, 2, { number: "PDF-TEXTO", medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text" });

    signInAs(a.worker);
    const before = await detailPage(digital.id);
    expect(find<TacoDetailActionsProps>(before, TacoDetailActions)[0].props).toMatchObject({ canConvert: true, canFile: false, complete: null });
    expect(textOf(before)).toContain("Tanda digital");
    const rows = find<{ detail: TacoDetail }>(before, TacoSlotsTable)[0].props.detail.rows;
    expect(rows.map((row) => row.invoiceNumber)).toEqual(["ESCANEO", "PDF-TEXTO"]);

    expect(await convertToTacoAction({ batchId: digital.id })).toMatchObject({ ok: true, converted: 1 });
    const detail = (await detailOf(digital.id))!;
    expect(detail.kind).toBe("taco");
    expect(detail.slots.map((slot) => [slot.page, slot.kind, slot.label])).toEqual([
      [1, "invoices", null],
      [2, "electronic", "No es papel (original electrónico)"],
    ]);
  });

  it("al gestor, la factura de otra empresa en un taco de varios sale sin datos; la banda del anulado", async () => {
    const outsider = await prisma.client.create({ data: { name: "Ajeno SL", cif: "B70000002", advisoryFirmId: a.firm.id } });
    const several = await makeTaco(a, { clientId: null, candidateIds: [a.client.id, outsider.id], fileCount: 2 });
    await arrivedIn(several, 1, { number: "MIA" });
    await arrivedIn(several, 2, { number: "AJENA", client: outsider });

    signInAs(a.worker);
    const rows = (await detailOf(several.id))!.slots.flatMap((slot) => slot.rows);
    expect(rows.map((row) => [row.masked, row.invoiceNumber, row.clientName])).toEqual([
      [false, "MIA", "Cliente A SL"],
      [true, null, null],
    ]);
    signInAs(a.admin);
    expect((await detailOf(several.id))!.slots.flatMap((slot) => slot.rows).every((row) => !row.masked)).toBe(true);

    const voided = await makeTaco(a, { voided: { reason: "Subido al cliente equivocado", byId: a.admin.id } });
    const page = await detailPage(voided.id);
    expect(textOf(page)).toMatch(/Anulado el \d{2}\/\d{2}\/\d{4} por admina: Subido al cliente equivocado/);
    expect(find<TacoDetailActionsProps>(page, TacoDetailActions)[0].props).toMatchObject({ canFile: false, canVoid: false, complete: null });
  });

  it("404 desde otra asesoría o para un gestor sin acceso; el portal, al panel", async () => {
    const taco = await makeTaco(a);
    for (const user of [b.admin, b.worker, await makeUser(a.firm.id, "WORKER", "gestorsolo")]) {
      signInAs(user);
      expect(await thrown(detailPage(taco.id))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    signInAs(a.clientUser);
    expect(await thrown(detailPage(taco.id))).toMatch(/^NEXT_REDIRECT;push;\/dashboard;/);
    signInAs(a.admin);
    expect(await thrown(detailPage("no-existe"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("/imprimir/taco/[id]", () => {
  it("«TACO N», sus datos, las páginas con sus huecos y el nombre del fichero de la que se analiza", async () => {
    const taco = await makeTaco(a, { fileCount: 3, filed: { boxLabel: "Cliente A SL · 2026 · Caja 3" } });
    await arrivedIn(taco, 1, { number: "F-UNO" });
    await arrivedIn(taco, 3, { number: "F-TRES", status: "ANALYZING", filename: "SCAN0003.pdf" });

    signInAs(a.worker);
    const page = await sheetPage(taco.id);
    expect(find(page, AutoRefresh)).toHaveLength(1);
    const html = sheetHtml(page);
    expect(html).toContain(`TACO ${taco.tacoNumber}`);
    expect(html).toContain("Cliente A SL");
    expect(html).toContain("Lote: Septiembre 2026 · Recibidas");
    expect(html).toContain("Páginas: 3 (una por factura)");
    expect(html).toContain("Caja: <strong>Cliente A SL · 2026 · Caja 3</strong>");
    expect(html).toContain("Cada «Pág.» es una factura, aunque tenga varias hojas: cuenta facturas, no hojas.");
    expect(html).toContain("F-UNO");
    expect(html).toContain("Sin factura (duplicada o no subida)");
    expect(html).toContain("SCAN0003.pdf");
    expect(html).toContain("1 página se está analizando");
    expect(html).toContain("El papel va en el orden de las páginas, tal como se escaneó: no hace falta ordenarlo.");
  });

  it("anulado, ubicado a mano, entero dividido y sin dividir", async () => {
    signInAs(a.admin);
    const voided = await makeTaco(a, { voided: { reason: "Subido por error" } });
    expect(sheetHtml(await sheetPage(voided.id))).toContain("ANULADO: Subido por error");

    const manual = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Estantería B" } });
    const placed = await makeInvoice(a.client, { status: "VALIDATED", invoiceNumber: "A-MANO" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: placed.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual", paperBatchId: manual.id },
    });
    const manualHtml = sheetHtml(await sheetPage(manual.id));
    expect(manualHtml).toContain("Papel ubicado a mano: no lleva un orden de páginas.");
    expect(manualHtml).toContain("A-MANO");
    expect(manualHtml).not.toContain(">Pág.<");
    expect(manualHtml).not.toContain("no hace falta ordenarlo");

    const whole = await makeTaco(a, { wholePdf: { pageCount: 6, split: { byId: a.worker.id } } });
    await arrivedIn(whole, 2, { number: "W-2" });
    await arrivedIn(whole, 5, { number: "W-5" });
    const wholeHtml = sheetHtml(await sheetPage(whole.id));
    expect(wholeHtml).toContain(">Nº<");
    expect(wholeHtml).toContain("Págs. del PDF");
    expect(wholeHtml).toContain("Páginas del PDF: 6 · 2 facturas");
    expect(wholeHtml).toContain("1.ª");
    expect(wholeHtml).toContain("5-6");
    expect(wholeHtml).toContain("cuenta facturas por su «Nº», no hojas");

    const unsplit = await makeTaco(a, { wholePdf: { pageCount: 9 } });
    const unsplitHtml = sheetHtml(await sheetPage(unsplit.id));
    expect(unsplitHtml).toContain("Falta marcar dónde empieza cada factura.");
    expect(unsplitHtml).not.toContain("<table");
  });

  it("404 fuera de la asesoría, para un gestor sin acceso, para el portal y para una tanda digital", async () => {
    const taco = await makeTaco(a);
    const digital = await makeTaco(a, { tacoNumber: null });
    for (const user of [b.admin, await makeUser(a.firm.id, "WORKER", "gestorsolo"), a.clientUser]) {
      signInAs(user);
      expect(await thrown(sheetPage(taco.id))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    signInAs(a.admin);
    expect(await thrown(sheetPage(digital.id))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("avisos del Resumen", () => {
  it("tacos enteros por dividir, tacos sin guardar y lo que no tiene ubicación, con las dos cifras", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 87 } });
    const unfiled = await makeTaco(a, { fileCount: 5 });
    await arrivedIn(unfiled, 1);
    const paper = await makeInvoice(a.client, { status: "VALIDATED" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: paper.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });

    signInAs(a.admin);
    const [alertsElement] = find<{ alerts: TacoAlerts }>(await ArchivePage({ searchParams: Promise.resolve({}) }), ArchiveAlerts);
    const alerts = alertsElement.props.alerts;
    // El taco entero también es papel sin guardar (87 páginas); las 2 de makeFirm están «Por confirmar».
    expect(alerts).toMatchObject({ unfiled: 2, unfiledPages: 92, paperWithoutLocation: 1, unconfirmedWithoutLocation: 2 });
    expect(alerts.pendingSplits.map((split) => split.id)).toEqual([whole.id]);
    const html = renderToStaticMarkup(createElement(ArchiveAlerts, { alerts })).replace(/<!-- -->/g, "");
    expect(html).toContain(`Hay 1 taco entero por dividir: T${whole.tacoNumber} (Cliente A SL, 87 páginas).`);
    expect(html).toContain("Hay 2 tacos sin guardar en caja (92 páginas).");
    expect(html).toContain("Hay 1 factura en papel sin ubicación y 2 por confirmar (pueden ser papel). Ponles ubicación desde la pestaña Archivo de cada cliente.");
    expect(html).toContain('href="/dashboard/archivo/tacos?estado=sin-guardar"');

    // Otra asesoría no ve nada de esto.
    signInAs(b.admin);
    const other = find<{ alerts: TacoAlerts }>(await ArchivePage({ searchParams: Promise.resolve({}) }), ArchiveAlerts)[0].props.alerts;
    expect(other).toMatchObject({ unfiled: 0, pendingSplits: [], paperWithoutLocation: 0 });
  });
});
