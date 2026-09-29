type Waiter = { resume: () => void; key?: string; priority?: boolean };

/**
 * Semaforo en memoria: como mucho `limit` tareas a la vez; las demas esperan
 * en orden de llegada, salvo las que piden prioridad: van delante de las
 * demas, pero entre ellas tambien por orden de llegada. Se libera tambien si
 * la tarea falla.
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

  /** La que espera con esa clave pasa a prioritaria (detras de las que ya lo
   *  eran). false si no espera. */
  promote(key: string): boolean {
    const index = this.queue.findIndex((w) => w.key === key);
    if (index < 0) return false;
    if (this.queue[index].priority) return true;
    const [waiter] = this.queue.splice(index, 1);
    waiter.priority = true;
    this.enqueue(waiter);
    return true;
  }

  async run<T>(task: () => Promise<T>, options: { key?: string; priority?: boolean } = {}): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resume) => {
        this.enqueue({ resume, key: options.key, priority: options.priority });
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

  // Las prioritarias, detras de la ultima prioritaria; las demas, al final.
  private enqueue(waiter: Waiter): void {
    if (!waiter.priority) {
      this.queue.push(waiter);
      return;
    }
    const at = this.queue.findIndex((w) => !w.priority);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, waiter);
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
