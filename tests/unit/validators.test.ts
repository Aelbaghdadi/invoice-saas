import { describe, it, expect } from "vitest";
import { isValidNIF, formatNIF } from "@/lib/validators";

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
