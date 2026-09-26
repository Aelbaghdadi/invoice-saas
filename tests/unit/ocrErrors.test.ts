import { describe, it, expect } from "vitest";
import { classifyOcrError, isDatabaseError, userMessageForOcrError } from "@/lib/ocrErrors";
import { pickCronOcrActor } from "@/lib/cronActor";

// Como llega un error de Prisma: clase con code P2xxx y mensaje "Invalid ...".
class PrismaClientKnownRequestError extends Error {
  code = "P2003";
  name = "PrismaClientKnownRequestError";
}

describe("classifyOcrError", () => {
  it("un error de Prisma es del sistema, no un documento ilegible", () => {
    const err = new PrismaClientKnownRequestError("Invalid `prisma.auditLog.create()` invocation: Foreign key constraint violated");
    expect(isDatabaseError(err)).toBe(true);
    expect(classifyOcrError(err)).toBe("ERR-SYS-001");
    expect(classifyOcrError(Object.assign(new Error("Transaction already closed"), { code: "P2028" }))).toBe("ERR-SYS-001");
    expect(classifyOcrError(Object.assign(new Error("x"), { name: "PrismaClientUnknownRequestError" }))).toBe("ERR-SYS-001");
  });

  it.each(["P2000", "P2007", "P2020", "P2023"])(
    "un %s (dato del OCR que no cabe o no casa) es del documento, no del sistema",
    (code) => {
      const err = Object.assign(new PrismaClientKnownRequestError("Value out of range for the type"), { code });
      expect(classifyOcrError(err)).toBe("ERR-OCR-002");
    },
  );

  it("mantiene la clasificación de los fallos del OCR", () => {
    expect(classifyOcrError(new Error("Request timed out"))).toBe("ERR-OCR-003");
    expect(classifyOcrError(new Error("storage download failed: 404"))).toBe("ERR-OCR-004");
    expect(classifyOcrError(new Error("Invalid PDF structure"))).toBe("ERR-OCR-002");
    expect(classifyOcrError("algo raro")).toBe("ERR-OCR-001");
    // Un code que no es de Prisma no cambia nada.
    expect(classifyOcrError(Object.assign(new Error("Invalid image"), { code: "ENOENT" }))).toBe("ERR-OCR-002");
  });

  it("el mensaje del error del sistema no dice que el documento sea ilegible", () => {
    expect(userMessageForOcrError("ERR-SYS-001")).not.toMatch(/ilegible/);
  });
});

describe("pickCronOcrActor", () => {
  it("quien la subió; si no, un ADMIN de la asesoría; si no, nadie", () => {
    expect(pickCronOcrActor("u1", "a1")).toBe("u1");
    expect(pickCronOcrActor(null, "a1")).toBe("a1");
    expect(pickCronOcrActor(null, null)).toBeNull();
  });
});
