type Waiter = { resume: () => void; key?: string };

/**
 * Semaforo en memoria: como mucho `limit` tareas a la vez; las demas esperan
 * en orden de llegada, salvo las que piden prioridad (van delante). Se libera
 * tambien si la tarea falla.
 */
export class Semaphore {
  private running = 0;
  private readonly queue: Waiter[] = [];

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

  /** Cuantas esperan delante de la que tiene esa clave, o null si no espera. */
  position(key: string): number | null {
    const index = this.queue.findIndex((w) => w.key === key);
    return index < 0 ? null : index;
  }

  /** La que espera con esa clave pasa delante de todas. false si no espera. */
  promote(key: string): boolean {
    const index = this.queue.findIndex((w) => w.key === key);
    if (index < 0) return false;
    const [waiter] = this.queue.splice(index, 1);
    this.queue.unshift(waiter);
    return true;
  }

  async run<T>(task: () => Promise<T>, options: { key?: string; priority?: boolean } = {}): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resume) => {
        const waiter = { resume, key: options.key };
        if (options.priority) this.queue.unshift(waiter);
        else this.queue.push(waiter);
      });
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
      this.queue.shift()!.resume();
    }
  }
}
