import { describe, it, expect } from "vitest";
import {
  DIGITAL_SLOT_TAKEN_ERROR,
  EMPTY_UPLOAD_LIST,
  OFFICE_FILES_NOTICE,
  TACO_MAX_FILES_ERROR,
  WHOLE_PDF_NOTICE,
  XML_IN_PAPER_NOTICE,
  addToUploadList,
  applyUploadResult,
  assignBatch,
  clearFinishedUploads,
  isUploading,
  markUploading,
  moveByOne,
  moveToPage,
  pageOf,
  planNewBatches,
  removeFromUploadList,
  replaceFile,
  resortUploadList,
  settingsLockReason,
  uploadFileNotice,
  type NewUploadFile,
  type UploadListMode,
  type UploadListState,
} from "@/lib/uploadListState";

const MB = 1024 * 1024;

function file(name: string, overrides: Partial<NewUploadFile> = {}): NewUploadFile {
  return { id: `id-${name}`, name, size: 1000, lastModified: 0, ...overrides };
}

function add(state: UploadListState, files: NewUploadFile[], mode: UploadListMode = "perInvoice"): UploadListState {
  return addToUploadList(state, files, mode).state;
}

const names = (state: UploadListState) => state.items.map((item) => item.name);
const pages = (state: UploadListState) => state.items.map((item) => pageOf(state, item.id));
const idOf = (state: UploadListState, name: string) => state.items.find((item) => item.name === name)!.id;

/** Una lista con estos ficheros, ya en una tanda (como tras pulsar «Subir»). */
function inBatch(fileNames: string[], batch: { id: string; tacoNumber: number | null }, mode: UploadListMode = "perInvoice") {
  const state = add(EMPTY_UPLOAD_LIST, fileNames.map((name) => file(name)), mode);
  return assignBatch(state, state.items.map((item) => item.id), batch);
}

