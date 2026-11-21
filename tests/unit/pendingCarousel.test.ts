import { describe, it, expect } from "vitest";
import { nextPendingId } from "@/lib/pendingCarousel";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("nextPendingId", () => {
  it("tras clasificar una, pasa a la que tenía detrás, sin saltarse ninguna", () => {
    expect(nextPendingId(rows("a", "b", "c"), new Set(), "a")).toBe("b");
  });

  it("salta las ya resueltas", () => {
    expect(nextPendingId(rows("a", "b", "c"), new Set(["b"]), "a")).toBe("c");
  });

  it("sin ninguna detrás, vuelve a la primera pendiente desde el principio", () => {
    expect(nextPendingId(rows("a", "b", "c"), new Set(), "c")).toBe("a");
  });

  it("la penúltima pasa a la última (antes el carrusel se cerraba)", () => {
    expect(nextPendingId(rows("a", "b", "c"), new Set(["a"]), "b")).toBe("c");
  });

  it("sin pendientes, null", () => {
    expect(nextPendingId(rows("a", "b"), new Set(["a"]), "b")).toBeNull();
  });

  it("si la lista ya llegó recargada sin la resuelta, empieza por la primera pendiente", () => {
    expect(nextPendingId(rows("b", "c"), new Set(), "a")).toBe("b");
  });
});
