// Reparto de una subida «Clasificar entre varios» (tarea 3): lo que espera a
// alguien en el buzón, lo repartido estos días y reprocesar desde el reparto.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { discardAfterCallbacks } from "./helpers/after";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { recentlyRoutedByClient, routingNeedsActionCount } from "@/lib/routingInbox";
import { POST as processRoute } from "@/app/api/invoices/[id]/process/route";

let w: FirmWorld;
let bucket: { id: string };

/** Una factura de una subida entre varios: en el buzón, con su Document. */
async function fromMultiUpload(over: Parameters<typeof makeInvoice>[1] = {}) {
  const document = await prisma.document.create({
    data: { filename: "f.pdf", storageKey: `k-${Math.random()}`, fileType: "application/pdf", clientId: bucket.id },
  });
  return makeInvoice({ id: over.clientId ?? bucket.id }, {
    status: "PENDING_ROUTING", routingCandidateIds: [w.client.id], documentId: document.id, ...over,
  });
}

beforeEach(async () => {
  w = await makeFirm("A");
  bucket = await getOrCreateUnclassifiedClient(w.firm.id);
});

describe("lo que espera a alguien en el reparto", () => {
  it("cuenta las por clasificar y las que no se pudieron leer, no las que se están leyendo", async () => {
    await fromMultiUpload({ status: "PENDING_ROUTING" });
    await fromMultiUpload({ status: "OCR_ERROR" });
    await fromMultiUpload({ status: "ANALYZING" });
    await fromMultiUpload({ status: "UPLOADED" });
    expect(await routingNeedsActionCount([w.client.id])).toBe(2);
  });

  it("solo las de empresas a las que tiene acceso, y nada de otra asesoría", async () => {
    await fromMultiUpload();
    const other = await makeFirm("B");
    expect(await routingNeedsActionCount([other.client.id])).toBe(0);
    expect(await routingNeedsActionCount([])).toBe(0);
  });
});

describe("repartidas recientemente", () => {
  it("por empresa, las que salieron del buzón; no las subidas directamente ni las antiguas", async () => {
    await fromMultiUpload({ clientId: w.client.id, status: "PENDING_REVIEW", routingCandidateIds: [] });
    await fromMultiUpload({ clientId: w.client.id, status: "VALIDATED", routingCandidateIds: [] });
    await fromMultiUpload({
      clientId: w.client.id, status: "PENDING_REVIEW", routingCandidateIds: [], createdAt: new Date(Date.now() - 10 * 86_400_000),
    });
    // makeFirm ya trae dos subidas directas al cliente: no cuentan.
    expect(await recentlyRoutedByClient([w.client.id])).toEqual([{ clientId: w.client.id, name: w.client.name, count: 2 }]);
  });
});

describe("reprocesar desde el reparto", () => {
  const reprocess = (id: string) => processRoute(new NextRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id }) });

  it("el gestor de una de las empresas candidatas puede volver a leerla", async () => {
    const { id } = await fromMultiUpload({ status: "OCR_ERROR", lastOcrError: "[ERR-OCR-001] fallo" });
    signInAs(w.worker);
    expect((await reprocess(id)).status).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("UPLOADED");
    discardAfterCallbacks();
  });

  it("un gestor sin ninguna de las candidatas no puede", async () => {
    const { id } = await fromMultiUpload({ status: "OCR_ERROR" });
    signInAs(await makeUser(w.firm.id, "WORKER", "gestorsinclientes"));
    expect((await reprocess(id)).status).toBe(404);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("OCR_ERROR");
  });

  it("el administrador de otra asesoría no puede", async () => {
    const { id } = await fromMultiUpload({ status: "OCR_ERROR" });
    const other = await makeFirm("B");
    signInAs(other.admin);
    expect((await reprocess(id)).status).toBe(404);
  });
});
