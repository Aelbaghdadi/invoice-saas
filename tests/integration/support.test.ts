// Soporte: la asesoría abre tickets, los ve quien debe, y el equipo
// (SUPPORT_USERNAMES) contesta desde cualquier asesoría. Un administrador de
// otra asesoría, conociendo el id, no ve ni toca nada.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, type FirmWorld } from "./helpers/factories";
import { runAfterCallbacks } from "./helpers/after";
import { PNG_DATA_URL } from "./helpers/fixtures";
import { signInAs, signOut } from "./helpers/session";
import { addSupportMessage, createSupportTicket, setSupportTicketStatus } from "@/app/dashboard/support/actions";
import { ticketListWhere } from "@/lib/support";

let a: FirmWorld;
let b: FirmWorld;

const NO_ACCESS = "No tienes acceso a este ticket.";

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

afterEach(() => {
  delete process.env.SUPPORT_USERNAMES;
  signOut();
});

/** La accion redirige al ticket: se devuelve la URL del redirect, o el estado si no redirigio. */
async function create(fields: Record<string, string>, attachment?: { name: string; bytes: Buffer; type: string }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (attachment) fd.set("attachment", new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.type }));
  try {
    const state = await createSupportTicket(undefined, fd);
    return { redirect: null as string | null, state };
  } catch (err) {
    const e = err as { digest?: string; url?: string };
    if (e.digest?.startsWith("NEXT_REDIRECT")) return { redirect: e.url ?? null, state: undefined };
    throw err;
  }
}

const png = () => Buffer.from(PNG_DATA_URL.split(",")[1], "base64");

const VALID = { type: "BUG", subject: "Al validar se queda cargando", body: "Pulso validar en la factura de Meta y el botón se queda girando." };

async function openTicket(user = a.worker) {
  signInAs(user);
  const { redirect } = await create({ ...VALID, pageUrl: "/dashboard/worker/review/abc?back=x" });
  const id = redirect!.split("/").pop()!.split("?")[0];
  return prisma.supportTicket.findUniqueOrThrow({ where: { id } });
}

describe("abrir un ticket", () => {
  it("el gestor lo abre con su primer mensaje, la pantalla de origen y el adjunto en el almacenamiento", async () => {
    signInAs(a.worker);
    const { redirect, state } = await create(
      { ...VALID, pageUrl: "https://app/dashboard/worker/review/abc?back=%2Fx" },
      { name: "captura.png", bytes: png(), type: "image/png" },
    );
    expect(state).toBeUndefined();
    expect(redirect).toMatch(/^\/dashboard\/support\/[a-z0-9]+$/);

    const ticket = await prisma.supportTicket.findFirstOrThrow({ include: { messages: true } });
    expect(ticket).toMatchObject({ advisoryFirmId: a.firm.id, createdById: a.worker.id, type: "BUG", status: "OPEN", subject: VALID.subject, pageUrl: "/dashboard/worker/review/abc" });
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({ authorId: a.worker.id, fromSupport: false, body: VALID.body, attachmentName: "captura.png", attachmentType: "image/png" });
    const key = ticket.messages[0].attachmentKey!;
    expect(key).toBe(`support/${a.firm.id}/${ticket.id}/${ticket.messages[0].id}.png`);
    expect(fakeS3().keys()).toContain(key);
    // Los avisos van en after(): sin SUPPORT_EMAIL ni webhook no hacen nada, pero no fallan.
    await runAfterCallbacks();
  });

  it("dice qué falta y no crea nada", async () => {
    signInAs(a.admin);
    const { redirect, state } = await create({ type: "BUG", subject: "ab", body: "corto" });
    expect(redirect).toBeNull();
    expect(state?.errors).toMatchObject({ subject: expect.stringMatching(/al menos 3/), body: expect.stringMatching(/al menos 10/) });
    expect(await prisma.supportTicket.count()).toBe(0);
  });

  it("un adjunto que no es una captura ni un PDF, o demasiado grande, se rechaza", async () => {
    signInAs(a.admin);
    const xml = await create(VALID, { name: "f.xml", bytes: Buffer.from("<?xml version='1.0'?><a/>"), type: "application/xml" });
    expect(xml.state?.errors?.attachment).toMatch(/PNG, JPG o WebP/);
    const big = await create(VALID, { name: "grande.png", bytes: Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]), type: "image/png" });
    expect(big.state?.errors?.attachment).toMatch(/5 MB/);
    expect(await prisma.supportTicket.count()).toBe(0);
  });

  it("un cliente del portal no abre tickets", async () => {
    signInAs(a.clientUser);
    const { state } = await create(VALID);
    expect(state).toEqual({ error: "No autorizado" });
  });

  it("la pantalla de origen solo se guarda si es de la app y no es la de soporte", async () => {
    signInAs(a.admin);
    const fromSupport = await create({ ...VALID, pageUrl: "/dashboard/support/new" });
    const fromOutside = await create({ ...VALID, subject: "Otro", pageUrl: "https://google.com/x" });
    expect(fromSupport.redirect && fromOutside.redirect).toBeTruthy();
    const pages = (await prisma.supportTicket.findMany({ select: { pageUrl: true } })).map((t) => t.pageUrl);
    expect(pages).toEqual([null, null]);
  });
});

