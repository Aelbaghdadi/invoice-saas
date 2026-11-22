import { describe, it, expect } from "vitest";
import { archiveIntakeFields } from "@/lib/archiveIntake";

describe("archiveIntakeFields (fila de archivo al subir)", () => {
  it("un XML es el original electrónico", () => {
    expect(archiveIntakeFields({ fileType: "application/xml", uploadedByClient: false })).toEqual({
      originalMedium: "ELECTRONIC",
      originalMediumSource: "AUTO",
      originalMediumReason: "xml",
    });
  });

  it.each(["image/jpeg", "image/png", "image/webp", "image/heic"])("una imagen (%s) queda «Por confirmar»", (fileType) => {
    expect(archiveIntakeFields({ fileType, uploadedByClient: false })).toEqual({
      originalMedium: null,
      originalMediumSource: "AUTO",
      originalMediumReason: "image_unconfirmed",
    });
  });

  it("un PDF no se decide hasta el análisis", () => {
    expect(archiveIntakeFields({ fileType: "application/pdf", uploadedByClient: false })).toBeNull();
  });

  it.each(["application/pdf", "image/jpeg"])("en un taco, un %s es papel desde el alta (PAPER/TACO/taco)", (fileType) => {
    expect(archiveIntakeFields({ fileType, uploadedByClient: false, inTaco: true })).toEqual({
      originalMedium: "PAPER",
      originalMediumSource: "TACO",
      originalMediumReason: "taco",
    });
  });

  it("un XML con inTaco sigue siendo electrónico (la ruta lo rechaza antes en un taco)", () => {
    expect(archiveIntakeFields({ fileType: "application/xml", uploadedByClient: false, inTaco: true })).toEqual({
      originalMedium: "ELECTRONIC",
      originalMediumSource: "AUTO",
      originalMediumReason: "xml",
    });
  });

  it("lo que sube un CLIENT lo guarda el cliente, sea cual sea el fichero", () => {
    expect(archiveIntakeFields({ fileType: "application/pdf", uploadedByClient: true })).toEqual({ paperHeldByClient: true });
    expect(archiveIntakeFields({ fileType: "image/jpeg", uploadedByClient: true })).toEqual({
      originalMedium: null,
      originalMediumSource: "AUTO",
      originalMediumReason: "image_unconfirmed",
      paperHeldByClient: true,
    });
  });
});