describe("añadir ficheros: el orden", () => {
  it("se ordena por nombre en orden natural y cada fila tiene su «Pág. N»", () => {
    let state = add(EMPTY_UPLOAD_LIST, [file("Scan (10).pdf"), file("Scan (2).pdf"), file("Scan.pdf")]);
    expect(names(state)).toEqual(["Scan.pdf", "Scan (2).pdf", "Scan (10).pdf"]);
    expect(pages(state)).toEqual([1, 2, 3]);
    expect(state.items.every((item) => item.status === "queued")).toBe(true);
    // Sin orden a mano, lo que se añade después se intercala en su sitio.
    state = add(state, [file("Scan (3).pdf")]);
    expect(names(state)).toEqual(["Scan.pdf", "Scan (2).pdf", "Scan (3).pdf", "Scan (10).pdf"]);
  });

  it("con «Ordenar por: hora del fichero», por la hora", () => {
    const state = add({ ...EMPTY_UPLOAD_LIST, sortBy: "time" }, [
      file("a.pdf", { lastModified: 3 }),
      file("b.pdf", { lastModified: 1 }),
      file("c.pdf", { lastModified: 2 }),
    ]);
    expect(names(state)).toEqual(["b.pdf", "c.pdf", "a.pdf"]);
  });

  it("con filas movidas a mano, lo nuevo va al final ordenado entre sí; «Ordenar por» quita el orden a mano", () => {
    let state = add(EMPTY_UPLOAD_LIST, [file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    state = moveToPage(state, idOf(state, "c.pdf"), 1);
    expect(state.manualOrder).toBe(true);
    state = add(state, [file("e.pdf"), file("d.pdf")]);
    expect(names(state)).toEqual(["c.pdf", "a.pdf", "b.pdf", "d.pdf", "e.pdf"]);

    const resorted = resortUploadList(state, "name");
    expect(names(resorted)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]);
    expect(resorted.manualOrder).toBe(false);
    expect(resortUploadList(state, "time").sortBy).toBe("time");
  });

  it("también en digital, y el mismo nombre y tamaño no entra dos veces", () => {
    let state = add(EMPTY_UPLOAD_LIST, [file("b.xml"), file("a.pdf")], "digital");
    expect(names(state)).toEqual(["a.pdf", "b.xml"]);
    state = add(state, [file("a.pdf", { id: "otro" }), file("a.pdf", { id: "otro-tamaño", size: 2000 })], "digital");
    expect(state.items.map((item) => [item.name, item.size])).toEqual([["a.pdf", 1000], ["a.pdf", 2000], ["b.xml", 1000]]);
  });

  it("un fichero sin extensión entra por el tipo que da el navegador", () => {
    const { state, notices } = addToUploadList(EMPTY_UPLOAD_LIST, [file("escaneo", { mimeType: "image/jpeg" })], "perInvoice");
    expect(names(state)).toEqual(["escaneo"]);
    expect(notices).toEqual([]);
  });
});

describe("añadir ficheros: lo que no entra y sus avisos", () => {
  it("Word, Excel y similares, en cualquier modo, con un solo aviso", () => {
    for (const mode of ["digital", "perInvoice", "wholePdf"] as const) {
      const { state, notices } = addToUploadList(EMPTY_UPLOAD_LIST, [file("Factura.docx"), file("Hoja.xlsx"), file("ok.pdf")], mode);
      expect(notices, mode).toEqual([OFFICE_FILES_NOTICE]);
      expect(names(state), mode).toEqual(["ok.pdf"]);
    }
    expect(OFFICE_FILES_NOTICE).toBe(
      "Los Word, Excel y similares no se suben aquí: sube el PDF de la factura y, en su ficha del archivo, «Adjuntar el original en Word, Excel…».",
    );
  });

  it("más de 20 MB, con el tamaño en MB y, en papel, qué hacer", () => {
    const big = file("Grande.pdf", { size: 34 * MB });
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [big], "digital")).toEqual({
      state: EMPTY_UPLOAD_LIST,
      notices: ["Grande.pdf pesa 34 MB y el máximo es 20 MB."],
    });
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [big], "perInvoice").notices).toEqual([
      "Grande.pdf pesa 34 MB y el máximo es 20 MB. Escanéalo en blanco y negro a 200 ppp o pártelo en dos.",
    ]);
    // Lo que pasa de 20 por poco no dice «20 MB».
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("Justo.pdf", { size: 20 * MB + 1 })], "digital").notices).toEqual([
      "Justo.pdf pesa 20,1 MB y el máximo es 20 MB.",
    ]);
    expect(names(add(EMPTY_UPLOAD_LIST, [file("Límite.pdf", { size: 20 * MB })]))).toEqual(["Límite.pdf"]);
  });

  it("varios de más de 20 MB, en un aviso", () => {
    const { notices } = addToUploadList(
      EMPTY_UPLOAD_LIST,
      [file("A.pdf", { size: 34 * MB }), file("B.pdf", { size: 25.5 * MB })],
      "perInvoice",
    );
    expect(notices).toEqual([
      "2 ficheros pesan más de 20 MB, el máximo: A.pdf (34 MB) y B.pdf (25,5 MB). Escanéalos en blanco y negro a 200 ppp o pártelos en dos.",
    ]);
  });

  it("un XML no entra en papel; en digital sí", () => {
    const paper = addToUploadList(EMPTY_UPLOAD_LIST, [file("factura.xml"), file("Scan.pdf")], "perInvoice");
    expect(paper.notices).toEqual([XML_IN_PAPER_NOTICE]);
    expect(names(paper.state)).toEqual(["Scan.pdf"]);
    expect(XML_IN_PAPER_NOTICE).toBe("Un XML no es un escaneo: súbelo sin marcar «Es papel».");
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("factura.xml")], "digital").notices).toEqual([]);
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("factura", { mimeType: "text/xml" })], "perInvoice").notices).toEqual([XML_IN_PAPER_NOTICE]);
  });

  it("taco entero: un solo PDF", () => {
    let result = addToUploadList(EMPTY_UPLOAD_LIST, [file("taco.pdf"), file("otro.pdf")], "wholePdf");
    expect(names(result.state)).toEqual(["taco.pdf"]);
    expect(result.notices).toEqual([WHOLE_PDF_NOTICE]);
    expect(WHOLE_PDF_NOTICE).toBe("En el taco entero va un solo PDF.");

    // Con el PDF en la lista, un segundo no entra.
    result = addToUploadList(result.state, [file("tercero.pdf")], "wholePdf");
    expect(names(result.state)).toEqual(["taco.pdf"]);
    expect(result.notices).toEqual([WHOLE_PDF_NOTICE]);

    // Algo que no es PDF tampoco.
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("foto.jpg")], "wholePdf").notices).toEqual([WHOLE_PDF_NOTICE]);
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("factura.xml")], "wholePdf").notices).toEqual([WHOLE_PDF_NOTICE]);

    // Subido el primero, ya se puede subir otro taco.
    const uploaded = applyUploadResult(result.state, idOf(result.state, "taco.pdf"), { status: "ok" });
    expect(names(add(uploaded, [file("siguiente.pdf")], "wholePdf"))).toEqual(["taco.pdf", "siguiente.pdf"]);
  });

  it("con ficheros de un taco empezado sin subir, no se añade nada", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "taco-37", tacoNumber: 37 });
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "Sin conexión" });
    for (const mode of ["digital", "perInvoice", "wholePdf"] as const) {
      const result = addToUploadList(state, [file("c.pdf")], mode);
      expect(result.state, mode).toBe(state);
      expect(result.notices, mode).toEqual([
        "Termina o quita los ficheros del Taco 37 antes de añadir otros: irían a otro taco. Para añadirlos al mismo taco, usa «Completar el taco» en su detalle.",
      ]);
    }
    // Quitada la que falló, ya se puede.
    state = removeFromUploadList(state, idOf(state, "b.pdf"));
    expect(names(add(state, [file("c.pdf")]))).toEqual(["a.pdf", "c.pdf"]);
  });

  it("en digital, una tanda a medias no impide añadir: lo nuevo irá a otra", () => {
    let state = inBatch(["a.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "error", message: "Sin conexión" });
    expect(names(add(state, [file("b.pdf")], "digital"))).toEqual(["a.pdf", "b.pdf"]);
  });

  it("lo que no es PDF, imagen ni XML, y los ficheros vacíos, con su aviso", () => {
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("escaneo.tif")], "digital").notices).toEqual([
      "escaneo.tif no se puede subir: solo se admiten PDF, JPG, PNG, WEBP, HEIC o XML.",
    ]);
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("a.tif"), file("b.tif"), file("c.zip"), file("d.bmp")], "perInvoice").notices).toEqual([
      "4 ficheros no se pueden subir (a.tif, b.tif, c.zip y 1 más): solo se admiten PDF, JPG, PNG, WEBP o HEIC.",
    ]);
    expect(addToUploadList(EMPTY_UPLOAD_LIST, [file("vacio.pdf", { size: 0 })], "digital").notices).toEqual(["vacio.pdf está vacío."]);
  });

  it("uploadFileNotice dice lo mismo de un fichero suelto", () => {
    expect(uploadFileNotice({ name: "a.docx", size: 10 }, "perInvoice")).toBe(OFFICE_FILES_NOTICE);
    expect(uploadFileNotice({ name: "a.xml", size: 10 }, "perInvoice")).toBe(XML_IN_PAPER_NOTICE);
    expect(uploadFileNotice({ name: "a.xml", size: 10 }, "digital")).toBeNull();
    expect(uploadFileNotice({ name: "a.pdf", size: 21 * MB }, "digital")).toBe("a.pdf pesa 21 MB y el máximo es 20 MB.");
    expect(uploadFileNotice({ name: "a.pdf", size: 10 }, "wholePdf")).toBeNull();
  });
});

