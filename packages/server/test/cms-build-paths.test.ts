import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cmsBuildOutputPath } from "../src/cms-api.js";

describe("CMS build output paths", () => {
  const root = path.join(os.tmpdir(), "histos-cms-stage-test", "source");

  it("keeps routes inside the staging root", () => {
    expect(cmsBuildOutputPath(root, "contatti")).toBe(path.join(root, "contatti", "index.html"));
    expect(cmsBuildOutputPath(root, "blog/primo-articolo/")).toBe(path.join(root, "blog", "primo-articolo", "index.html"));
  });

  it.each(["", "/", "..", "../../escape-probe", "blog/../../escape", "a//b", "./a", "blog/..\\..\\..\\escape-probe", "..\\escape", "c:/windows", "a\0b"])("refuses %j", (route) => {
    expect(() => cmsBuildOutputPath(root, route)).toThrow(expect.objectContaining({ code: "cms-build-route-invalid" }));
  });
});
