import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/crawler-http.js";

describe("crawler private-address policy", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254",
    "::", "::1", "::ffff:10.0.0.1", "::ffff:a00:1", "::127.0.0.1", "::7f00:1",
    "64:ff9b::a00:1", "64:ff9b::127.0.0.1", "64:ff9b:1::a00:1", "64:ff9b:1::808:808",
    "2002:a00:1::", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:f5ff:fffe", "2001:db8::1",
    "100::1", "fc00::1", "fd12::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "64:ff9b::808:808", "2002:808:808::1", "[2606:4700::1]"])("allows public %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
