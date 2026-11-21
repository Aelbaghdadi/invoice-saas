// Archivo, paso 7: las pantallas comprueban el rol y el acceso ellas mismas
// (R22) y piden a archiveData lo que toca. Se llaman como funciones y se mira
// el árbol que devuelven (como issuesPage.test.ts): sin navegador.
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import ArchivePage from "@/app/dashboard/archivo/page";
import ArchiveInvoicePage from "@/app/dashboard/archivo/facturas/[id]/page";
import AdminClientPage from "@/app/dashboard/admin/clients/[id]/page";
import WorkerClientPage from "@/app/dashboard/worker/clients/[id]/page";
import { ArchiveSearch } from "@/components/archive/ArchiveSearch";
import { ArchiveSummary } from "@/components/archive/ArchiveSummary";
import { MediumSelect } from "@/components/archive/MediumSelect";
import { RetentionHoldForm } from "@/components/archive/RetentionHoldForm";
import { ClientArchiveTab } from "@/components/clients/ClientArchiveTab";
import { ClientArchiveTable } from "@/components/clients/ClientArchiveTable";
import type { ArchiveSearchResult, ClientArchiveRow } from "@/lib/archiveData";
import type { ArchiveMetrics } from "@/lib/archiveMetrics";

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

/** El digest de lo que lanza la página (redirect o notFound), o null. */
const thrown = (page: Promise<unknown>) =>
  page.then(() => null, (e: { digest?: string; message?: string }) => e?.digest ?? e?.message ?? String(e));

const archivePage = (sp: { q?: string | string[]; ejercicio?: string | string[] } = {}) => ArchivePage({ searchParams: Promise.resolve(sp) });
const invoicePage = (id: string) => ArchiveInvoicePage({ params: Promise.resolve({ id }) });

describe("/dashboard/archivo", () => {
  it("el portal no entra: la página lo comprueba, no el proxy", async () => {
    signInAs(a.clientUser);
    expect(await thrown(archivePage())).toMatch(/^NEXT_REDIRECT;push;\/dashboard;/);
  });

  it("el resumen del administrador trae los clientes de su asesoría; el del gestor, solo los suyos", async () => {
    const second = await prisma.client.create({ data: { name: "Segundo SL", cif: "B55443322", advisoryFirmId: a.firm.id } });
    await makeInvoice(second, { status: "VALIDATED" });

    signInAs(a.admin);
    const [adminSummary] = find<{ metrics: ArchiveMetrics }>(await archivePage(), ArchiveSummary);
    expect(adminSummary.props.metrics.clients.filter((c) => c.years.length > 0).map((c) => c.clientId).sort())
      .toEqual([a.client.id, second.id].sort());

    signInAs(a.worker);
    const [workerSummary] = find<{ metrics: ArchiveMetrics }>(await archivePage(), ArchiveSummary);
    expect(workerSummary.props.metrics.clients.map((c) => c.clientId)).toEqual([a.client.id]);
    expect(workerSummary.props.metrics.totals[0]).toMatchObject({ startYear: 2026, invoices: 2 });
  });

  it("el buscador: cada uno encuentra lo suyo, y sin consulta no busca", async () => {
    const mine = await makeInvoice(a.client, { invoiceNumber: "BUSCA-77" });
    await makeInvoice(b.client, { invoiceNumber: "BUSCA-77" });
    const unassigned = await makeUser(a.firm.id, "WORKER", "gestorsolo");

    const results = async (q: string | string[]) =>
      find<{ results: ArchiveSearchResult[] | null }>(await archivePage({ q }), ArchiveSearch)[0].props.results;
    signInAs(a.worker);
    expect((await results("BUSCA-77"))?.map((r) => r.invoiceId)).toEqual([mine.id]);
    // Repetido en la URL (?q=…&q=…) llega como array: vale el primero, sin un 500.
    expect((await results(["BUSCA-77", "otra"]))?.map((r) => r.invoiceId)).toEqual([mine.id]);
    expect(await results("")).toBeNull();
    signInAs(unassigned);
    expect(await results("BUSCA-77")).toEqual([]);
    signInAs(b.admin);
    expect((await results("BUSCA-77"))?.map((r) => r.clientId)).toEqual([b.client.id]);
  });
});

