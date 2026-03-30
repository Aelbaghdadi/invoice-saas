"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

export function ReprocesarButton({ invoiceId }: { invoiceId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleClick() {
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/process`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Error al reprocesar");
      }
      setSuccess(true);
      // Reload after a short delay so the user sees the success state
      setTimeout(() => window.location.reload(), 1500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3.5 py-2 text-[12px] font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Reprocesando..." : "Reprocesar"}
      </button>
      {success && (
        <p className="mt-2 text-[12px] text-green-600 font-medium">Reprocesamiento iniciado correctamente.</p>
      )}
      {error && (
        <p className="mt-2 text-[12px] text-red-600 font-medium">{error}</p>
      )}
    </div>
  );
}
