/**
 * A set of keys where each key is its own signal: a row that asks `has(its uid)` is updated only when its own answer
 * changes. Selecting or hovering then touches two rows of the structure, not all of them (docs/spec/performance.md,
 * large pages).
 *
 * The signal of a key is made by `ensure()`, called by whoever draws the rows before the rows read it: a signal
 * made inside the reaction that reads it would not be followed by that reaction (Svelte's rule for state created
 * while computing).
 */
class Flag {
  on = $state(false);
}

export class KeyedFlags {
  #flags = new Map<string, Flag>();
  #on = new Set<string>();

  ensure(key: string): void {
    if (this.#flags.has(key)) return;
    const flag = new Flag();
    flag.on = this.#on.has(key);
    this.#flags.set(key, flag);
  }

  has(key: string): boolean {
    return this.#flags.get(key)?.on ?? this.#on.has(key);
  }

  set(keys: Iterable<string>): void {
    const next = new Set(keys);
    for (const key of this.#on) if (!next.has(key)) this.#flip(key, false);
    for (const key of next) if (!this.#on.has(key)) this.#flip(key, true);
    this.#on = next;
  }

  #flip(key: string, on: boolean): void {
    const flag = this.#flags.get(key);
    if (flag) flag.on = on;
  }
}
