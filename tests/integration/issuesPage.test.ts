// La pagina de incidencias con filtros inventados en la URL: antes llegaban a
// Prisma y daban un 500 (revision 1 del PR #11, punto 16).
import { describe, it, expect } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import IssuesPage from "@/app/dashboard/worker/issues/page";

/** Las key de todos los elementos del arbol que devuelve la pagina (cada
 *  fila de incidencia lleva su id). */
function keysIn(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => keysIn(n, out));
  else if (isValidElement(node)) {
    if (node.key != null) out.push(String(node.key));
    keysIn((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

describe("/dashboard/worker/issues", () => {
  it("?status=RESOLVED&type=MANUAL: solo la incidencia que cumple los dos", async () => {
    const w = await makeFirm("A");
    const inv = await makeInvoice(w.client);
    const make = (type: "MANUAL" | "OCR_FAILED", status: "OPEN" | "RESOLVED") =>
      prisma.invoiceIssue.create({ data: { invoiceId: inv.id, type, status, description: `${type} ${status}` } });
    const match = await make("MANUAL", "RESOLVED");
    const others = await Promise.all([make("MANUAL", "OPEN"), make("OCR_FAILED", "RESOLVED"), make("OCR_FAILED", "OPEN")]);
    signInAs(w.admin);
    const page = await IssuesPage({ searchParams: Promise.resolve({ status: "RESOLVED", type: "MANUAL" }) });
    const keys = keysIn(page);
    expect(keys).toContain(match.id);
    for (const other of others) expect(keys).not.toContain(other.id);
  });

  it("status y type inventados: se ignoran, sin error", async () => {
    const w = await makeFirm("A");
    signInAs(w.admin);
    await expect(IssuesPage({ searchParams: Promise.resolve({ status: "<!channel>", type: "@everyone" }) })).resolves.toBeTruthy();
  });
});
