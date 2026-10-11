import { describe, it, expect } from "vitest";
import {
  allowedStatuses,
  canReadTicket,
  canUseSupport,
  isSupportStaff,
  newTicketNoticeText,
  pagePathFrom,
  parseSupportStaff,
  replyNoticeText,
  supportAttachmentKey,
  ticketListWhere,
  ticketSortKey,
  userAgentFrom,
  validateMessageInput,
  validateTicketInput,
  type SupportActor,
} from "@/lib/support";

const firmA = "firm-a";
const admin: SupportActor = { id: "admin", role: "ADMIN", advisoryFirmId: firmA, staff: false };
const worker: SupportActor = { id: "worker", role: "WORKER", advisoryFirmId: firmA, staff: false };
const otherAdmin: SupportActor = { id: "admin-b", role: "ADMIN", advisoryFirmId: "firm-b", staff: false };
const staff: SupportActor = { id: "azn", role: "ADMIN", advisoryFirmId: "firm-b", staff: true };
const client: SupportActor = { id: "cli", role: "CLIENT", advisoryFirmId: null, staff: false };

const ticket = { advisoryFirmId: firmA, createdById: "worker" };

describe("quién es del equipo de soporte", () => {
  it("lee los nombres de usuario separados por comas o espacios", () => {
    expect([...parseSupportStaff("azeddine, zuhir naserdin,,")]).toEqual(["azeddine", "zuhir", "naserdin"]);
    expect(parseSupportStaff(undefined).size).toBe(0);
  });

  it("isSupportStaff compara el nombre de usuario exacto", () => {
    expect(isSupportStaff("zuhir", "azeddine,zuhir")).toBe(true);
    expect(isSupportStaff("Zuhir", "azeddine,zuhir")).toBe(false);
    expect(isSupportStaff(null, "azeddine")).toBe(false);
    expect(isSupportStaff("azeddine", "")).toBe(false);
  });

  it("solo la asesoría abre tickets", () => {
    expect(canUseSupport("ADMIN")).toBe(true);
    expect(canUseSupport("WORKER")).toBe(true);
    expect(canUseSupport("CLIENT")).toBe(false);
    expect(canUseSupport(undefined)).toBe(false);
  });
});

