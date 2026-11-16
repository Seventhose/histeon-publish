import { randomInt } from "node:crypto";

const ATTEMPTS = 8;

/**
 * Creates the Docker network of a local test. `create(extra)` runs `docker network create` with `extra` put before the
 * name, and throws when Docker refuses.
 *
 * Docker gives a new network a subnet from its predefined pools, and on a machine with many stacks, even stopped ones,
 * the pools run out ("all predefined address pools have been fully subnetted"). The test then asks for a small subnet
 * of its own, 10.252.x.y/28, and tries another when Docker says that one is taken. When none works the first refusal
 * is thrown: it is the one that says what happened.
 */
export function createTestNetwork(create, pick = randomInt) {
  try {
    return create([]);
  } catch (first) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        return create(["--subnet", `10.252.${pick(256)}.${pick(16) * 16}/28`]);
      } catch {
        // Taken, or Docker is not there at all: the next one, then the first refusal.
      }
    }
    throw first;
  }
}