describe("/dashboard/archivo/facturas/[id]", () => {
  it("el administrador y el gestor del cliente la ven; otra asesoría, un gestor sin el cliente o el portal, no", async () => {
    const id = a.invoices.pending.id;
    signInAs(a.admin);
    const page = await invoicePage(id);
    expect(find<{ invoiceIds: string[] }>(page, MediumSelect)[0].props.invoiceIds).toEqual([id]);
    signInAs(a.worker);
    expect(find(await invoicePage(id), RetentionHoldForm)).toHaveLength(1);

    for (const user of [b.admin, b.worker, await makeUser(a.firm.id, "WORKER", "gestorsolo")]) {
      signInAs(user);
      expect(await thrown(invoicePage(id))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    signInAs(a.clientUser);
    expect(await thrown(invoicePage(id))).toMatch(/^NEXT_REDIRECT;push;\/dashboard;/);
    signInAs(a.admin);
    expect(await thrown(invoicePage("no-existe"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("el selector va desactivado mientras se analiza, y en una compra de inmovilizado se sugiere «conservar más»", async () => {
    const analyzing = await makeInvoice(a.client, { status: "ANALYZING", expenseAccount: "21800001" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: analyzing.id },
      data: { retentionHold: false, originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" },
    });
    signInAs(a.admin);
    const page = await invoicePage(analyzing.id);
    // Con su origen: lo que propuso la app se puede «Confirmar» (MediumSelect).
    expect(find<{ medium: string | null; source: string | null; disabled: boolean }>(page, MediumSelect)[0].props)
      .toMatchObject({ medium: "ELECTRONIC", source: "AUTO", disabled: true });
    expect(find<{ suggested: string | null; initial: unknown }>(page, RetentionHoldForm)[0].props).toMatchObject({
      suggested: "FIXED_ASSET",
      initial: { hold: false, reason: null, note: null },
    });

    await prisma.invoiceArchive.update({
      where: { invoiceId: a.invoices.pending.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });
    const normal = await invoicePage(a.invoices.pending.id);
    expect(find<{ disabled: boolean; source: string | null }>(normal, MediumSelect)[0].props).toMatchObject({ disabled: false, source: "MANUAL" });
    expect(find<{ suggested: string | null }>(normal, RetentionHoldForm)[0].props.suggested).toBeNull();
  });
});

describe("pestaña Archivo de la ficha de cliente", () => {
  it("el administrador y el gestor la tienen; la tabla trae el ejercicio, filtrada como pide la URL", async () => {
    const paper = await makeInvoice(a.client, { status: "VALIDATED", invoiceNumber: "F-PAPEL" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: paper.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });

    signInAs(a.admin);
    const adminSheet = await AdminClientPage({
      params: Promise.resolve({ id: a.client.id }),
      searchParams: Promise.resolve({ tab: "archivo", original: "papel" }),
    });
    const [tab] = find<Parameters<typeof ClientArchiveTab>[0]>(adminSheet, ClientArchiveTab);
    expect(tab.props).toMatchObject({ clientId: a.client.id, firmId: a.firm.id });
    const rowsOf = async (props: Parameters<typeof ClientArchiveTab>[0]) =>
      find<{ rows: ClientArchiveRow[] }>(await ClientArchiveTab(props), ClientArchiveTable)[0]?.props.rows.map((r) => r.invoiceNumber);
    expect(await rowsOf(tab.props)).toEqual(["F-PAPEL"]);
    expect((await rowsOf({ ...tab.props, params: {} }))?.sort())
      .toEqual([a.invoices.pending.invoiceNumber, a.invoices.validated.invoiceNumber, "F-PAPEL"].sort());

    // Un filtro repetido en la URL no tumba la pestaña.
    expect(await rowsOf({ ...tab.props, params: { original: ["papel", "electronico"], q: ["F-PAPEL", "x"] } })).toEqual(["F-PAPEL"]);

    signInAs(a.worker);
    const workerSheet = await WorkerClientPage({
      params: Promise.resolve({ id: a.client.id }),
      searchParams: Promise.resolve({ tab: "archivo" }),
    });
    expect(find(workerSheet, ClientArchiveTab)).toHaveLength(1);
  });

  it("la llegada de una emitida es «Subida el»: en la ficha, en la cabecera de la tabla con las emitidas y «Recibida o subida el» con todas", async () => {
    const sale = await makeInvoice(a.client, { type: "SALE", status: "VALIDATED", invoiceNumber: "V-9", issuerName: a.client.name, issuerCif: a.client.cif });
    signInAs(a.admin);
    const saleText = textOf(await invoicePage(sale.id));
    expect(saleText).toMatch(/Subida el \d{2}\/\d{2}\/\d{4}/);
    expect(saleText).not.toContain("Recibida el");
    expect(textOf(await invoicePage(a.invoices.pending.id))).toMatch(/Recibida el \d{2}\/\d{2}\/\d{4}/);

    const tabProps = { clientId: a.client.id, firmId: a.firm.id, basePath: `/dashboard/admin/clients/${a.client.id}` };
    const header = async (params: Parameters<typeof ClientArchiveTab>[0]["params"]) => {
      const [table] = find<Parameters<typeof ClientArchiveTable>[0]>(await ClientArchiveTab({ ...tabProps, params }), ClientArchiveTable);
      const html = renderToStaticMarkup(createElement(ClientArchiveTable, table.props));
      return /<th[^>]*md:table-cell[^>]*>([^<]+)<\/th>/.exec(html)?.[1];
    };
    expect(await header({ tipo: "emitidas" })).toBe("Subida el");
    expect(await header({ tipo: "recibidas" })).toBe("Recibida el");
    expect(await header({})).toBe("Recibida o subida el");
  });

  it("el aviso de las pendientes lleva a las de ese año si el ejercicio es el natural; si no, a las del cliente", async () => {
    signInAs(a.admin);
    const basePath = `/dashboard/admin/clients/${a.client.id}`;
    const pendingLink = async (clientId: string) =>
      find<{ href: string; children: ReactNode }>(await ClientArchiveTab({ clientId, firmId: a.firm.id, basePath, params: {} }), Link)
        .find((link) => link.props.href.includes("estado=pendientes"))?.props;
    expect(await pendingLink(a.client.id)).toMatchObject({ href: `${basePath}?tab=facturas&estado=pendientes&year=2026`, children: "Ver las pendientes" });

    await prisma.client.update({ where: { id: a.client.id }, data: { fiscalYearStartMonth: 7 } });
    expect(await pendingLink(a.client.id)).toMatchObject({ href: `${basePath}?tab=facturas&estado=pendientes`, children: "Ver las pendientes del cliente" });
  });

  it("la tabla puede elegir de una vez todo lo filtrado (hasta lo que admite la acción), no solo la página", async () => {
    signInAs(a.admin);
    const [table] = find<Parameters<typeof ClientArchiveTable>[0]>(
      await ClientArchiveTab({ clientId: a.client.id, firmId: a.firm.id, basePath: "/x", params: { tipo: "recibidas" } }),
      ClientArchiveTable,
    );
    expect(table.props.selectable).toEqual({
      ids: table.props.rows.map((row) => row.invoiceId),
      total: table.props.rows.length,
      filtered: true,
    });
    expect(table.props.typeFilter).toBe("recibidas");
  });
});