describe("quién ve qué", () => {
  it("el administrador lista los de su asesoría y el gestor solo los suyos", () => {
    expect(ticketListWhere(admin)).toEqual({ advisoryFirmId: firmA });
    expect(ticketListWhere(worker)).toEqual({ advisoryFirmId: firmA, createdById: "worker" });
    expect(ticketListWhere(staff)).toEqual({});
  });

  it("sin asesoría o sin rol de asesoría no se lista nada (nunca un filtro vacío)", () => {
    expect(ticketListWhere(client)).toBeNull();
    expect(ticketListWhere({ ...admin, advisoryFirmId: null })).toBeNull();
  });

  it("leer: el administrador de su asesoría, el gestor el suyo, el equipo todos; otra asesoría no", () => {
    expect(canReadTicket(admin, ticket)).toBe(true);
    expect(canReadTicket(worker, ticket)).toBe(true);
    expect(canReadTicket({ ...worker, id: "otro-gestor" }, ticket)).toBe(false);
    expect(canReadTicket(otherAdmin, ticket)).toBe(false);
    expect(canReadTicket(staff, ticket)).toBe(true);
    expect(canReadTicket(client, ticket)).toBe(false);
  });

  it("estados: la asesoría solo reabre o da por resuelto; el equipo, cualquiera; sin acceso, ninguno", () => {
    expect(allowedStatuses(admin, ticket)).toEqual(["OPEN", "RESOLVED"]);
    expect(allowedStatuses(staff, ticket)).toEqual(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
    expect(allowedStatuses(otherAdmin, ticket)).toEqual([]);
  });
});

describe("validación del formulario", () => {
  it("un ticket completo pasa, recortado y con los saltos de línea normalizados", () => {
    const r = validateTicketInput({ type: "BUG", subject: "  Se queda cargando ", body: "Al validar la factura\r\nse queda cargando." });
    expect(r).toEqual({ ok: true, value: { type: "BUG", subject: "Se queda cargando", body: "Al validar la factura\nse queda cargando." } });
  });

  it("dice qué falta campo a campo", () => {
    const r = validateTicketInput({ type: "x", subject: "ab", body: "corto" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.type).toMatch(/Elige/);
      expect(r.errors.subject).toMatch(/al menos 3/);
      expect(r.errors.body).toMatch(/al menos 10/);
    }
  });

  it("topes de longitud", () => {
    const r = validateTicketInput({ type: "QUESTION", subject: "a".repeat(121), body: "b".repeat(5001) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.subject).toMatch(/120/);
      expect(r.errors.body).toMatch(/5\.?000/);
    }
    expect(validateMessageInput("x".repeat(5000)).ok).toBe(true);
    expect(validateMessageInput("x".repeat(5001)).ok).toBe(false);
    expect(validateMessageInput(42).ok).toBe(false);
  });
});

describe("contexto del ticket", () => {
  it("guarda solo la ruta de la app, sin parámetros", () => {
    expect(pagePathFrom("https://msassessors.faktury.es/dashboard/worker/review/abc?back=%2Fx#top")).toBe("/dashboard/worker/review/abc");
    expect(pagePathFrom("/dashboard/admin/clients?q=ana@correo.es")).toBe("/dashboard/admin/clients");
  });

  it("ignora lo que no es una pantalla de la app", () => {
    expect(pagePathFrom("https://google.com/")).toBeNull();
    expect(pagePathFrom("/login")).toBeNull();
    expect(pagePathFrom("no es una url")).toBeNull();
    expect(pagePathFrom(null)).toBeNull();
    expect(pagePathFrom("")).toBeNull();
  });

  it("recorta una ruta absurda y el navegador", () => {
    expect(pagePathFrom(`/dashboard/${"a".repeat(500)}`)!.length).toBe(200);
    expect(userAgentFrom(`Mozilla ${"x".repeat(500)}`)!.length).toBe(300);
    expect(userAgentFrom("  ")).toBeNull();
  });

  it("la clave del adjunto va por asesoría y ticket, con la extensión del tipo real", () => {
    expect(supportAttachmentKey("f1", "t1", "m1", "jpeg")).toBe("support/f1/t1/m1.jpg");
    expect(supportAttachmentKey("f1", "t1", "m1", "pdf")).toBe("support/f1/t1/m1.pdf");
  });
});

describe("avisos y orden", () => {
  const notice = { subject: "No exporta", type: "BUG" as const, firmName: "MS Assessors", userName: "Mariano", url: "https://x/dashboard/support/1" };

  it("el texto del aviso lleva tipo, asesoría, quién y el enlace", () => {
    expect(newTicketNoticeText(notice)).toBe("Nuevo ticket de soporte (Fallo) · MS Assessors · Mariano: «No exporta» https://x/dashboard/support/1");
    expect(replyNoticeText({ ...notice, fromSupport: false })).toMatch(/^Respuesta de MS Assessors \(Mariano\)/);
    expect(replyNoticeText({ ...notice, fromSupport: true })).toMatch(/^Respuesta del equipo/);
  });

  it("sin cerrar primero y, dentro, lo último que se movió", () => {
    const t1 = { status: "RESOLVED" as const, updatedAt: new Date("2026-10-10") };
    const t2 = { status: "OPEN" as const, updatedAt: new Date("2026-10-01") };
    const t3 = { status: "IN_PROGRESS" as const, updatedAt: new Date("2026-10-05") };
    const sorted = [t1, t2, t3].sort((a, b) => {
      const [ka, kb] = [ticketSortKey(a), ticketSortKey(b)];
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    expect(sorted).toEqual([t3, t2, t1]);
  });
});
