"use client";

import { useRef, useState, useTransition } from "react";
import { Upload, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { importAccountsFromExcel } from "./actions";

export function ImportButton({ clientId }: { clientId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    success?: boolean;
    imported?: number;
    error?: string;
    errors?: string[];
  } | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fd = new FormData();
    fd.append("file", file);

    startTransition(async () => {
      const bound = importAccountsFromExcel.bind(null, clientId, null);
      const res = await bound(fd);
      setResult(res);
      // Reset input so same file can be re-selected
      if (inputRef.current) inputRef.current.value = "";
    });
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleFile}
      />
      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Importar desde Excel
      </button>

      {result && (
        <div className={`mt-3 rounded-lg border p-3 text-[13px] ${
          result.success
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-red-200 bg-red-50 text-red-800"
        }`}>
          {result.success ? (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              <span>{result.imported} cuentas importadas correctamente.</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{result.error}</span>
            </div>
          )}
          {result.errors && result.errors.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-[12px]">
              {result.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