describe("mover filas", () => {
  const abcd = () => add(EMPTY_UPLOAD_LIST, ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map((name) => file(name)));

  it("«Mover a la pág. …» a cualquier página", () => {
    const state = abcd();
    expect(names(moveToPage(state, idOf(state, "d.pdf"), 2))).toEqual(["a.pdf", "d.pdf", "b.pdf", "c.pdf"]);
    expect(names(moveToPage(state, idOf(state, "a.pdf"), 4))).toEqual(["b.pdf", "c.pdf", "d.pdf", "a.pdf"]);
    expect(names(moveToPage(state, idOf(state, "c.pdf"), 1))).toEqual(["c.pdf", "a.pdf", "b.pdf", "d.pdf"]);
  });

  it("fuera de rango, a su misma página o una fila que no existe: igual", () => {
    const state = abcd();
    for (const page of [0, 5, 1.5, -1, Number.NaN]) {
      expect(moveToPage(state, idOf(state, "b.pdf"), page), String(page)).toBe(state);
    }
    expect(moveToPage(state, idOf(state, "b.pdf"), 2)).toBe(state);
    expect(moveToPage(state, "no-existe", 1)).toBe(state);
    expect(state.manualOrder).toBe(false);
  });

  it("«Subir una fila» y «Bajar una fila», sin pasar de los extremos", () => {
    const state = abcd();
    expect(names(moveByOne(state, idOf(state, "b.pdf"), -1))).toEqual(["b.pdf", "a.pdf", "c.pdf", "d.pdf"]);
    expect(names(moveByOne(state, idOf(state, "b.pdf"), 1))).toEqual(["a.pdf", "c.pdf", "b.pdf", "d.pdf"]);
    expect(moveByOne(state, idOf(state, "a.pdf"), -1)).toBe(state);
    expect(moveByOne(state, idOf(state, "d.pdf"), 1)).toBe(state);
  });

  it("no mueve filas que ya tienen tanda ni las que se están subiendo; las demás se numeran entre sí", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = add(state, [file("c.pdf"), file("d.pdf"), file("e.pdf")], "digital");
    state = markUploading(state, idOf(state, "e.pdf"));
    expect(moveToPage(state, idOf(state, "a.pdf"), 2)).toBe(state);
    expect(moveToPage(state, idOf(state, "e.pdf"), 1)).toBe(state);
    state = moveToPage(state, idOf(state, "d.pdf"), 1);
    expect(names(state)).toEqual(["a.pdf", "b.pdf", "d.pdf", "c.pdf", "e.pdf"]);
    // a y b: su posición en la tanda; d y c: la que tendrán; e se está subiendo.
    expect(pages(state)).toEqual([1, 2, 1, 2, null]);
  });
});

