import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { pbkdf } = createRequire(import.meta.url)("bcrypt-pbkdf") as {
  pbkdf(pass: Uint8Array, passLength: number, salt: Uint8Array, saltLength: number, output: Uint8Array, outputLength: number, rounds: number): number;
};

describe("bcrypt-pbkdf compatibile con il port OpenBSD", () => {
  it("mantiene il vettore noto usando SHA-512 integrato in Node", () => {
    const password = Buffer.from("password");
    const salt = Buffer.from("salt");
    const output = Buffer.alloc(48);

    expect(pbkdf(password, password.length, salt, salt.length, output, output.length, 16)).toBe(0);
    expect(output.toString("hex")).toBe("c339d704ec235f27690d3f12167c05a55bf86d572f270adbf9fe04c379da5f8c7942a939245dbb39ebe26fc2bd19b88b");
  });
});
