import { describe, expect, it } from "vitest";
import { fetchPrototypeAsset } from "../src/prototype-assets.js";

describe("media remoti dei prototipi", () => {
  it.each([
    ["http senza TLS", "http://example.com/a.png"],
    ["credenziali nell'indirizzo", "https://user:pass@example.com/a.png"],
    ["loopback", "https://127.0.0.1/a.png"],
    ["rete privata", "https://192.168.1.10/a.png"],
    ["metadati cloud", "https://169.254.169.254/latest/meta-data"],
    ["indirizzo non valido", "non è un url"],
  ])("rifiuta %s", async (_name, url) => {
    await expect(fetchPrototypeAsset(url, 1024)).rejects.toThrow();
  });
});
