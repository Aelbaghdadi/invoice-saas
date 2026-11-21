import { describe, it, expect } from "vitest";
import { describeVatLineMismatch, vatLineFix, vatLineMismatches, type CheckedLine } from "@/lib/vatLineChecks";
import { validateForA3Export, type InvoiceWithClient } from "@/lib/exportFormats";

describe("vatLineMismatches (F-022)", () => {
  it("cuotas correctas, sin marcas", () => {
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21 },
      { taxBase: 200, vatRate: 10, vatAmount: 20 },
      { taxBase: 50, vatRate: 0, vatAmount: 0 },
    ])).toEqual([]);
  });

  it("el caso de la auditoría: cuotas cruzadas entre tipos con el total cuadrado", () => {
    // 100 al 21 % con cuota 20 y 200 al 10 % con cuota 21: suman 341 igual.
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 20 },
      { taxBase: 200, vatRate: 10, vatAmount: 21 },
    ])).toEqual([
      { index: 0, kind: "iva", rate: 21, expected: 21, actual: 20 },
      { index: 1, kind: "iva", rate: 10, expected: 20, actual: 21 },
    ]);
  });

  it("umbral max(0,02 €; 0,5 % de la cuota)", () => {
    // Cuota esperada 2,10: el 0,5 % es menos de 2 céntimos, así que tolera 2.
    expect(vatLineMismatches([{ taxBase: 10, vatRate: 21, vatAmount: 2.12 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 10, vatRate: 21, vatAmount: 2.13 }])).toHaveLength(1);
    // Cuota esperada 21,00: el 0,5 % son 10,5 céntimos.
    expect(vatLineMismatches([{ taxBase: 100, vatRate: 21, vatAmount: 21.1 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 100, vatRate: 21, vatAmount: 20.89 }])).toHaveLength(1);
    // Cuota esperada 2.100,00: el 0,5 % son 10,50 €.
    expect(vatLineMismatches([{ taxBase: 10000, vatRate: 21, vatAmount: 2110.5 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 10000, vatRate: 21, vatAmount: 2110.51 }])).toHaveLength(1);
    // Redondeo a céntimos de la cuota esperada: 33,33 × 21 % = 6,9993 → 7,00.
    expect(vatLineMismatches([{ taxBase: 33.33, vatRate: 21, vatAmount: 7 }])).toEqual([]);
  });

  it("abonos en negativo", () => {
    expect(vatLineMismatches([{ taxBase: -100, vatRate: 21, vatAmount: -21 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: -100, vatRate: 21, vatAmount: 21 }])).toHaveLength(1);
  });

  it("también el recargo de equivalencia, cuando la línea lo lleva", () => {
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2 },
    ])).toEqual([]);
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 1.4 },
    ])).toEqual([{ index: 0, kind: "recargo", rate: 5.2, expected: 5.2, actual: 1.4 }]);
    // Sin recargo (null) no se mira.
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
    ])).toEqual([]);
  });

  it("la cuota autorrepercutida de una compra intracomunitaria sí es base × %", () => {
    for (const op of ["INTRACOM", "INTRACOM_SERVICIOS"]) {
      expect(vatLineMismatches([{ taxBase: 94.46, vatRate: 21, vatAmount: 19.84 }], op, "PURCHASE")).toEqual([]);
      expect(vatLineMismatches([{ taxBase: 94.46, vatRate: 21, vatAmount: 1.98 }], op, "PURCHASE")).toEqual([
        { index: 0, kind: "iva", rate: 21, expected: 19.84, actual: 1.98 },
      ]);
    }
    // En una venta intracomunitaria no hay cuota que comprobar.
    expect(vatLineMismatches([{ taxBase: 100, vatRate: 21, vatAmount: 0 }], "INTRACOM", "SALE")).toEqual([]);
  });

  it("en una compra intracomunitaria, una línea sin cuota no se marca: el export le pone la autorrepercutida", () => {
    for (const op of ["INTRACOM", "INTRACOM_SERVICIOS"]) {
      for (const vatRate of [21, 10, 0]) {
        expect(vatLineMismatches([{ taxBase: 94.46, vatRate, vatAmount: 0 }], op, "PURCHASE")).toEqual([]);
      }
    }
    // En una interior sí.
    expect(vatLineMismatches([{ taxBase: 94.46, vatRate: 21, vatAmount: 0 }], "INTERIOR", "PURCHASE")).toHaveLength(1);
    // Y el export dice lo mismo: A3 recibe el 21 % y 19,84 €, sin avisos.
    const inv = {
      id: "inv-3", type: "PURCHASE", operationType: "INTRACOM_SERVICIOS", invoiceDate: new Date("2026-09-10"), invoiceNumber: "PT-1",
      issuerName: "Serviços Lda", issuerCif: "515160873", issuerCountry: "PT", totalAmount: 94.46,
      supplierAccount: "40000001", expenseAccount: "62300001", client: { id: "c1", name: "ACME SL" },
      vatLines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 0, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null }],
    } as unknown as InvoiceWithClient;
    expect(validateForA3Export([inv])).toEqual([]);
  });

  it("ni en inversión del sujeto pasivo ni en intracomunitarias", () => {
    const line = [{ taxBase: 100, vatRate: 21, vatAmount: 0 }];
    for (const op of ["INVERSION_SP", "INTRACOM", "INTRACOM_SERVICIOS"]) expect(vatLineMismatches(line, op)).toEqual([]);
    expect(vatLineMismatches(line, "INTERIOR")).toHaveLength(1);
    expect(vatLineMismatches(line, "IMPORTACION")).toHaveLength(1);
  });

  it("el texto dice línea, qué cuota y cuánto daría", () => {
    expect(describeVatLineMismatch({ index: 1, kind: "iva", rate: 10, expected: 20, actual: 21 }))
      .toBe("Línea 2: la cuota de IVA es 21,00 € y la base × 10 % da 20,00 €");
    expect(describeVatLineMismatch({ index: 0, kind: "recargo", rate: 5.2, expected: 5.2, actual: 1.4 }))
      .toBe("Línea 1: el recargo de equivalencia es 1,40 € y la base × 5,2 % da 5,20 €");
  });
});

