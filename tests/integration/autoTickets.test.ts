// Tickets automáticos: un error inesperado abre un ticket en Soporte para el
// equipo, el mismo fallo suma repeticiones mientras siga sin cerrar, y la
// asesoría no los ve. Un 403 de Gemini en N facturas es un solo ticket.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs, signOut } from "./helpers/session";
import { stubOcr } from "./helpers/ocr";
import { createAlertLimiter } from "@/lib/errorReporting";
import { recordAutoTicket, recordServerErrorTicket } from "@/lib/autoTickets";
import { processInvoice } from "@/lib/processInvoice";
import { OcrHttpError } from "@/lib/ocrErrors";
import { addSupportMessage, setSupportTicketStatus } from "@/app/dashboard/support/actions";
import { ticketListWhere } from "@/lib/support";
import type { AutoTicketInput } from "@/lib/autoTicketText";

let a: FirmWorld;
const noNotify = async () => {};

const boom = (over: Partial<AutoTicketInput> = {}): AutoTicketInput => ({
  kind: "server",
  name: "TypeError",
  message: "Cannot read properties of undefined",
  path: "/dashboard/admin/export",
  routePath: "/dashboard/admin/export",
  routeType: "render",
  method: "GET",
  ...over,
});

beforeEach(async () => {
  a = await makeFirm("A");
});

afterEach(() => {
  delete process.env.SUPPORT_USERNAMES;
  signOut();
});

describe("recordAutoTicket", () => {
  it("abre un ticket automático con el detalle y, con el mismo fallo, solo suma", async () => {
    expect(await recordAutoTicket(boom({ firmId: a.firm.id, userId: a.worker.id }), { notify: noNotify })).toBe("created");
    expect(await recordAutoTicket(boom(), { notify: noNotify })).toBe("counted");
    expect(await recordAutoTicket(boom(), { notify: noNotify })).toBe("counted");

    const tickets = await prisma.supportTicket.findMany({ include: { messages: true } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      source: "AUTO", type: "BUG", status: "OPEN", occurrences: 3,
      advisoryFirmId: a.firm.id, createdById: a.worker.id, pageUrl: "/dashboard/admin/export",
    });
    expect(tickets[0].subject).toBe("Error del servidor · TypeError: Cannot read properties of undefined");
    expect(tickets[0].messages).toHaveLength(1);
    expect(tickets[0].messages[0]).toMatchObject({ authorId: null, fromSupport: false });
    expect(tickets[0].messages[0].body).toContain(`Asesoría: ${a.firm.name}`);
  });

  it("dos a la vez no abren dos tickets", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => recordAutoTicket(boom(), { notify: noNotify })));
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(await prisma.supportTicket.count()).toBe(1);
    expect((await prisma.supportTicket.findFirstOrThrow()).occurrences).toBe(5);
  });

  it("cerrado el ticket, si vuelve a pasar se abre otro", async () => {
    await recordAutoTicket(boom(), { notify: noNotify });
    await prisma.supportTicket.updateMany({ data: { status: "CLOSED" } });
    expect(await recordAutoTicket(boom(), { notify: noNotify })).toBe("created");
    expect(await prisma.supportTicket.count()).toBe(2);
  });

  it("un fallo distinto es otro ticket; una petición cortada no abre nada", async () => {
    await recordAutoTicket(boom(), { notify: noNotify });
    await recordAutoTicket(boom({ name: "RangeError" }), { notify: noNotify });
    expect(await recordAutoTicket(boom({ name: "AbortError", message: "aborted" }), { notify: noNotify })).toBe("ignored");
    expect(await prisma.supportTicket.count()).toBe(2);
  });

  it("con el tope de tickets nuevos, los nuevos no se abren pero los repetidos siguen contando", async () => {
    const limiter = createAlertLimiter(1, 60_000);
    expect(await recordAutoTicket(boom(), { notify: noNotify, limiter, clock: () => 1 })).toBe("created");
    expect(await recordAutoTicket(boom({ name: "RangeError" }), { notify: noNotify, limiter, clock: () => 2 })).toBe("limited");
    expect(await recordAutoTicket(boom(), { notify: noNotify, limiter, clock: () => 3 })).toBe("counted");
    expect(await prisma.supportTicket.count()).toBe(1);
  });

  it("un usuario o una asesoría que ya no existen no rompen nada", async () => {
    expect(await recordAutoTicket(boom({ firmId: "no-existe", userId: "tampoco" }), { notify: noNotify })).toBe("created");
    expect(await prisma.supportTicket.findFirstOrThrow()).toMatchObject({ advisoryFirmId: null, createdById: null });
  });

  it("avisa al equipo solo la primera vez", async () => {
    const notices: string[] = [];
    const notify = async (n: { subject: string }) => { notices.push(n.subject); };
    await recordAutoTicket(boom(), { notify });
    await recordAutoTicket(boom(), { notify });
    await new Promise((r) => setTimeout(r, 10));
    expect(notices).toEqual(["Error del servidor · TypeError: Cannot read properties of undefined"]);
  });
});

