import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { StorageIdleError } from "@/lib/storage";
import { counted, storageFailure, zipWriter } from "@/lib/zipStream";

const NO_LIMIT = Number.MAX_SAFE_INTEGER;

async function* chunks(count: number, size: number, events?: string[]) {
  for (let i = 0; i < count; i++) {
    events?.push(`lee ${i}`);
    yield new Uint8Array(size).fill(i);
  }
}

async function* text(...parts: string[]) {
  yield* parts;
}

describe("zipWriter", () => {
  it("escribe un ZIP válido con ficheros sin comprimir y textos comprimidos", async () => {
    const out: Uint8Array[] = [];
    const zip = zipWriter(async (chunk) => {
      out.push(chunk);
    }, NO_LIMIT);
    await zip.binary("originales/2026-03/Panadería López.pdf", chunks(3, 10), new Date("2026-03-05T10:00:00Z"));
    await zip.text("LEEME.txt", text("Hola, ", "archivo"));
    await zip.end();
    const files = unzipSync(Buffer.concat(out));
    expect(Object.keys(files)).toEqual(["originales/2026-03/Panadería López.pdf", "LEEME.txt"]);
    expect(files["originales/2026-03/Panadería López.pdf"]).toHaveLength(30);
    expect(strFromU8(files["LEEME.txt"])).toBe("Hola, archivo");
    expect(zip.closed).toBe(false);
  });

  it("con contrapresión: no se pide el trozo siguiente hasta que el anterior ha salido", async () => {
    const events: string[] = [];
    const zip = zipWriter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push("sale");
    }, NO_LIMIT);
    await zip.binary("a.pdf", chunks(5, 64 * 1024, events), new Date());
    await zip.end();
    const reads = events.map((event, i) => (event.startsWith("lee") ? i : -1)).filter((i) => i >= 0);
    expect(reads).toHaveLength(5);
    for (let k = 1; k < reads.length; k++) expect(events.slice(reads[k - 1], reads[k])).toContain("sale");
  });

  it("el tope de bytes corta el ZIP antes de pasarlo y no pide más trozos", async () => {
    const events: string[] = [];
    let sent = 0;
    const zip = zipWriter(async (chunk) => {
      sent += chunk.length;
    }, 100 * 1024);
    await expect(zip.binary("grande.pdf", chunks(10, 32 * 1024, events), new Date())).rejects.toThrow(/El ZIP pasaría de 100 KB/);
    expect(zip.closed).toBe(true);
    expect(sent).toBeLessThanOrEqual(100 * 1024);
    expect(events.length).toBeLessThan(10);
    // Lo siguiente ya no se escribe.
    await expect(zip.text("LEEME.txt", text("x"))).rejects.toThrow(/El ZIP pasaría/);
  });

  it("si el navegador corta, queda cerrado y el error es el del navegador", async () => {
    const cut = new Error("el navegador ha cerrado la conexión");
    const zip = zipWriter(async () => {
      throw cut;
    }, NO_LIMIT);
    await expect(zip.binary("a.pdf", chunks(2, 10), new Date())).rejects.toBe(cut);
    expect(zip.closed).toBe(true);
  });

  it("un original que se corta a mitad cierra su entrada y el ZIP sigue siendo válido", async () => {
    const out: Uint8Array[] = [];
    const zip = zipWriter(async (chunk) => {
      out.push(chunk);
    }, NO_LIMIT);
    async function* broken() {
      yield new Uint8Array(10).fill(1);
      throw new StorageIdleError("k", 30_000);
    }
    await expect(zip.binary("roto.pdf", broken(), new Date())).rejects.toBeInstanceOf(StorageIdleError);
    expect(zip.closed).toBe(false);
    await zip.text("ERRORES.txt", text("roto.pdf"));
    await zip.end();
    const files = unzipSync(Buffer.concat(out));
    expect(files["roto.pdf"]).toHaveLength(10);
    expect(strFromU8(files["ERRORES.txt"])).toBe("roto.pdf");
  });
});

describe("counted y storageFailure", () => {
  it("counted deja pasar los trozos y suma sus bytes", async () => {
    let total = 0;
    const seen: number[] = [];
    for await (const chunk of counted(chunks(3, 7), (n) => (total += n))) seen.push(chunk.length);
    expect(seen).toEqual([7, 7, 7]);
    expect(total).toBe(21);
  });

  it("el motivo para ERRORES.txt", () => {
    expect(storageFailure({ name: "NoSuchKey" }, 0)).toBe("no está en el almacenamiento");
    expect(storageFailure(new StorageIdleError("k", 30_000), 2048)).toBe("el almacenamiento dejó de responder; el fichero del ZIP está incompleto (2 KB)");
    expect(storageFailure(new Error("500"), 0)).toBe("no se pudo descargar del almacenamiento");
  });
});
