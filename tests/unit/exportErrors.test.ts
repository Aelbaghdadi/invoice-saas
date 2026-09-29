import { describe, it, expect } from "vitest";
import { appError } from "@/lib/errorCodes";

describe("mensajes de error del export", () => {
  it("ERR-EXPORT-002 dice que no se ha marcado nada, que es lo que permite reintentar", () => {
    const { message } = appError("ERR-EXPORT-002");
    expect(message).toContain("No se ha marcado ninguna factura como exportada");
    expect(message).not.toMatch(/\bReintenta\b/);
  });

  it("el conflicto manda a recargar, no a repetir a ciegas", () => {
    expect(appError("ERR-EXPORT-003").message).toContain("Vuelve a cargar la página");
  });
});
