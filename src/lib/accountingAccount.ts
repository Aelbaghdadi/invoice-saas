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
 * Al salir del campo, completa la cuenta hasta los 8 dígitos rellenando con
 * ceros, como hacen los programas de contabilidad. El punto es solo un atajo
 * para teclear y no se conserva en el valor final:
 *
 *   "600"   -> "60000000"   (sin punto, la cuenta crece hacia la derecha)
 *   "4.22"  -> "40000022"   (con punto, la subcuenta queda pegada al final)
 *   "430.1" -> "43000001"
 */
export function padAccountingAccount(value: string): string {
  const dotIndex = value.indexOf(".");
  const group = dotIndex === -1 ? value : value.slice(0, dotIndex);
  const subaccount = dotIndex === -1 ? "" : value.slice(dotIndex + 1);

  // Sin ningun digito no hay nada que completar: campo vacio o un punto suelto.
  if (group.length + subaccount.length === 0) return "";

  const zeros = Math.max(0, MAX_DIGITS - group.length - subaccount.length);
  return `${group}${"0".repeat(zeros)}${subaccount}`;
}
