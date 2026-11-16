import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_LIMITS, HeavyMutex } from "../src/connector-server.js";

/**
 * Doc 17 item 2: one heavy operation at a time, in order. Prototype checks, short and many when agents work in
 * parallel, wait in a longer queue and for longer than the other operations; a refusal says the place in the queue.
 */

afterEach(() => {
  vi.useRealTimers();
});

const live = () => new AbortController().signal;

describe("la coda delle operazioni pesanti del connettore", () => {
  it("tiene in fila fino a checkQueue controlli e heavyQueue altre operazioni, nell'ordine in cui arrivano", async () => {
    const mutex = new HeavyMutex();
    const first = await mutex.acquire(live());
    expect(first && "release" in first).toBe(true);
    const order: string[] = [];
    const waiting: Array<Promise<unknown>> = [];
    for (let index = 0; index < CONNECTOR_LIMITS.checkQueue; index++) {
      waiting.push(mutex.acquire(live(), true).then((turn) => {
        order.push(`check ${index}`);
        if (turn && "release" in turn) turn.release();
      }));
    }
    for (let index = 0; index < CONNECTOR_LIMITS.heavyQueue; index++) {
      waiting.push(mutex.acquire(live()).then((turn) => {
        order.push(`build ${index}`);
        if (turn && "release" in turn) turn.release();
      }));
    }
    expect(mutex.waiting).toBe(CONNECTOR_LIMITS.checkQueue + CONNECTOR_LIMITS.heavyQueue);
    // Full for both: the place it would have, and how many wait.
    const total = CONNECTOR_LIMITS.checkQueue + CONNECTOR_LIMITS.heavyQueue;
    expect(await mutex.acquire(live(), true)).toEqual({ busy: { position: total + 1, waiting: total } });
    expect(await mutex.acquire(live())).toEqual({ busy: { position: total + 1, waiting: total } });
    if (first && "release" in first) first.release();
    await Promise.all(waiting);
    expect(order).toEqual([...Array.from({ length: CONNECTOR_LIMITS.checkQueue }, (_, index) => `check ${index}`), ...Array.from({ length: CONNECTOR_LIMITS.heavyQueue }, (_, index) => `build ${index}`)]);
    expect(mutex.waiting).toBe(0);
  });

  it("un controllo aspetta checkWaitSeconds, un'altra operazione heavyWaitSeconds; poi la posizione che aveva", async () => {
    vi.useFakeTimers();
    const mutex = new HeavyMutex();
    await mutex.acquire(live());
    const build = mutex.acquire(live());
    const check = mutex.acquire(live(), true);
    await vi.advanceTimersByTimeAsync(CONNECTOR_LIMITS.heavyWaitSeconds * 1000);
    expect(await build).toEqual({ busy: { position: 1, waiting: 1 } });
    await vi.advanceTimersByTimeAsync((CONNECTOR_LIMITS.checkWaitSeconds - CONNECTOR_LIMITS.heavyWaitSeconds) * 1000 - 1);
    expect(mutex.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await check).toEqual({ busy: { position: 1, waiting: 0 } });
    expect(CONNECTOR_LIMITS.checkWaitSeconds).toBeGreaterThan(CONNECTOR_LIMITS.heavyWaitSeconds);
  });

  it("un'attesa interrotta lascia la fila e risponde null", async () => {
    const mutex = new HeavyMutex();
    const first = await mutex.acquire(live());
    const controller = new AbortController();
    const waiting = mutex.acquire(controller.signal, true);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(mutex.waiting).toBe(0);
    if (first && "release" in first) first.release();
    expect(await mutex.acquire(live())).toMatchObject({ release: expect.any(Function) });
  });
});
