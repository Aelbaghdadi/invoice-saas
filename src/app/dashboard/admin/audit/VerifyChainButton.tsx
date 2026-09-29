"use client";

import { useState } from "react";
import Link from "next/link";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";

type Result = {
  totalInvoices: number;
  brokenChains: number;
  checkedRecords: number;
  firstBreak: { recordId: string; invoiceId: string; invoiceLabel: string; reason: string } | null;
};

const REASONS: Record<string, string> = {
  hash_mismatch: "el registro se ha modificado después de escribirse",
  prev_hash_mismatch: "no encaja con el registro anterior",
  missing_genesis: "el primer registro de la factura no empieza la cadena",
  broken_link: "falta el registro anterior (se ha borrado)",
  fork: "hay dos registros colgando del mismo anterior",
};

/** Verificación de la cadena de auditoría de la asesoría (F-048). */
export function VerifyChainButton() {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/admin/verify-audit", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo verificar la cadena.");
      setResult(data);
      setState("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo verificar la cadena.");
      setState("error");
    }
  }

  const n = (count: number, one: string, many: string) => `${count.toLocaleString("es-ES")} ${count === 1 ? one : many}`;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
      <button
        type="button"
        onClick={verify}
        disabled={state === "loading"}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
      >
        {state === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
        Verificar la cadena
      </button>
      {state === "loading" && <span className="text-[12px] text-slate-500">Comprobando los registros…</span>}
      {error && <span className="text-[12px] text-red-600">{error}</span>}
      {state === "idle" && result && result.brokenChains === 0 && (
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-green-700">
          <ShieldCheck className="h-3.5 w-3.5" />
          Cadena íntegra: {n(result.checkedRecords, "registro", "registros")} de {n(result.totalInvoices, "factura", "facturas")}.
        </span>
      )}
      {state === "idle" && result && result.brokenChains > 0 && result.firstBreak && (
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-red-700">
          <ShieldAlert className="h-3.5 w-3.5" />
          <strong>Cadena rota en {n(result.brokenChains, "factura", "facturas")}.</strong>
          Primer fallo: registro <code className="rounded bg-red-50 px-1">{result.firstBreak.recordId}</code> de la factura{" "}
          <Link href={`/dashboard/worker/review/${result.firstBreak.invoiceId}`} className="underline">
            {result.firstBreak.invoiceLabel}
          </Link>
          : {REASONS[result.firstBreak.reason] ?? result.firstBreak.reason}.
        </span>
      )}
    </div>
  );
}
