import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { isStorageNotFound, StorageIdleError } from "@/lib/storage";
import { formatBytes } from "@/lib/clientDataExportFormat";

/**
 * Un ZIP que se escribe en streaming (la descarga de datos de un cliente y el
 * archivo del ejercicio): los originales pasan del almacenamiento al ZIP por
 * trozos, y `sink` aplica la contrapresión: no se lee el trozo siguiente hasta
 * que el anterior ha salido.
 */
export type ZipWriter = ReturnType<typeof zipWriter>;

/**
 * fflate por encima, con contrapresion: Zip entrega los trozos por callback
 * (sin esperar); aqui se guardan y se vacian por `sink` antes de seguir.
 * `maxZipBytes`: fflate no escribe ZIP64, y por encima de 4 GiB los offsets
 * de 32 bits dejan el ZIP corrupto; antes de pasarlo, se corta.
 */
export function zipWriter(sink: (chunk: Uint8Array) => Promise<void>, maxZipBytes: number) {
  const pending: Uint8Array[] = [];
  let failure: unknown = null;
  let written = 0;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else pending.push(chunk);
  });
  const flush = async () => {
    if (failure) throw failure;
    while (pending.length > 0) {
      const chunk = pending.shift()!;
      written += chunk.length;
      if (written > maxZipBytes) {
        // Cortar antes que mandar un ZIP que pasa de 4 GiB sin ZIP64.
        failure = new Error(`El ZIP pasaría de ${formatBytes(maxZipBytes)}: descarga cortada`);
        pending.length = 0;
        throw failure;
      }
      try {
        await sink(chunk);
      } catch (err) {
        // El navegador ha cortado la descarga: lo que falle a partir de aqui
        // no es de un original, y no se piden mas a Garage.
        failure = err;
        pending.length = 0;
        throw err;
      }
    }
  };
  return {
    /** Ya no se puede seguir escribiendo: lo que falle ya no es de un original. */
    get closed() {
      return failure !== null;
    },
    async binary(name: string, chunks: AsyncIterable<Uint8Array>, mtime: Date) {
      // Sin comprimir: PDF e imagenes ya lo estan.
      const entry = new ZipPassThrough(name);
      entry.mtime = mtime;
      zip.add(entry);
      try {
        for await (const chunk of chunks) {
          entry.push(chunk);
          await flush();
        }
      } finally {
        // Cortado a mitad, la entrada se cierra igual (queda incompleta y va
        // a ERRORES.txt): una abierta dejaria el ZIP esperando para siempre.
        entry.push(new Uint8Array(0), true);
        await flush();
      }
    },
    async text(name: string, parts: AsyncIterable<string>) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      for await (const part of parts) {
        entry.push(strToU8(part));
        await flush();
      }
      entry.push(new Uint8Array(0), true);
      await flush();
    },
    async end() {
      zip.end();
      await flush();
    },
  };
}

/** Los mismos trozos, contando los bytes. */
export async function* counted(chunks: AsyncIterable<Uint8Array>, add: (n: number) => void): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    add(chunk.length);
    yield chunk;
  }
}

/** Motivo de ERRORES.txt, para quien abra el ZIP. */
export function storageFailure(err: unknown, received: number): string {
  const partial = received > 0 ? `; el fichero del ZIP está incompleto (${formatBytes(received)})` : "";
  if (isStorageNotFound(err)) return "no está en el almacenamiento";
  if (err instanceof StorageIdleError) return `el almacenamiento dejó de responder${partial}`;
  return `no se pudo descargar del almacenamiento${partial}`;
}
