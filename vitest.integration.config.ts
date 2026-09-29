import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Tests de integracion contra un Postgres de pruebas (TEST_DATABASE_URL).
// Fuera de tests/unit y de la barrera del Dockerfile. Ver ARCHITECTURE.md →
// Testing. Todos los ficheros comparten la base de datos: uno detras de otro.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/setup/globalSetup.ts"],
    setupFiles: ["tests/integration/setup/perFile.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