describe("tandas al pulsar «Subir»", () => {
  it("digital: bloques de 500 en el orden visible", () => {
    const files = Array.from({ length: 1201 }, (_, i) => file(`Scan ${i + 1}.pdf`));
    const state = add(EMPTY_UPLOAD_LIST, files, "digital");
    const plan = planNewBatches(state, "digital");
    expect("blocks" in plan && plan.blocks.map((block) => block.length)).toEqual([500, 500, 201]);
    if (!("blocks" in plan)) return;
    expect(plan.blocks[0][0]).toBe(idOf(state, "Scan 1.pdf"));
    expect(plan.blocks[1][0]).toBe(idOf(state, "Scan 501.pdf"));
    expect(plan.blocks.flat()).toEqual(state.items.map((item) => item.id));
  });

  it("factura a factura: un bloque, como mucho de 500", () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => file(`Scan ${i + 1}.pdf`));
    expect(planNewBatches(add(EMPTY_UPLOAD_LIST, files(501)), "perInvoice")).toEqual({ error: TACO_MAX_FILES_ERROR });
    expect(TACO_MAX_FILES_ERROR).toBe("Como mucho 500 ficheros por taco: pártelo en dos.");
    const plan = planNewBatches(add(EMPTY_UPLOAD_LIST, files(500)), "perInvoice");
    expect("blocks" in plan && plan.blocks.map((block) => block.length)).toEqual([500]);
  });

  it("no cuenta lo que ya tiene tanda ni lo subido", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "Sin conexión" });
    state = add(state, [file("c.pdf")], "digital");
    expect(planNewBatches(state, "digital")).toEqual({ blocks: [[idOf(state, "c.pdf")]] });
    expect(planNewBatches(clearFinishedUploads(removeFromUploadList(state, idOf(state, "c.pdf"))), "digital")).toEqual({ blocks: [] });
  });

  it("taco entero: ninguna tanda, y la lista tiene que ser un solo PDF", () => {
    expect(planNewBatches(add(EMPTY_UPLOAD_LIST, [file("taco.pdf")], "wholePdf"), "wholePdf")).toEqual({ blocks: [] });
    // Ficheros añadidos en digital y después cambiado el modo.
    const mixed = add(EMPTY_UPLOAD_LIST, [file("a.pdf"), file("b.pdf")], "digital");
    expect(planNewBatches(mixed, "wholePdf")).toEqual({ error: WHOLE_PDF_NOTICE });
    expect(planNewBatches(add(EMPTY_UPLOAD_LIST, [file("a.jpg")], "digital"), "wholePdf")).toEqual({ error: WHOLE_PDF_NOTICE });
    expect(planNewBatches(add(EMPTY_UPLOAD_LIST, [file("a.xml")], "digital"), "perInvoice")).toEqual({ error: XML_IN_PAPER_NOTICE });
  });

  it("assignBatch numera 1..n en el orden visible y no toca lo que ya tiene tanda", () => {
    let state = add(EMPTY_UPLOAD_LIST, [file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    state = moveToPage(state, idOf(state, "c.pdf"), 1);
    const ids = ["b.pdf", "a.pdf", "c.pdf"].map((name) => idOf(state, name));
    const assigned = assignBatch(state, ids, { id: "taco-37", tacoNumber: 37 });
    expect(assigned.items.map((item) => [item.name, item.batchId, item.tacoNumber, item.position])).toEqual([
      ["c.pdf", "taco-37", 37, 1],
      ["a.pdf", "taco-37", 37, 2],
      ["b.pdf", "taco-37", 37, 3],
    ]);
    expect(pages(assigned)).toEqual([1, 2, 3]);
    expect(assignBatch(assigned, ids, { id: "otra", tacoNumber: 38 })).toBe(assigned);
  });
});

