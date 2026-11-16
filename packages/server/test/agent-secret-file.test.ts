import { constants as fsConstants } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, lstat: mocks.lstat, open: mocks.open };
});

import { readSecretFile } from "../../core/src/secrets.js";

// The publishing agent is a Linux service (docs/spec/agente-di-pubblicazione.md): it refuses to start elsewhere.
describe.skipIf(process.platform !== "linux")("proprietà dei file segreti agente", () => {
  afterEach(() => vi.resetAllMocks());

  it("rifiuta un file regolare posseduto da un altro utente anche se ha mode 0600", async () => {
    const uid = process.getuid?.() ?? 1000;
    mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, size: 6 });
    mocks.open.mockResolvedValue({
      stat: async () => ({
        isFile: () => true,
        uid: uid === 0 ? 1000 : 0,
        gid: process.getgid?.() ?? 1000,
        mode: 0o100600,
        size: 6,
      }),
      readFile: async () => Buffer.from("secret"),
      close: async () => undefined,
    });

    await expect(readSecretFile("/tmp/secret-fixture", "prova"))
      .rejects.toMatchObject({ code: "agent-secret-file-invalid", exitCode: 4 });
    expect(mocks.open).toHaveBeenCalledWith("/tmp/secret-fixture", fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  });
});