describe("quién ve qué", () => {
  it("el gestor ve los suyos, el administrador todos los de su asesoría y la otra asesoría ninguno", async () => {
    await openTicket(a.worker);
    await openTicket(a.admin);
    const count = (actor: Parameters<typeof ticketListWhere>[0]) => prisma.supportTicket.count({ where: ticketListWhere(actor)! });
    expect(await count({ ...a.worker, staff: false })).toBe(1);
    expect(await count({ ...a.admin, staff: false })).toBe(2);
    expect(await count({ ...b.admin, staff: false })).toBe(0);
    expect(await count({ ...b.admin, staff: true })).toBe(2);
  });

  it("otra asesoría no contesta ni cambia el estado, aunque sepa el id", async () => {
    const ticket = await openTicket();
    signInAs(b.admin);
    const fd = new FormData();
    fd.set("body", "Soy de otra asesoría y no debería poder escribir aquí.");
    expect(await addSupportMessage(ticket.id, undefined, fd)).toEqual({ error: NO_ACCESS });
    expect(await setSupportTicketStatus(ticket.id, "CLOSED")).toEqual({ error: NO_ACCESS });
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(1);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("OPEN");
  });

  it("otro gestor de la misma asesoría tampoco ve el ticket de un compañero", async () => {
    const ticket = await openTicket(a.worker);
    const otherWorker = await prisma.user.create({
      data: { username: "gestor2", email: "gestor2@pruebas.es", passwordHash: "x", name: "Gestor Dos", role: "WORKER", advisoryFirmId: a.firm.id },
    });
    signInAs({ id: otherWorker.id, role: "WORKER", advisoryFirmId: a.firm.id });
    expect(await setSupportTicketStatus(ticket.id, "RESOLVED")).toEqual({ error: NO_ACCESS });
  });
});

describe("el hilo y los estados", () => {
  it("la asesoría contesta sin cambiar el estado; lo da por resuelto; contestar lo reabre", async () => {
    const ticket = await openTicket(a.worker);
    signInAs(a.admin);
    const fd = new FormData();
    fd.set("body", "Lo he probado yo también y me pasa lo mismo.");
    expect(await addSupportMessage(ticket.id, undefined, fd)).toEqual({ ok: true });
    let row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    expect(row.status).toBe("OPEN");
    expect(row.messages.map((m) => [m.fromSupport, m.authorId])).toEqual([[false, a.worker.id], [false, a.admin.id]]);

    expect(await setSupportTicketStatus(ticket.id, "RESOLVED")).toEqual({ ok: true });
    row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: { messages: true } });
    expect(row.status).toBe("RESOLVED");
    expect(row.resolvedAt).not.toBeNull();

    // La asesoria no cierra ni pone «en curso»: eso es del equipo.
    expect(await setSupportTicketStatus(ticket.id, "CLOSED")).toEqual({ error: "No puedes poner este ticket en ese estado." });
    expect(await setSupportTicketStatus(ticket.id, "IN_PROGRESS")).toEqual({ error: "No puedes poner este ticket en ese estado." });

    signInAs(a.worker);
    const fd2 = new FormData();
    fd2.set("body", "Pues hoy ha vuelto a pasar con otra factura.");
    expect(await addSupportMessage(ticket.id, undefined, fd2)).toEqual({ ok: true });
    row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: { messages: true } });
    expect(row.status).toBe("OPEN");
    expect(row.resolvedAt).toBeNull();
  });

  it("el equipo contesta desde otra asesoría como soporte, lo pone en curso y puede cerrarlo", async () => {
    const ticket = await openTicket(a.worker);
    process.env.SUPPORT_USERNAMES = `otro, ${b.admin.username}`;
    signInAs(b.admin);
    const fd = new FormData();
    fd.set("body", "Hola, lo estamos mirando. ¿Puedes decirnos el número de la factura?");
    fd.set("attachment", new File([new Uint8Array(png())], "pantalla.png", { type: "image/png" }));
    expect(await addSupportMessage(ticket.id, undefined, fd)).toEqual({ ok: true });
    let row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.messages[1]).toMatchObject({ fromSupport: true, authorId: b.admin.id, attachmentType: "image/png" });

    expect(await setSupportTicketStatus(ticket.id, "CLOSED")).toEqual({ ok: true });
    row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: { messages: true } });
    expect(row.status).toBe("CLOSED");
    expect(row.resolvedAt).not.toBeNull();

    // Cerrado: la asesoria ya no escribe; el equipo si.
    signInAs(a.worker);
    const fd2 = new FormData();
    fd2.set("body", "Sigue pasando, de verdad que sí.");
    expect(await addSupportMessage(ticket.id, undefined, fd2)).toEqual({ error: "Este ticket está cerrado. Si sigue pasando, abre uno nuevo." });
    signInAs(b.admin);
    const fd3 = new FormData();
    fd3.set("body", "Lo reabro desde el equipo con este mensaje.");
    expect(await addSupportMessage(ticket.id, undefined, fd3)).toEqual({ ok: true });
    expect(await prisma.supportMessage.count({ where: { ticketId: ticket.id } })).toBe(3);
  });

  it("sin SUPPORT_USERNAMES nadie es del equipo, aunque sea administrador", async () => {
    const ticket = await openTicket(a.worker);
    signInAs(a.admin);
    const fd = new FormData();
    fd.set("body", "Respuesta del administrador de la propia asesoría.");
    await addSupportMessage(ticket.id, undefined, fd);
    const last = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: ticket.id }, orderBy: { createdAt: "desc" } });
    expect(last.fromSupport).toBe(false);
  });

  it("una respuesta vacía o un estado inventado no pasan", async () => {
    const ticket = await openTicket(a.worker);
    signInAs(a.worker);
    const fd = new FormData();
    fd.set("body", "   ");
    expect(await addSupportMessage(ticket.id, undefined, fd)).toEqual({ error: expect.stringMatching(/al menos 10/) });
    expect(await setSupportTicketStatus(ticket.id, "WHATEVER")).toEqual({ error: "Estado no válido." });
  });
});
