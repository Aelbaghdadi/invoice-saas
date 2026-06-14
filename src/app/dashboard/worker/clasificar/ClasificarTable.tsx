"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { classifyInvoice, discardUnclassified } from "./actions";

type Row = {
  id: string;
  filename: string;
  type: "PURCHASE" | "SALE";
  issuerCif: string | null;
  receiverCif: string | null;
  total: number | null;
  date: string | null;
  reason: string | null;
  candidates: { id: string; name: string }[];
};

const REASON_LABEL: Record<string, string> = {
  no_cif: "Sin CIF legible",
  invalid_cif: "CIF no válido (revisar OCR)",
  no_match: "Ningún CIF coincide",
  ambiguous: "Ambiguo (revisar tipo/empresa)",
  periodo_cerrado: "Periodo cerrado",
};

export function ClasificarTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <th className="px-4 py-3">Archivo</th>
            <th className="px-4 py-3">Tipo</th>
            <th className="px-4 py-3">CIF detectado</th>
            <th className="px-4 py-3">Total</th>
            <th className="px-4 py-3">Motivo</th>
            <th className="px-4 py-3">Empresa</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((row) => (
            <RowItem key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowItem({ row }: { row: Row }) {
  const { success, error: toastError } = useToast();
  const router = useRouter();
  const [clientId, setClientId] = useState(row.candidates[0]?.id ?? "");
  const [pending, start] = useTransition();
  // El CIF del lado del cliente (el que no casó): receptor en compra, emisor en venta.
  const sideCif = row.type === "PURCHASE" ? row.receiverCif : row.issuerCif;

  const onClassify = () => {
    if (!clientId) return;
    start(async () => {
      const res = await classifyInvoice(row.id, clientId);
      if (res?.error) toastError(res.error);
      else {
        success("Factura clasificada");
        router.refresh();
      }
    });
  };

  const onDiscard = () => {
    start(async () => {
      const res = await discardUnclassified(row.id);
      if (res?.error) toastError(res.error);
      else {
        success("Factura descartada");
        router.refresh();
      }
    });
  };

  return (
    <tr className="text-[13px] text-slate-700 hover:bg-slate-50/60">
      <td className="px-4 py-3 max-w-[180px] truncate" title={row.filename}>{row.filename}</td>
      <td className="px-4 py-3">{row.type === "PURCHASE" ? "Recibida" : "Emitida"}</td>
      <td className="px-4 py-3 font-mono text-[12px]">{sideCif || <span className="text-slate-400">—</span>}</td>
      <td className="px-4 py-3 tabular-nums">{row.total != null ? `${row.total.toFixed(2)} €` : "—"}</td>
      <td className="px-4 py-3">
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
          {REASON_LABEL[row.reason ?? ""] ?? "Por clasificar"}
        </span>
      </td>
      <td className="px-4 py-3">
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={pending || row.candidates.length === 0}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {row.candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onClassify}
            disabled={pending || !clientId}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Clasificar
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={pending}
            title="No pertenece a ninguna de estas empresas"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