describe("resultado de cada subida", () => {
  it("subida, duplicada y error", () => {
    let state = inBatch(["a.pdf", "b.pdf", "c.pdf"], { id: "taco-37", tacoNumber: 37 });
    state = markUploading(state, idOf(state, "a.pdf"));
    expect(isUploading(state)).toBe(true);
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "duplicate", of: "FRA-1 (subida el 20/11/2026)" });
    state = applyUploadResult(state, idOf(state, "c.pdf"), { status: "error", message: "Esa página del taco ya tiene otro fichero.", code: "ERR-UPLOAD-009" });
    expect(isUploading(state)).toBe(false);
    expect(state.items.map((item) => [item.status, item.duplicateOf ?? item.errorMessage ?? null, item.position])).toEqual([
      ["ok", null, 1],
      ["duplicate", "FRA-1 (subida el 20/11/2026)", 2],
      ["error", "Esa página del taco ya tiene otro fichero.", 3],
    ]);
    expect(state.items[2].errorCode).toBe("ERR-UPLOAD-009");
    expect(state.items[2].batchId).toBe("taco-37");
  });

  it("con ERR-UPLOAD-008 la fila se queda sin tanda: el siguiente «Subir» abre otra", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "La tanda no vale.", code: "ERR-UPLOAD-008" });
    const failed = state.items[1];
    expect(failed).toMatchObject({ status: "error", errorMessage: "La tanda no vale.", errorCode: "ERR-UPLOAD-008" });
    expect([failed.batchId, failed.position, failed.tacoNumber]).toEqual([undefined, undefined, undefined]);
    expect(pageOf(state, failed.id)).toBe(1);
    expect(planNewBatches(state, "digital")).toEqual({ blocks: [[failed.id]] });
    expect(settingsLockReason(state)).toBeNull();
  });

  it("con ERR-UPLOAD-009 en una subida digital (el primer intento sí llegó y se cambió el fichero), la fila va a una subida nueva", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    const id = idOf(state, "b.pdf");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, id, { status: "error", message: "Sin conexión" });
    state = replaceFile(state, id, { name: "b-bien.pdf", size: 2000, lastModified: 9 });
    state = applyUploadResult(state, id, { status: "error", message: "Esa página del taco ya tiene otro fichero.", code: "ERR-UPLOAD-009" });
    const failed = state.items.find((item) => item.id === id)!;
    expect(failed).toMatchObject({ status: "error", errorMessage: DIGITAL_SLOT_TAKEN_ERROR, errorCode: "ERR-UPLOAD-009" });
    expect(failed.errorMessage).not.toMatch(/taco|página/i);
    expect([failed.batchId, failed.position, failed.tacoNumber]).toEqual([undefined, undefined, undefined]);
    expect(planNewBatches(state, "digital")).toEqual({ blocks: [[id]] });
    expect(settingsLockReason(state)).toBeNull();
  });

  it("con ERR-UPLOAD-009 en un taco, la fila se queda en su página y con el texto del servidor", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "taco-37", tacoNumber: 37 });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "Esa página del taco ya tiene otro fichero.", code: "ERR-UPLOAD-009" });
    expect(state.items[1]).toMatchObject({ errorMessage: "Esa página del taco ya tiene otro fichero.", batchId: "taco-37", tacoNumber: 37, position: 2 });
  });

  it("«Cambiar el fichero» conserva la tanda y la página", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "taco-37", tacoNumber: 37 });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "No se puede leer." });
    const id = idOf(state, "b.pdf");
    const replaced = replaceFile(state, id, { name: "b-bien.pdf", size: 2000, lastModified: 9 });
    expect(replaced.items[1]).toMatchObject({ id, name: "b-bien.pdf", size: 2000, status: "queued", batchId: "taco-37", tacoNumber: 37, position: 2 });
    expect(replaced.items[1].errorMessage).toBeUndefined();
    expect(pageOf(replaced, id)).toBe(2);
    // Solo en una fila con error, y con un fichero que valga para el taco.
    expect(replaceFile(state, idOf(state, "a.pdf"), { name: "x.pdf", size: 1, lastModified: 0 })).toBe(state);
    expect(replaceFile(state, id, { name: "x.xml", size: 1, lastModified: 0 })).toBe(state);
    expect(replaceFile(state, id, { name: "x.pdf", size: 21 * MB, lastModified: 0 })).toBe(state);
  });

  it("quitar una fila renumera las demás; la que se está subiendo no se quita", () => {
    let state = add(EMPTY_UPLOAD_LIST, [file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    state = moveToPage(state, idOf(state, "c.pdf"), 1);
    const removed = removeFromUploadList(state, idOf(state, "a.pdf"));
    expect(names(removed)).toEqual(["c.pdf", "b.pdf"]);
    expect(pages(removed)).toEqual([1, 2]);
    expect(removed.manualOrder).toBe(true);
    const uploading = markUploading(state, idOf(state, "b.pdf"));
    expect(removeFromUploadList(uploading, idOf(state, "b.pdf"))).toBe(uploading);
    // Vacía, vuelve al orden por nombre.
    const empty = ["a.pdf", "b.pdf", "c.pdf"].reduce((s, name) => removeFromUploadList(s, idOf(state, name)), state);
    expect(empty).toEqual({ ...EMPTY_UPLOAD_LIST, sortBy: "name" });
  });

  it("la autolimpieza quita lo subido y lo duplicado", () => {
    let state = inBatch(["a.pdf", "b.pdf", "c.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "duplicate", of: "x" });
    state = applyUploadResult(state, idOf(state, "c.pdf"), { status: "error", message: "Sin conexión" });
    expect(names(clearFinishedUploads(state))).toEqual(["c.pdf"]);
  });
});

describe("bloqueo de cliente, lote y tipo", () => {
  it("con ficheros de un taco sin subir", () => {
    let state = inBatch(["a.pdf", "b.pdf"], { id: "taco-37", tacoNumber: 37 });
    expect(settingsLockReason(state)).toBe(
      "Hay ficheros del Taco 37 sin subir: reinténtalos o quítalos de la lista para cambiar el cliente, el lote o el tipo.",
    );
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "ok" });
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "error", message: "Sin conexión" });
    expect(settingsLockReason(state)).toMatch(/^Hay ficheros del Taco 37 sin subir/);
    state = applyUploadResult(state, idOf(state, "b.pdf"), { status: "ok" });
    expect(settingsLockReason(state)).toBeNull();
  });

  it("con ficheros de una subida digital sin subir", () => {
    let state = inBatch(["a.pdf"], { id: "tanda", tacoNumber: null }, "digital");
    state = applyUploadResult(state, idOf(state, "a.pdf"), { status: "error", message: "Sin conexión" });
    expect(settingsLockReason(state)).toBe(
      "Hay ficheros de esta subida sin subir: reinténtalos o quítalos de la lista para cambiar el cliente, el lote o el tipo.",
    );
  });

  it("sin tanda todavía, nada bloquea", () => {
    expect(settingsLockReason(EMPTY_UPLOAD_LIST)).toBeNull();
    expect(settingsLockReason(add(EMPTY_UPLOAD_LIST, [file("a.pdf")]))).toBeNull();
    expect(isUploading(add(EMPTY_UPLOAD_LIST, [file("a.pdf")]))).toBe(false);
  });
});
