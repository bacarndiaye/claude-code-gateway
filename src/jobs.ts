export interface Interruptible {
  interrupt?: () => Promise<unknown>;
}

export interface Job {
  id: string;
  cwd: string;
  startedAt: number;
  abort: AbortController;
  /** Renseigné dès que la requête au SDK existe. */
  query?: Interruptible;
}

/** Runs en cours, bornés en nombre : au-delà, le serveur répond 429. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly max: number) {}

  /** Raison de l'échec : identifiant déjà pris, ou capacité atteinte. */
  tryStart(id: string, cwd: string, now: number): Job | 'duplicate' | 'full' {
    if (this.jobs.has(id)) return 'duplicate';
    if (this.jobs.size >= this.max) return 'full';
    const job: Job = { id, cwd, startedAt: now, abort: new AbortController() };
    this.jobs.set(id, job);
    return job;
  }

  finish(id: string): void {
    this.jobs.delete(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Interrompt proprement si le SDK le permet, sinon annule. */
  async interrupt(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    try {
      await job.query?.interrupt?.();
    } finally {
      job.abort.abort();
    }
    return true;
  }

  abortAll(): void {
    for (const job of this.jobs.values()) job.abort.abort();
  }
}
