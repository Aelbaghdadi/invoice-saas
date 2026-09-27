import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * S3 minimo en memoria para los tests: guarda lo que se sube, no valida
 * firmas. El modo simula caidas:
 *  - "ok": normal.
 *  - "slow:<ms>": los GET responden bien pero tarde (un OCR o un split lento).
 *  - "slowdown:<ms>": los GET responden tarde y con 500 (un OCR que falla).
 *  - "hold": los GET se quedan esperando hasta releaseGets() (o
 *    releaseGets({ fail: true }), que responde 500). Para cruzar carreras sin
 *    depender de tiempos: el test espera a heldGets() > 0, cambia lo que
 *    quiera y suelta. Los GET que llegan despues de volver a "ok" pasan.
 *  - "down": todo responde 500.
 */
export type FakeS3 = {
  endpoint: string;
  keys: () => string[];
  heldGets: () => number;
  releaseGets: (opts?: { fail?: boolean }) => void;
  put: (key: string, body: Buffer | string) => void;
  setMode: (mode: string) => void;
  clear: () => void;
  close: () => Promise<void>;
};

export async function startFakeS3(bucket: string): Promise<FakeS3> {
  const store = new Map<string, Buffer>();
  let mode = "ok";
  let delayMs = 0;
  const held: { respond: () => void; fail: () => void }[] = [];
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const respond = () => {
      if (mode === "down") {
        res.writeHead(500, { "Content-Type": "application/xml" });
        res.end("<Error><Code>InternalError</Code><Message>caido</Message></Error>");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200, { ETag: '"x"' });
          res.end();
          return;
        }
        if (req.method === "DELETE") {
          store.delete(key);
          res.writeHead(204);
          res.end();
          return;
        }
        const obj = store.get(key);
        if (!obj) {
          res.writeHead(404, { "Content-Type": "application/xml" });
          res.end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code><Message>no existe</Message></Error>");
          return;
        }
        res.writeHead(200, { "Content-Length": obj.length, "Content-Type": "application/octet-stream", ETag: '"x"' });
        res.end(req.method === "HEAD" ? undefined : obj);
      });
    };
    const fail = () => {
      res.writeHead(500, { "Content-Type": "application/xml" });
      res.end("<Error><Code>InvalidArgument</Code><Message>fichero roto</Message></Error>");
    };
    if (mode === "hold" && req.method === "GET") held.push({ respond, fail });
    else if (mode === "slowdown" && req.method === "GET") {
      setTimeout(() => {
        res.writeHead(500, { "Content-Type": "application/xml" });
        res.end("<Error><Code>InvalidArgument</Code><Message>fichero roto</Message></Error>");
      }, delayMs);
    } else if (mode === "slow" && req.method === "GET") setTimeout(respond, delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const prefix = `/${bucket}/`;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    // Claves sin el bucket, como las ve la app.
    keys: () => [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    heldGets: () => held.length,
    releaseGets: ({ fail: failThem = false } = {}) => {
      for (const get of held.splice(0)) (failThem ? get.fail : get.respond)();
    },
    put: (key, body) => store.set(`${prefix}${key}`, Buffer.from(body)),
    setMode: (next) => {
      const [name, ms] = next.split(":");
      mode = name;
      delayMs = Number(ms ?? 0);
    },
    clear: () => {
      store.clear();
      mode = "ok";
      for (const get of held.splice(0)) get.fail();
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

declare global {
  var __facturocrFakeS3: FakeS3 | undefined;
}

/** El S3 en memoria del fichero de tests en curso (lo arranca el setup). */
export function fakeS3(): FakeS3 {
  if (!globalThis.__facturocrFakeS3) throw new Error("El S3 simulado no está arrancado (setup de integración)");
  return globalThis.__facturocrFakeS3;
}
