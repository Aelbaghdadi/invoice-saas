/**
 * Alt+←/→ en la revision (F-047). Con el foco en un campo no cambian de
 * factura: el gestor puede estar moviendose por el texto. Pero en Windows y
 * Linux Alt+← es «Atrás» del navegador, que se llevaria lo tecleado sin
 * preguntar, asi que ahi se siguen interceptando. En Mac Option+← mueve por
 * palabras dentro del campo y «Atrás» es Cmd+[ : no se toca.
 *
 *  - "next" / "prev": cambiar de factura (preventDefault y navegar).
 *  - "block": solo preventDefault.
 *  - null: no es un atajo; que haga lo suyo.
 */
export type AltArrowAction = "next" | "prev" | "block" | null;

export function altArrowAction(e: { key: string; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean }, ctx: { inInput: boolean; isMac: boolean }): AltArrowAction {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return null;
  if (ctx.inInput) return ctx.isMac ? null : "block";
  return e.key === "ArrowRight" ? "next" : "prev";
}
