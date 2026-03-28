"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const PdfViewer = dynamic(() => import("./PdfViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-[#1e1e2e]">
      <Loader2 className="h-8 w-8 animate-spin text-white/30" />
    </div>
  ),
});

export default PdfViewer;
