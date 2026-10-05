import { describe, it, expect } from "vitest";
import { classifyOcrError, isDatabaseError, OcrNotConfiguredError, OriginalMissingError, userMessageForError, userMessageForOcrError } from "@/lib/ocrErrors";
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
    // Una descarga que pasa del tope es un fallo de descarga, no un análisis lento.
    expect(classifyOcrError(new Error("Almacenamiento: timeout (30 s) descargando k.pdf"))).toBe("ERR-OCR-004");
    expect(classifyOcrError(new Error("Invalid PDF structure"))).toBe("ERR-OCR-002");
    expect(classifyOcrError("algo raro")).toBe("ERR-OCR-001");
    // Un code que no es de Prisma no cambia nada.
    expect(classifyOcrError(Object.assign(new Error("Invalid image"), { code: "ENOENT" }))).toBe("ERR-OCR-002");
  });

  it("sin GEMINI_API_KEY: ERR-OCR-005, con un mensaje que dice qué falta", () => {
    const err = new OcrNotConfiguredError();
    expect(classifyOcrError(err)).toBe("ERR-OCR-005");
    const message = userMessageForError(err, "ERR-OCR-005");
    expect(message).toMatch(/clave de Gemini/);
    expect(message).toMatch(/administrador/);
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

describe("original que no está (revisión 2 del PR #15)", () => {
  it("es ERR-OCR-004 y pide volver a subirlo; el tope de tiempo sigue pidiendo reprocesar", () => {
    const missing = new OriginalMissingError({ cause: new Error("NoSuchKey") });
    expect(classifyOcrError(missing)).toBe("ERR-OCR-004");
    expect(userMessageForError(missing, "ERR-OCR-004")).toBe("El archivo original no está en el almacenamiento. Hay que volver a subirlo.");
    expect(missing.message).not.toMatch(/\d/);
    const timeout = new Error("Almacenamiento: timeout (30 s) descargando k");
    expect(userMessageForError(timeout, classifyOcrError(timeout))).toMatch(/Vuelve a procesarla/);
  });
});
