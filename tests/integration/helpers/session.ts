/**
 * Sesion simulada (lo unico de NextAuth que se simula): los tests eligen con
 * que usuario actuan. Por defecto no hay sesion.
 */
export type TestSessionUser = {
  id: string;
  role: "ADMIN" | "WORKER" | "CLIENT";
  advisoryFirmId: string | null;
};

let current: { user: TestSessionUser } | null = null;

export function signInAs(user: TestSessionUser) {
  current = { user: { id: user.id, role: user.role, advisoryFirmId: user.advisoryFirmId } };
}

export function signOut() {
  current = null;
}

export function currentSession() {
  return current;
}
