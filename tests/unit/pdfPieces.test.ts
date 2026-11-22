import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";

// Solo el almacenamiento: los trozos no salen de la memoria.
const storage = vi.hoisted(() => ({
  putObject: vi.fn<(key: string, body: Buffer, type?: string) => Promise<void>>(),
  deleteObject: vi.fn<(key: string) => Promise<void>>(),
}));
vi.mock("@/lib/storage", () => storage);

const { loadPdf, slicePdf, uploadSplitPieces } = await import("@/lib/pdfPieces");

/** Un PDF de `pages` páginas; cada una con un ancho distinto (100, 101…) para reconocerla en los trozos. */
async function numberedPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let n = 0; n < pages; n++) doc.addPage([100 + n, 200]);
  return Buffer.from(await doc.save());
}

async function widthsOf(bytes: Buffer): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => page.getWidth());
}

const piece = (n: number) => ({
  label: `trozo ${n}`,
  filename: `trozo ${n}.pdf`,
  storageKey: `k/${n}.pdf`,
  fileType: "application/pdf",
  body: Buffer.from(`trozo ${n}`),
});

describe("slicePdf", () => {
  it("un PDF de 5 páginas en [1-2] y [3-5]: dos PDF de 2 y 3 páginas, con sus páginas en orden", async () => {
    const [first, second] = await slicePdf(await numberedPdf(5), [{ start: 1, end: 2 }, { start: 3, end: 5 }]);
    expect(await widthsOf(first)).toEqual([100, 101]);
    expect(await widthsOf(second)).toEqual([102, 103, 104]);
  });

  it("acepta el PDF ya abierto y rangos de una página", async () => {
    const doc = await loadPdf(await numberedPdf(3));
    const pieces = await slicePdf(doc, [{ start: 3, end: 3 }, { start: 1, end: 1 }]);
    expect(await Promise.all(pieces.map(widthsOf))).toEqual([[102], [100]]);
  });

  it("un PDF roto lanza", async () => {
    await expect(slicePdf(Buffer.from("%PDF-1.4\nbasura sin estructura\n"), [{ start: 1, end: 1 }])).rejects.toThrow();
  });

  it("un rango que se sale del PDF lanza", async () => {
    const bytes = await numberedPdf(3);
    await expect(slicePdf(bytes, [{ start: 2, end: 4 }])).rejects.toThrow(RangeError);
    await expect(slicePdf(bytes, [{ start: 0, end: 1 }])).rejects.toThrow(RangeError);
    await expect(slicePdf(bytes, [{ start: 3, end: 2 }])).rejects.toThrow(RangeError);
  });
});

describe("uploadSplitPieces", () => {
  beforeEach(() => {
    storage.putObject.mockReset();
    storage.deleteObject.mockReset();
    storage.deleteObject.mockResolvedValue(undefined);
  });

  it("por defecto, de uno en uno y en orden", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    storage.putObject.mockImplementation(async (key) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push(key);
      running--;
    });
    expect(await uploadSplitPieces([1, 2, 3].map(piece))).toBeNull();
    expect(order).toEqual(["k/1.pdf", "k/2.pdf", "k/3.pdf"]);
    expect(maxRunning).toBe(1);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("con concurrency 4, como mucho 4 a la vez", async () => {
    let running = 0;
    let maxRunning = 0;
    storage.putObject.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
    });
    expect(await uploadSplitPieces(Array.from({ length: 10 }, (_, i) => piece(i + 1)), { concurrency: 4 })).toBeNull();
    expect(storage.putObject).toHaveBeenCalledTimes(10);
    expect(maxRunning).toBe(4);
  });

  it("si uno falla, no empieza más, espera a los que subían y borra todos los subidos", async () => {
    storage.putObject.mockImplementation(async (key) => {
      if (key === "k/3.pdf") throw new Error("Garage caído");
      // Los que van a la vez que el que falla terminan después que él.
      await new Promise((resolve) => setTimeout(resolve, key === "k/4.pdf" ? 10 : 1));
    });
    const error = await uploadSplitPieces(Array.from({ length: 12 }, (_, i) => piece(i + 1)), { concurrency: 4 });
    expect(error).toBe('Error subiendo "trozo 3": Garage caído');
    const started = storage.putObject.mock.calls.map(([key]) => key);
    expect(started).not.toContain("k/12.pdf");
    const deleted = storage.deleteObject.mock.calls.map(([key]) => key).sort();
    // Todos los que se subieron, también el que terminó después del fallo; el que falló no se subió.
    expect(deleted).toEqual(started.filter((key) => key !== "k/3.pdf").sort());
    expect(deleted).toContain("k/4.pdf");
  });

  it("sin trozos, nada", async () => {
    expect(await uploadSplitPieces([])).toBeNull();
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
