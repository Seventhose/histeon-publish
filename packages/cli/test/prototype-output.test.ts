import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { checkPrototype } from "@histos-publish/server";
import { prototypeRefused, PrototypeRefusedError, refusalDetails } from "../src/prototype-output.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"T","framework":"none","locale":"it-IT"}</script>
</head><body>
<template data-histos="template" data-ref="site/404" data-role="404"><main><h1>Non trovata</h1>{@slot}</main></template>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
</body></html>`;

describe("prototype check --json: i problemi con il loro posto (A7)", () => {
  it("un prototipo rifiutato dà ogni problema con documento, riga e colonna, e il conto, con il codice d'uscita 2", async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cli-prototype-"));
    roots.push(scratchRoot);
    const error = await checkPrototype(html, { scratchRoot }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HistosPublishError);
    const refused = prototypeRefused(error as HistosPublishError);
    expect(refused).toBeInstanceOf(PrototypeRefusedError);
    expect(refused.exitCode).toBe(2);
    expect(refused.code).toBe("cms-prototype-invalid");
    // Before, the JSON held the message alone: {"error": …, "code": …}.
    const details = refusalDetails(refused, (text) => text);
    expect(details).toEqual({
      issues: [{ document: "template site/404", line: 4, column: (html.split("\n")[3] ?? "").indexOf('data-ref="site/404"') + 1, message: expect.stringMatching(/^data-ref="site\/404" non è un nome valido per un template\..*site\/404 diventa site\/pagina-non-trovata\.$/u) }],
      total: 1,
    });
    expect(JSON.parse(JSON.stringify(details))).toEqual(details);
  });

  it("i testi passano dalla stessa pulizia del messaggio; un altro errore non aggiunge nulla", () => {
    const refused = prototypeRefused(Object.assign(new HistosPublishError("x", "cms-prototype-invalid", 422), { issues: [{ document: "page a", line: 3, column: 0, message: "segreto" }, { nope: true }], total: 7 }));
    expect(refusalDetails(refused, (text) => text.toUpperCase())).toEqual({ issues: [{ document: "PAGE A", line: 3, message: "SEGRETO" }], total: 7 });
    expect(refusalDetails(new HistosPublishError("y", "config-invalid", 2), (text) => text)).toEqual({});
    // Without problems carried, the message is the one problem.
    expect(refusalDetails(prototypeRefused(new HistosPublishError("solo", "cms-prototype-invalid", 422)), (text) => text)).toEqual({ issues: [{ message: "solo" }], total: 1 });
  });
});