describe("errores del servidor (onRequestError)", () => {
  it("sin sesión abre el ticket sin asesoría ni usuario, con la ruta sin parámetros", async () => {
    const err = Object.assign(new Error("boom en el export"), { digest: "987654" });
    const result = await recordServerErrorTicket(
      err,
      { path: "/dashboard/admin/export?clientId=x", method: "POST", headers: { "user-agent": "Mozilla/5.0 prueba" } },
      { routePath: "/dashboard/admin/export", routeType: "action" },
      { notify: noNotify },
    );
    expect(result).toBe("created");
    const t = await prisma.supportTicket.findFirstOrThrow({ include: { messages: true } });
    expect(t).toMatchObject({ advisoryFirmId: null, createdById: null, pageUrl: "/dashboard/admin/export", userAgent: "Mozilla/5.0 prueba" });
    expect(t.messages[0].body).toContain("Dónde: en una acción (guardar, validar…)");
    expect(t.messages[0].body).toContain("Digest: 987654");
  });
});

describe("errores del OCR", () => {
  it("un 403 de Gemini en varias facturas es un solo ticket con las repeticiones y la asesoría", async () => {
    for (let i = 0; i < 3; i++) {
      stubOcr(async () => { throw new OcrHttpError(`Gemini Flash respondió 403: {"message":"projects/${i}"}`, 403, null); });
      const key = `k-${i}`;
      fakeS3().put(key, "%PDF-1.4");
      const inv = await makeInvoice(a.client, { status: "UPLOADED", storageKey: key, invoiceNumber: null, totalAmount: null });
      await processInvoice(inv.id, a.worker.id);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("OCR_ERROR");
    }
    const tickets = await prisma.supportTicket.findMany();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ source: "AUTO", occurrences: 3, advisoryFirmId: a.firm.id, subject: "Error del OCR (ERR-OCR-001) · OcrHttpError 403" });
  });

  it("un documento ilegible no abre ticket: es del documento, no de la app", async () => {
    stubOcr(async () => { throw new Error("Invalid PDF structure"); });
    fakeS3().put("k-mal", "%PDF-1.4");
    const inv = await makeInvoice(a.client, { status: "UPLOADED", storageKey: "k-mal", invoiceNumber: null, totalAmount: null });
    await processInvoice(inv.id, a.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).lastOcrError).toMatch(/^\[ERR-OCR-002\]/);
    expect(await prisma.supportTicket.count()).toBe(0);
  });
});

describe("quién los ve", () => {
  it("la asesoría no los lista ni los toca, aunque sean de su asesoría; el equipo sí", async () => {
    await recordAutoTicket(boom({ firmId: a.firm.id, userId: a.admin.id }), { notify: noNotify });
    const t = await prisma.supportTicket.findFirstOrThrow();
    expect(await prisma.supportTicket.count({ where: ticketListWhere({ ...a.admin, staff: false })! })).toBe(0);

    signInAs(a.admin);
    const fd = new FormData();
    fd.set("body", "Intento contestar un ticket automático.");
    expect(await addSupportMessage(t.id, undefined, fd)).toEqual({ error: "No tienes acceso a este ticket." });
    expect(await setSupportTicketStatus(t.id, "RESOLVED")).toEqual({ error: "No tienes acceso a este ticket." });

    process.env.SUPPORT_USERNAMES = a.admin.username;
    expect(await addSupportMessage(t.id, undefined, fd)).toEqual({ ok: true });
    expect(await setSupportTicketStatus(t.id, "CLOSED")).toEqual({ ok: true });
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: t.id }, include: { messages: true } });
    expect(after.status).toBe("CLOSED");
    expect(after.messages.map((m) => m.fromSupport)).toEqual([false, true]);
  });
});