describe("vatLineFix: el arreglo en un clic de cada línea marcada", () => {
  /** El arreglo de cada línea que no cuadra, por posición. */
  const fixes = (lines: CheckedLine[]) => vatLineMismatches(lines).map((m) => [m.index, vatLineFix(lines[m.index].taxBase, m)] as const);

  it("el caso real: otro tipo explica la base y la cuota, y solo cambia el %", () => {
    // Como la guardó el OCR: los tipos de las líneas 2 y 3 cruzados.
    const casoReal = [
      { taxBase: 1289.89, vatRate: 4, vatAmount: 51.6 },
      { taxBase: 1312.18, vatRate: 10, vatAmount: 275.56 },
      { taxBase: 2538.1, vatRate: 21, vatAmount: 253.81 },
    ];
    expect(fixes(casoReal)).toEqual([
      [1, { field: "vatRate", value: "21", label: "Cambiar el tipo a 21 %" }],
      [2, { field: "vatRate", value: "10", label: "Cambiar el tipo a 10 %" }],
    ]);
    // Los dos clics dejan el desglose bien, con las cuotas del documento.
    const fixed = casoReal.map((line, i) => (i === 1 ? { ...line, vatRate: 21 } : i === 2 ? { ...line, vatRate: 10 } : line));
    expect(vatLineMismatches(fixed)).toEqual([]);
  });

  it("si ningún tipo explica la cuota, la recalcula con la base × %", () => {
    expect(fixes([{ taxBase: 100, vatRate: 21, vatAmount: 30 }])).toEqual([
      [0, { field: "vatAmount", value: "21.00", label: "Recalcular la cuota (21,00 €)" }],
    ]);
  });

  it("con la misma tolerancia que el aviso", () => {
    // Al 5 % da 50,00 y el 0,5 % de esa cuota son 25 céntimos.
    expect(fixes([{ taxBase: 1000, vatRate: 10, vatAmount: 50.2 }])[0][1]).toMatchObject({ field: "vatRate", value: "5" });
    expect(fixes([{ taxBase: 1000, vatRate: 10, vatAmount: 50.3 }])[0][1]).toEqual({
      field: "vatAmount", value: "100.00", label: "Recalcular la cuota (100,00 €)",
    });
  });

  it("los tipos con decimales: con coma en el botón y con punto en el campo", () => {
    expect(fixes([{ taxBase: 100, vatRate: 21, vatAmount: 7.5 }])).toEqual([
      [0, { field: "vatRate", value: "7.5", label: "Cambiar el tipo a 7,5 %" }],
    ]);
  });

  it("si lo explican varios, el más cercano", () => {
    // 0,20 al 4 % con cuota 0,04: el 21 % la da exacta; el 10 % y el 7,5 %, a 2 céntimos.
    expect(fixes([{ taxBase: 0.2, vatRate: 4, vatAmount: 0.04 }])[0][1]).toMatchObject({ value: "21" });
  });

  it("abonos en negativo", () => {
    expect(fixes([{ taxBase: -1312.18, vatRate: 10, vatAmount: -275.56 }])[0][1]).toMatchObject({ field: "vatRate", value: "21" });
    expect(fixes([{ taxBase: -100, vatRate: 21, vatAmount: -30 }])[0][1]).toMatchObject({ field: "vatAmount", value: "-21.00" });
  });

  it("el recargo, con los tipos de recargo", () => {
    const recargo = (rate: number, amount: number) => [
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: rate, equivalenceSurchargeAmount: amount },
    ];
    expect(fixes(recargo(1.4, 5.2))).toEqual([
      [0, { field: "equivalenceSurchargeRate", value: "5.2", label: "Cambiar el recargo a 5,2 %" }],
    ]);
    expect(fixes(recargo(5.2, 1.75))[0][1]).toMatchObject({ value: "1.75", label: "Cambiar el recargo a 1,75 %" });
    expect(fixes(recargo(5.2, 3))).toEqual([
      [0, { field: "equivalenceSurchargeAmount", value: "5.20", label: "Recalcular el recargo (5,20 €)" }],
    ]);
  });

  it("una cuota 0 con el total cuadrado: el 0 % (la plantilla del OCR trae el 21 %)", () => {
    // Un seguro exento de 100 € leído al 21 % con cuota 0, y total 100.
    expect(fixes([{ taxBase: 100, vatRate: 21, vatAmount: 0 }])).toEqual([
      [0, { field: "vatRate", value: "0", label: "Cambiar el tipo a 0 %" }],
    ]);
    // Con una base pequeña, el 2 % también cabe en la tolerancia (0,02 €),
    // pero no es el tipo de la factura.
    for (const taxBase of [1, 0.8]) {
      expect(fixes([{ taxBase, vatRate: 21, vatAmount: 0 }])[0][1]).toMatchObject({ field: "vatRate", value: "0" });
    }
    // El recargo igual.
    expect(fixes([{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 0 }])).toEqual([
      [0, { field: "equivalenceSurchargeRate", value: "0", label: "Cambiar el recargo a 0 %" }],
    ]);
  });

  it("una cuota 0 con el total descuadrado: no se ha leído, y se recalcula", () => {
    // 100 € al 21 % con cuota 0 y total 121: el 0 % la dejaría descuadrada.
    const sinLeer = (lines: CheckedLine[]) => vatLineMismatches(lines).map((m) => vatLineFix(lines[m.index].taxBase, m, false));
    expect(sinLeer([{ taxBase: 100, vatRate: 21, vatAmount: 0 }])).toEqual([
      { field: "vatAmount", value: "21.00", label: "Recalcular la cuota (21,00 €)" },
    ]);
    // Ni el 2 % con una base pequeña.
    expect(sinLeer([{ taxBase: 1, vatRate: 21, vatAmount: 0 }])).toEqual([
      { field: "vatAmount", value: "0.21", label: "Recalcular la cuota (0,21 €)" },
    ]);
    expect(sinLeer([{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 0 }])).toEqual([
      { field: "equivalenceSurchargeAmount", value: "5.20", label: "Recalcular el recargo (5,20 €)" },
    ]);
    // Una cuota que sí está la sigue explicando otro tipo: los tipos cruzados
    // no dependen del total.
    expect(sinLeer([{ taxBase: 1312.18, vatRate: 10, vatAmount: 275.56 }])).toEqual([
      { field: "vatRate", value: "21", label: "Cambiar el tipo a 21 %" },
    ]);
  });
});

