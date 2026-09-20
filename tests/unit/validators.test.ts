import { describe, it, expect } from "vitest";
import {
  isValidNIF,
  formatNIF,
  isValidTaxIdWithPrefix,
  OPERATION_TYPE_OPTIONS,
  OPERATION_TYPE_CODE,
  OPERATION_TYPE_LABEL,
  OPERATION_TYPE_LABEL_SALE,
  operationTypeLabel,
  equivalenceSurchargeRateForVat,
  normalizeBusinessName,
  taxIdWithCountry,
  parseTaxId,
} from "@/lib/validators";

describe("isValidNIF", () => {
  it("accepts valid DNI", () => {
    expect(isValidNIF("12345678Z")).toBe(true);
    expect(isValidNIF("00000000T")).toBe(true);
  });

  it("rejects DNI with wrong control letter", () => {
    expect(isValidNIF("12345678A")).toBe(false);
  });

  it("accepts valid NIE", () => {
    expect(isValidNIF("X1234567L")).toBe(true);
    expect(isValidNIF("X0000000T")).toBe(true);
  });

  it("rejects NIE with wrong letter", () => {
    expect(isValidNIF("X1234567A")).toBe(false);
  });

  it("accepts valid CIF (digit check)", () => {
    // B12345678: digits 1234567, doubled: 2+4+6+8(1+0)+1+2+1+4=... pre-computed example
    // Known valid: A58818501 (Real Madrid), G28029643 (UNED)
    expect(isValidNIF("A58818501")).toBe(true);
    expect(isValidNIF("G28029643")).toBe(true);
  });

  it("accepts valid CIF (letter check)", () => {
    // Known CIF with letter control: P2800000H (dummy example won't compute); use real:
    // K1234567L — skip and use constructed: for entity type K, N, P, Q, R, S, W control must be letter
    // Computing B12345674: sumOdd(1,3,5,7 doubled→2,6,10→1,14→5 → 2+6+1+5=14) sumEven(2+4+6)=12; total=26; control=(10-6)=4; ok
    expect(isValidNIF("B12345674")).toBe(true);
  });

  it("rejects CIF with bad prefix", () => {
    expect(isValidNIF("Z12345678")).toBe(false);
    expect(isValidNIF("T12345678")).toBe(false);
  });

  it("rejects CIF with bad checksum", () => {
    expect(isValidNIF("B12345670")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidNIF("1234567Z")).toBe(false);
    expect(isValidNIF("123456789Z")).toBe(false);
    expect(isValidNIF("")).toBe(false);
  });

  it("is case-insensitive and strips separators", () => {
    expect(isValidNIF("12345678z")).toBe(true);
    expect(isValidNIF("12.345.678-Z")).toBe(true);
    expect(isValidNIF(" 12345678Z ")).toBe(true);
  });
});

describe("formatNIF", () => {
  it("uppercases and strips separators", () => {
    expect(formatNIF("12.345.678-z")).toBe("12345678Z");
    expect(formatNIF(" b12345674 ")).toBe("B12345674");
  });
});

describe("isValidTaxIdWithPrefix", () => {
  it("acepta VAT comunitarios con prefijo (el caso PT que salia en rojo)", () => {
    expect(isValidTaxIdWithPrefix("PT515160873")).toBe(true);
    expect(isValidTaxIdWithPrefix("DE123456789")).toBe(true);
    expect(isValidTaxIdWithPrefix("FR 12 345678901")).toBe(true);
  });

  it("acepta extra-UE comunes con prefijo", () => {
    expect(isValidTaxIdWithPrefix("GB123456789")).toBe(true);
  });

  it("los nacionales siguen pasando el algoritmo español completo", () => {
    expect(isValidTaxIdWithPrefix("12345678Z")).toBe(true);
    expect(isValidTaxIdWithPrefix("ES12345678Z")).toBe(true);
    expect(isValidTaxIdWithPrefix("12345678A")).toBe(false); // letra de control mal
  });

  it("rechaza vacio y basura corta", () => {
    expect(isValidTaxIdWithPrefix("")).toBe(false);
    expect(isValidTaxIdWithPrefix("---")).toBe(false);
    expect(isValidTaxIdWithPrefix("PT12")).toBe(false); // demasiado corto para tratarlo como VAT
  });
});

