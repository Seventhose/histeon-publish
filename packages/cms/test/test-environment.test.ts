import { describe, expect, it } from "vitest";

// Doc 23 item 126: the tests run with the certificates the app has, never with the system's (NODE_USE_SYSTEM_CA).
describe("ambiente delle prove", () => {
  it("non usa i certificati di sistema, come l'app", () => {
    expect(process.env.NODE_USE_SYSTEM_CA).toBeUndefined();
  });
});
