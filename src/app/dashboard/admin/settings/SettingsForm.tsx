"use client";

import { useState, useTransition } from "react";
import {
  Building2, Lock, User, CheckCircle2, AlertCircle, Loader2,
  Mail, Shield, Users,
} from "lucide-react";
import {
  updateFirm, changePassword, updateProfile,
  type ActionState,
} from "./actions";
import { useToast } from "@/components/ui/Toast";

type FirmData = { name: string; cif: string };
type ProfileData = { name: string; email: string };
type TeamMember = { id: string; name: string; email: string; role: string; createdAt: string };

type Props = {
  firm: FirmData;
  profile: ProfileData;
  team: TeamMember[];
};

const TABS = [
  { id: "firm",     label: "Asesoría",    icon: Building2 },
  { id: "profile",  label: "Mi perfil",    icon: User },
  { id: "password", label: "Contraseña",   icon: Lock },
  { id: "team",     label: "Equipo",       icon: Users },
] as const;

type TabId = (typeof TABS)[number]["id"];

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const labelClass = "mb-1.5 block text-[12px] font-medium text-slate-500";

function StatusBanner({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div className={`mb-4 flex items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-medium ${
      state.success
        ? "bg-green-50 text-green-700"
        : "bg-red-50 text-red-600"
    }`}>
      {state.success ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      {state.success ? "Cambios guardados correctamente" : state.error}
    </div>
  );
}

const ROLE_BADGE: Record<string, { label: string; color: string }> = {
  ADMIN:  { label: "Admin",  color: "bg-purple-50 text-purple-700" },
  WORKER: { label: "Gestor", color: "bg-blue-50 text-blue-700" },
  CLIENT: { label: "Cliente", color: "bg-slate-100 text-slate-600" },
};

export function SettingsForm({ firm, profile, team }: Props) {
  const [tab, setTab] = useState<TabId>("firm");

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
      {/* Sidebar tabs */}
      <div className="sm:col-span-1">
        <nav className="space-y-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] font-medium transition ${
                  active
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? "text-blue-600" : "text-slate-400"}`} />
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="sm:col-span-3">
        {tab === "firm"     && <FirmTab firm={firm} />}
        {tab === "profile"  && <ProfileTab profile={profile} />}
        {tab === "password" && <PasswordTab />}
        {tab === "team"     && <TeamTab team={team} />}
      </div>
    </div>
  );
}

// ─── Firm tab ───────────────────────────────────────────────────────────────

function FirmTab({ firm }: { firm: FirmData }) {
  const { success, error: toastError } = useToast();
  const [state, setState] = useState<ActionState>(null);
  const [pending, start]  = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    start(async () => {
      const fd = new FormData(e.currentTarget);
      const res = await updateFirm(null, fd);
      setState(res);
      if (res?.success) {
        success("Ajustes guardados");
      } else if (res?.error) {
        toastError("Error al guardar ajustes");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
          <Building2 className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-slate-800">Datos de la asesoría</h2>
          <p className="text-[12px] text-slate-400">Información fiscal de tu empresa</p>
        </div>
      </div>

      <StatusBanner state={state} />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Nombre / Razón social</label>
          <input name="name" className={inputClass} defaultValue={firm.name} required />
        </div>
        <div>
          <label className={labelClass}>CIF / NIF</label>
          <input name="cif" className={inputClass} defaultValue={firm.cif} required placeholder="B12345678" />
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar cambios
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Profile tab ────────────────────────────────────────────────────────────

function ProfileTab({ profile }: { profile: ProfileData }) {
  const { success, error: toastError } = useToast();
  const [state, setState] = useState<ActionState>(null);
  const [pending, start]  = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    start(async () => {
      const fd = new FormData(e.currentTarget);
      const res = await updateProfile(null, fd);
      setState(res);
      if (res?.success) {
        success("Ajustes guardados");
      } else if (res?.error) {
        toastError("Error al guardar ajustes");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-50">
          <User className="h-5 w-5 text-green-600" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-slate-800">Mi perfil</h2>
          <p className="text-[12px] text-slate-400">Tu información personal de administrador</p>
        </div>
      </div>

      <StatusBanner state={state} />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Nombre</label>
          <input name="name" className={inputClass} defaultValue={profile.name} required />
        </div>
        <div>
          <label className={labelClass}>Email</label>
          <input name="email" type="email" className={inputClass} defaultValue={profile.email} required />
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar perfil
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Password tab ───────────────────────────────────────────────────────────

function PasswordTab() {
  const { success, error: toastError } = useToast();
  const [state, setState] = useState<ActionState>(null);
  const [pending, start]  = useTransition();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    start(async () => {
      const fd = new FormData(e.currentTarget);
      const res = await changePassword(null, fd);
      setState(res);
      if (res?.success) {
        (e.target as HTMLFormElement).reset();
        success("Ajustes guardados");
      } else if (res?.error) {
        toastError("Error al guardar ajustes");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50">
          <Shield className="h-5 w-5 text-amber-600" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-slate-800">Cambiar contraseña</h2>
          <p className="text-[12px] text-slate-400">Actualiza tu contraseña de acceso</p>
        </div>
      </div>

      <StatusBanner state={state} />

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Contraseña actual</label>
          <input name="current" type="password" className={inputClass} required />
        </div>
        <div>
          <label className={labelClass}>Nueva contraseña</label>
          <input name="password" type="password" className={inputClass} required minLength={8} placeholder="Mínimo 8 caracteres" />
        </div>
        <div>
          <label className={labelClass}>Confirmar nueva contraseña</label>
          <input name="confirm" type="password" className={inputClass} required />
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Cambiar contraseña
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Team tab ───────────────────────────────────────────────────────────────

function TeamTab({ team }: { team: TeamMember[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-slate-100 px-6 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-50">
          <Users className="h-5 w-5 text-purple-600" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-slate-800">Equipo</h2>
          <p className="text-[12px] text-slate-400">{team.length} miembros en la asesoría</p>
        </div>
      </div>

      <ul className="divide-y divide-slate-50">
        {team.map((m) => {
          const badge = ROLE_BADGE[m.role] ?? ROLE_BADGE.WORKER;
          return (
            <li key={m.id} className="flex items-center gap-4 px-6 py-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
                <span className="text-[12px] font-bold text-slate-500">
                  {m.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-slate-800 truncate">{m.name}</p>
                <p className="flex items-center gap-1.5 text-[12px] text-slate-400 truncate">
                  <Mail className="h-3 w-3" />
                  {m.email}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${badge.color}`}>
                {badge.label}
              </span>
              <span className="text-[11px] text-slate-300">
                {m.createdAt}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