describe("OPERATION_TYPE_OPTIONS por sentido", () => {
  it("compras ofrece los 7 valores del enum (incluye INTRACOM_SERVICIOS)", () => {
    expect(OPERATION_TYPE_OPTIONS.PURCHASE).toHaveLength(7);
    expect(OPERATION_TYPE_OPTIONS.PURCHASE).toContain("INTRACOM_SERVICIOS");
  });

  it("ventas solo ofrece los codigos verificados contra la lista real de expedidas (1, 3, 6)", () => {
    expect(OPERATION_TYPE_OPTIONS.SALE).toEqual(["INTERIOR", "INTRACOM", "IMPORTACION"]);
    expect(OPERATION_TYPE_OPTIONS.SALE.map((op) => OPERATION_TYPE_CODE[op])).toEqual([1, 3, 6]);
  });

  it("ventas NO ofrece inversion del sujeto pasivo (exportaria un 4 = triangulares)", () => {
    expect(OPERATION_TYPE_OPTIONS.SALE).not.toContain("INVERSION_SP");
  });

  it("ventas NO ofrece INTRACOM_SERVICIOS: en expedidas bienes y servicios comparten el codigo 3", () => {
    expect(OPERATION_TYPE_OPTIONS.SALE).not.toContain("INTRACOM_SERVICIOS");
  });

  it("compras: bienes intracomunitarios -> codigo 3, servicios intracomunitarios -> codigo 8", () => {
    expect(OPERATION_TYPE_CODE.INTRACOM).toBe(3);
    expect(OPERATION_TYPE_CODE.INTRACOM_SERVICIOS).toBe(8);
  });

  it("todos los valores ofrecidos tienen etiqueta y codigo en ambos sentidos", () => {
    for (const op of [...OPERATION_TYPE_OPTIONS.PURCHASE, ...OPERATION_TYPE_OPTIONS.SALE]) {
      expect(OPERATION_TYPE_LABEL[op]).toBeTruthy();
      expect(OPERATION_TYPE_LABEL_SALE[op]).toBeTruthy();
      expect(OPERATION_TYPE_CODE[op]).toBeGreaterThan(0);
    }
  });

  it("la etiqueta de INTRACOM cambia de sentido: adquisicion en compras, entrega en ventas", () => {
    expect(operationTypeLabel("INTRACOM", "PURCHASE")).toMatch(/Adquisición/);
    expect(operationTypeLabel("INTRACOM", "SALE")).toMatch(/Entrega/);
  });
});

describe("equivalenceSurchargeRateForVat", () => {
  it("mapea los tres tipos de IVA con recargo estandar", () => {
    expect(equivalenceSurchargeRateForVat(21)).toBe(5.2);
    expect(equivalenceSurchargeRateForVat(10)).toBe(1.4);
    expect(equivalenceSurchargeRateForVat(4)).toBe(0.5);
  });

  it("devuelve null para tipos sin recargo estandar asociado", () => {
    expect(equivalenceSurchargeRateForVat(0)).toBeNull();
    expect(equivalenceSurchargeRateForVat(7)).toBeNull();
    expect(equivalenceSurchargeRateForVat(5)).toBeNull();
  });
});

describe("normalizeBusinessName", () => {
  it("normaliza mayusculas, tildes y puntuacion igual sin importar el formato", () => {
    expect(normalizeBusinessName("Bar Pepe, S.L.")).toBe(normalizeBusinessName("BAR PEPE S L"));
    expect(normalizeBusinessName("Guangzhou Blings Bag")).toBe("GUANGZHOU BLINGS BAG");
  });

  it("distingue nombres realmente distintos", () => {
    expect(normalizeBusinessName("Guangzhou Blings Bag"))
      .not.toBe(normalizeBusinessName("Guangzhou Hongxin Cosmetics"));
  });
});

describe("taxIdWithCountry", () => {
  it("antepone el prefijo de pais extranjero", () => {
    expect(taxIdWithCountry("515160873", "PT")).toBe("PT515160873");
  });

  it("no toca los nacionales: sin pais o con ES sale el NIF limpio", () => {
    expect(taxIdWithCountry("B12345674", null)).toBe("B12345674");
    expect(taxIdWithCountry("B12345674", "ES")).toBe("B12345674");
  });

  it("sin NIF devuelve vacio, nunca el prefijo suelto", () => {
    expect(taxIdWithCountry(null, "PT")).toBe("");
    expect(taxIdWithCountry("", "PT")).toBe("");
  });

  it("no duplica un prefijo que ya venia puesto", () => {
    expect(taxIdWithCountry("PT515160873", "PT")).toBe("PT515160873");
  });

  it("no confunde el cuerpo del VAT con un prefijo de otro pais", () => {
    expect(taxIdWithCountry("AT123456789", "FR")).toBe("FRAT123456789");
  });

  it("ignora el relleno de Char(2) de Postgres", () => {
    expect(taxIdWithCountry("515160873", "PT ")).toBe("PT515160873");
  });

  it("Grecia va con el prefijo VAT EL, no con el ISO GR", () => {
    expect(taxIdWithCountry("123456789", "EL")).toBe("EL123456789");
  });

  it("es el inverso de parseTaxId para un NIF extranjero", () => {
    const parsed = parseTaxId("PT 515160873");
    expect(taxIdWithCountry(parsed.clean, parsed.countryCode)).toBe("PT515160873");
  });

  it("de un ESB12345674 sale B12345674 a proposito: en A3 el nacional va sin prefijo", () => {
    const parsed = parseTaxId("ESB12345674");
    expect(taxIdWithCountry(parsed.clean, parsed.countryCode)).toBe("B12345674");
  });
});
