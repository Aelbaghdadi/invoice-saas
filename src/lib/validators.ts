/**
 * Validación de NIF/CIF/NIE español.
 *
 * Formatos:
 * - NIF personal: 8 dígitos + letra (12345678Z)
 * - NIE extranjero: X/Y/Z + 7 dígitos + letra (X1234567L)
 * - CIF empresa: letra + 7 dígitos + dígito/letra (B12345678)
 */

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

const CIF_PREFIXES = "ABCDEFGHJNPQRSUVW";

/** Validate a Spanish NIF (DNI + letter) */
function isValidDNI(nif: string): boolean {
  const match = nif.match(/^(\d{8})([A-Z])$/);
  if (!match) return false;
  const num = parseInt(match[1], 10);
  return match[2] === NIF_LETTERS[num % 23];
}

/** Validate a Spanish NIE (foreigners) */
function isValidNIE(nie: string): boolean {
  const match = nie.match(/^([XYZ])(\d{7})([A-Z])$/);
  if (!match) return false;
  const prefix = { X: "0", Y: "1", Z: "2" }[match[1]]!;
  const num = parseInt(prefix + match[2], 10);
  return match[3] === NIF_LETTERS[num % 23];
}

/** Validate a Spanish CIF (companies) */
function isValidCIF(cif: string): boolean {
  const match = cif.match(/^([A-W])(\d{7})([0-9A-J])$/);
  if (!match) return false;
  if (!CIF_PREFIXES.includes(match[1])) return false;

  const digits = match[2];
  let sumEven = 0;
  let sumOdd = 0;

  for (let i = 0; i < 7; i++) {
    const d = parseInt(digits[i], 10);
    if (i % 2 === 0) {
      // Odd positions (1-indexed): double and sum digits
      const doubled = d * 2;
      sumOdd += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sumEven += d;
    }
  }

  const total = sumEven + sumOdd;
  const control = (10 - (total % 10)) % 10;

  const checkChar = match[3];
  // Some CIF types use letter, others digit, some accept both
  const controlLetter = String.fromCharCode(64 + control); // A=1, B=2...
  return checkChar === String(control) || checkChar === controlLetter;
}

/**
 * Validate any Spanish tax ID (NIF, NIE, or CIF).
 * Returns true if the format and checksum are valid.
 */
export function isValidNIF(value: string): boolean {
  const cleaned = value.toUpperCase().replace(/[\s\-\.]/g, "");
  if (cleaned.length !== 9) return false;
  return isValidDNI(cleaned) || isValidNIE(cleaned) || isValidCIF(cleaned);
}

/** Clean and normalize a NIF/CIF/NIE: uppercase, remove spaces/dashes */
export function formatNIF(value: string): string {
  return value.toUpperCase().replace(/[\s\-\.]/g, "");
}
