import { describe, it, expect } from "vitest";
import { neighbours, nextPendingAfter, parseBackHref, reviewHref } from "@/lib/reviewNavigation";

const lote = ["f1", "f2", "f3", "f4", "f5"];

describe("neighbours — las flechas recorren el lote entero", () => {
  it("en medio del lote hay anterior y siguiente", () => {
    expect(neighbours(lote, "f3")).toEqual({ index: 2, prevId: "f2", nextId: "f4" });
  });

  it("la primera no tiene anterior y la ultima no tiene siguiente", () => {
    expect(neighbours(lote, "f1").prevId).toBeNull();
    expect(neighbours(lote, "f5").nextId).toBeNull();
  });

  it("caso Miquel: aunque las anteriores esten validadas, se puede volver a ellas", () => {
    // La lista es la del lote, no la de pendientes: f1..f3 validadas no
    // desaparecen de ella.
    expect(neighbours(lote, "f4").prevId).toBe("f3");
  });

  it("una factura que no esta en la lista no tiene vecinas", () => {
    expect(neighbours(lote, "otra")).toEqual({ index: -1, prevId: null, nextId: null });
  });
});

describe("nextPendingAfter — validar lleva a la siguiente pendiente", () => {
  it("la siguiente pendiente POSTERIOR a la actual, no la primera del lote", () => {
    // El gestor salto con ">" de la f2 a la f4 y la valida: tiene que ir a la
    // f5, no volver a la f2.
    expect(nextPendingAfter(lote, new Set(["f2", "f5"]), "f4")).toBe("f5");
  });

  it("si no queda ninguna por detras, da la vuelta y busca por delante", () => {
    expect(nextPendingAfter(lote, new Set(["f2"]), "f4")).toBe("f2");
  });

  it("nunca devuelve la actual, aunque siga pendiente", () => {
    expect(nextPendingAfter(lote, new Set(["f3"]), "f3")).toBeNull();
  });

  it("sin pendientes, no hay a donde ir", () => {
    expect(nextPendingAfter(lote, new Set(), "f3")).toBeNull();
  });

  it("corrigiendo una ya validada al principio del lote, lleva a la primera pendiente que sigue", () => {
    expect(nextPendingAfter(lote, new Set(["f4", "f5"]), "f1")).toBe("f4");
  });

  it("si la actual no esta en la lista, empieza por el principio", () => {
    expect(nextPendingAfter(lote, new Set(["f2", "f5"]), "otra")).toBe("f2");
  });

  it("posponer: la siguiente se calcula con el orden de ANTES de posponer", () => {
    // f1 y f2 validadas; el gestor salto la f3 con ">" y pospone la f4.
    const seis = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const pendientes = new Set(["f3", "f4", "f5", "f6"]);
    expect(nextPendingAfter(seis, pendientes, "f4")).toBe("f5");
    // Con el orden de despues (la pospuesta al final del lote) se daba la
    // vuelta y volvia a la f3: por eso deferInvoice calcula antes de marcarla.
    const trasPosponer = ["f1", "f2", "f3", "f5", "f6", "f4"];
    expect(nextPendingAfter(trasPosponer, pendientes, "f4")).toBe("f3");
  });

  it("validar una pospuesta: la siguiente sale de donde estaba, no de su sitio original", () => {
    // La f4 estaba pospuesta (al final del lote) y la pagina anuncia la f3.
    // Guardar le quita la marca y la devuelve a su sitio: con ese orden iria
    // a la f5, por eso validateInvoice calcula antes de guardar.
    const pendientes = new Set(["f3", "f4", "f5"]);
    expect(nextPendingAfter(["f1", "f2", "f3", "f5", "f6", "f4"], pendientes, "f4")).toBe("f3");
    expect(nextPendingAfter(["f1", "f2", "f3", "f4", "f5", "f6"], pendientes, "f4")).toBe("f5");
  });
});

describe("parseBackHref — Volver al listado de origen", () => {
  it("acepta el listado con sus filtros y su pagina", () => {
    const back = "/dashboard/worker/invoices?clientId=abc&quarter=3&page=2";
    expect(parseBackHref(back)).toBe(back);
  });

  it("no acepta nada que no sea una ruta del panel", () => {
    expect(parseBackHref("https://otra-web.com/dashboard/")).toBeNull();
    expect(parseBackHref("//otra-web.com/dashboard/")).toBeNull();
    expect(parseBackHref("/login")).toBeNull();
    expect(parseBackHref("/dashboard/\\otra-web.com")).toBeNull();
    expect(parseBackHref(undefined)).toBeNull();
    expect(parseBackHref(["/dashboard/worker/invoices"])).toBeNull();
  });
});

describe("reviewHref — enlaces de los listados a la revision", () => {
  it("lleva la cola y el listado de vuelta", () => {
    const href = reviewHref("f1", { bucket: "clean", back: "/dashboard/worker/invoices?page=2" });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/dashboard/worker/review/f1");
    expect(url.searchParams.get("bucket")).toBe("clean");
    expect(parseBackHref(url.searchParams.get("back"))).toBe("/dashboard/worker/invoices?page=2");
  });

  it("sin cola ni listado, la URL limpia", () => {
    expect(reviewHref("f1")).toBe("/dashboard/worker/review/f1");
    expect(reviewHref("f1", { bucket: "all" })).toBe("/dashboard/worker/review/f1");
  });
});
