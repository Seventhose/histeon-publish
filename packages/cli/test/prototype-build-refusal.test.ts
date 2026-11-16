import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { checkPrototype } from "@histos-publish/server";
import { prototypeRefused, PrototypeRefusedError, refusalDetails } from "../src/prototype-output.js";

/**
 * `histos-publish prototype check` on a prototype whose site would not build (D8): two contents on one address are
 * problems of the check, not a valid answer followed by a build that fails. Exit code 2, and with --json every
 * problem, as for any refused prototype.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a","name":"Blog","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="content">{"types":[{"key":"opera","label":"Opere","fields":[]}],"taxonomies":[{"key":"blog","label":"Rubriche","types":["opera"]}],"terms":[{"taxonomy":"blog","slug":"ciao","label":"Ciao"}],"records":[{"type":"opera","slug":"ehi","title":"Ehi","status":"published","publishedAt":"2026-10-01T09:00:00Z","terms":{"blog":["ciao"]}}]}</script>
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><h1>Home</h1></template>
<template data-histos="post" data-slug="ciao" data-title="Ciao" data-published-at="2026-10-20T08:30:00Z"><p>Ciao.</p></template>
</body></html>`;

describe("prototype check: un sito che non si costruisce è un prototipo rifiutato (D8)", () => {
  it("un indirizzo conteso esce con il codice 2 e, con --json, il problema con i due nomi", async () => {
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-cli-routes-"));
    roots.push(scratchRoot);
    const error = await checkPrototype(html, { scratchRoot }).catch((reason: unknown) => reason);
    // Before: «Prototipo valido», and the first build stopped on EEXIST.
    expect(error).toBeInstanceOf(HistosPublishError);
    const refused = prototypeRefused(error as HistosPublishError);
    expect(refused).toBeInstanceOf(PrototypeRefusedError);
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toBe("Due contenuti avrebbero lo stesso indirizzo /blog/ciao/: l'articolo «ciao» e l'archivio del termine «ciao» (blog). Cambia lo slug di uno dei due, o la chiave del tipo o della tassonomia.");
    expect(refusalDetails(refused, (text) => text)).toEqual({ issues: [{ message: refused.message }], total: 1 });
  });
});