describe("validateForA3Export con recargo sin %", () => {
  it("no avisa «la base × 0 %», pero sí de que A3 recibirá 0 % con esa cuota", () => {
    const inv = {
      id: "inv-2", type: "PURCHASE", invoiceDate: new Date("2026-04-15"), invoiceNumber: "F-002",
      issuerName: "Suministros S.L.", issuerCif: "B12345674", totalAmount: 126.2,
      supplierAccount: "4000001", expenseAccount: "6000001", client: { id: "c1", name: "ACME SL" },
      vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: 5.2 }],
    } as unknown as InvoiceWithClient;
    expect(validateForA3Export([inv])).toEqual([{
      invoiceId: "inv-2", invoiceNumber: "F-002", severity: "aviso", blockers: [],
      warnings: ["Línea 1: cuota de recargo sin %: A3 recibirá 0 %"],
    }]);
  });
});

describe("validateForA3Export avisa de las cuotas cruzadas", () => {
  const inv = {
    id: "inv-1", type: "PURCHASE", invoiceDate: new Date("2026-04-15"), invoiceNumber: "F-001",
    issuerName: "Suministros S.L.", issuerCif: "B12345674", totalAmount: 341,
    supplierAccount: "4000001", expenseAccount: "6000001", client: { id: "c1", name: "ACME SL" },
    vatLines: [
      { taxBase: 100, vatRate: 21, vatAmount: 20, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
      { taxBase: 200, vatRate: 10, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
    ],
  } as unknown as InvoiceWithClient;

  it("antes devolvía []; ahora un aviso por línea", () => {
    expect(validateForA3Export([inv])).toEqual([{
      invoiceId: "inv-1", invoiceNumber: "F-001", severity: "aviso", blockers: [],
      warnings: [
        "Línea 1: la cuota de IVA es 20,00 € y la base × 21 % da 21,00 €",
        "Línea 2: la cuota de IVA es 21,00 € y la base × 10 % da 20,00 €",
      ],
    }]);
  });
});
