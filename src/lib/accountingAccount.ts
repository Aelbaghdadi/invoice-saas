/** Dígitos máximos de una cuenta contable (grupo + subcuenta, sin contar el punto separador) */
const MAX_DIGITS = 8;

/**
 * Limpia lo que teclea el usuario en un campo de cuenta contable: solo
 * dígitos y como mucho un punto separador, sin superar los 8 dígitos.
 */
export function sanitizeAccountingAccountInput(raw: string): string {
  let digitCount = 0;
  let sawDot = false;
  let result = "";
  for (const char of raw) {
    if (char === "." && !sawDot) {
      sawDot = true;
      result += char;
      continue;
    }
    if (/\d/.test(char) && digitCount < MAX_DIGITS) {
      digitCount++;
      result += char;
    }
  }
  return result;
}

/**
 * Al salir del campo, si hay un punto, rellena la subcuenta con ceros a la
 * izquierda hasta completar 8 dígitos en total (igual que los programas de
 * contabilidad: "430.1" -> "430.00001").
 */
export function padAccountingAccount(value: string): string {
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return value;

  const group = value.slice(0, dotIndex);
  const subaccount = value.slice(dotIndex + 1);
  const targetLength = MAX_DIGITS - group.length;
  if (targetLength <= 0) return group;

  return `${group}.${subaccount.padStart(targetLength, "0")}`;
}
