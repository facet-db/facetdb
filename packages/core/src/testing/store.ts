/**
 * An in-memory keyed table for fakes. Entries keep their insertion order, which the fake queue and
 * the fake scan rely on. Nothing here is persisted; each test builds its own.
 */
export class FakeStore<V> {
  readonly #rows = new Map<string, V>();

  get(key: string): V | undefined {
    return this.#rows.get(key);
  }

  has(key: string): boolean {
    return this.#rows.has(key);
  }

  set(key: string, value: V): void {
    this.#rows.set(key, value);
  }

  delete(key: string): boolean {
    return this.#rows.delete(key);
  }

  clear(): void {
    this.#rows.clear();
  }

  entries(): [string, V][] {
    return [...this.#rows.entries()];
  }

  get size(): number {
    return this.#rows.size;
  }
}
