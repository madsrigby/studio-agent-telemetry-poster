// cache.ts — tiny per-instance TTL cache. Its only job is to absorb a BI tool
// re-reading the same page several times in a minute.

export class TtlCache<T> {
  private map = new Map<string, { value: T; expires: number; created: number }>();

  constructor(
    private ttlMs: number,
    private max: number,
    private now: () => number = () => Date.now()
  ) {}

  get(key: string): { value: T; ageMs: number } | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    const t = this.now();
    if (hit.expires <= t) {
      this.map.delete(key);
      return undefined;
    }
    return { value: hit.value, ageMs: t - hit.created };
  }

  set(key: string, value: T): void {
    const t = this.now();
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: t + this.ttlMs, created: t });
  }

  get size(): number {
    return this.map.size;
  }
}
