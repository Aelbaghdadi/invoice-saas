/**
 * Semaforo en memoria: como mucho `limit` tareas a la vez; las demas esperan
 * en orden de llegada. Se libera tambien si la tarea falla.
 */
export class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Límite no válido: ${limit}`);
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Cambia el limite; si sube, arranca las que esperaban. */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Límite no válido: ${limit}`);
    this.limit = limit;
    this.drain();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  // drain sube running antes de despertar a la siguiente: otra que llegue
  // entre medias ya ve el hueco ocupado y no se cuela.
  private release(): void {
    this.running--;
    this.drain();
  }

  private drain(): void {
    while (this.running < this.limit && this.queue.length > 0) {
      this.running++;
      this.queue.shift()!();
    }
  }
}
