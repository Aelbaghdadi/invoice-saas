import { describe, it, expect } from "vitest";
import { holeRect, isOnStepPage, placePopover, tourSelectors, tourStepsFor, TOUR_REVIEW_PATH } from "@/lib/tourSteps";

const VIEWPORT = { width: 1180, height: 760 };
const POP = { width: 380, height: 220 };

describe("tourStepsFor — los pasos de cada rol", () => {
  it("el administrador pasa por Exportar y el gestor no, que no tiene esa pantalla", () => {
    const admin = tourStepsFor("ADMIN");
    const worker = tourStepsFor("WORKER");
    expect(admin.some((s) => s.path === "/dashboard/admin/export")).toBe(true);
    expect(worker.some((s) => s.path.startsWith("/dashboard/admin"))).toBe(false);
    expect(worker[0].path).toBe("/dashboard/worker");
  });

  it("el cliente no tiene recorrido", () => {
    expect(tourStepsFor("CLIENT")).toEqual([]);
  });

  it("cada paso con bloque tiene un selector data-tour y el último lleva a subir una factura", () => {
    const admin = tourStepsFor("ADMIN");
    for (const s of admin) {
      for (const sel of tourSelectors(s)) expect(sel).toMatch(/^\[data-tour="[a-z-]+"\]$/);
    }
    expect(admin[admin.length - 1].finalAction?.path).toBe("/dashboard/worker/upload");
  });
});

describe("isOnStepPage", () => {
  const admin = tourStepsFor("ADMIN");
  const panel = admin.find((s) => s.path === "/dashboard/admin")!;
  const review = admin.find((s) => s.path === TOUR_REVIEW_PATH)!;

  it("el panel es su ruta exacta, no sus subpáginas", () => {
    expect(isOnStepPage(panel, "/dashboard/admin")).toBe(true);
    expect(isOnStepPage(panel, "/dashboard/admin/batch")).toBe(false);
  });

  it("la revisión se reconoce por el prefijo de la factura que abre la redirección", () => {
    expect(isOnStepPage(review, "/dashboard/worker/review/abc123")).toBe(true);
    expect(isOnStepPage(review, TOUR_REVIEW_PATH)).toBe(false);
  });
});

describe("placePopover — dónde va el cuadro", () => {
  it("sin bloque, en el centro", () => {
    const p = placePopover(null, POP, VIEWPORT);
    expect(p.placement).toBe("center");
    expect(p.left).toBe((VIEWPORT.width - POP.width) / 2);
    expect(p.top).toBe((VIEWPORT.height - POP.height) / 2);
  });

  it("a la derecha si cabe", () => {
    const p = placePopover({ top: 100, left: 240, width: 460, height: 120 }, POP, VIEWPORT, "right");
    expect(p.placement).toBe("right");
    expect(p.left).toBe(240 + 460 + 14);
  });

  it("si no cabe en el lado preferido, en otro con sitio", () => {
    const p = placePopover({ top: 100, left: 700, width: 460, height: 120 }, POP, VIEWPORT, "right");
    expect(p.placement).not.toBe("right");
    expect(p.left + POP.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("un bloque que ocupa la pantalla: el cuadro queda dentro de la ventana", () => {
    const p = placePopover({ top: 0, left: 0, width: VIEWPORT.width, height: VIEWPORT.height }, POP, VIEWPORT, "right");
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.left + POP.width).toBeLessThanOrEqual(VIEWPORT.width - 12);
    expect(p.top + POP.height).toBeLessThanOrEqual(VIEWPORT.height - 12);
  });
});

describe("holeRect — el hueco resaltado", () => {
  it("añade margen y no se sale de la ventana", () => {
    expect(holeRect({ top: 50, left: 50, width: 100, height: 40 }, VIEWPORT)).toEqual({ top: 42, left: 42, width: 116, height: 56 });
    const big = holeRect({ top: -200, left: 0, width: 2000, height: 2000 }, VIEWPORT);
    expect(big.top).toBe(4);
    expect(big.left).toBe(4);
    expect(big.top + big.height).toBe(VIEWPORT.height - 4);
    expect(big.left + big.width).toBe(VIEWPORT.width - 4);
  });
});
