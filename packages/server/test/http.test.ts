import { lstat, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { PrototypeError, type PrototypeIssue } from "@histos-publish/cms";
import { hideFilePaths, safeErrorIssues, safeErrorIssuesTotal, safeErrorMessage, sendError } from "../src/http.js";
import { checkPrototype, PrototypeInvalidError, prototypeInvalid } from "../src/prototype-check.js";

const example = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function refusal(html: string): Promise<unknown> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-http-errors-"));
  roots.push(root);
  return checkPrototype(html, { scratchRoot: root }).then(() => { throw new Error("Il prototipo doveva essere rifiutato."); }, (error: unknown) => error);
}

/** What sendError writes, as the client reads it. */
function sentBody(send: (response: ServerResponse) => void): Record<string, unknown> {
  let body = "";
  const response = { writeHead: () => response, end: (chunk: Buffer) => { body = chunk.toString("utf8"); } };
  send(response as unknown as ServerResponse);
  return JSON.parse(body) as Record<string, unknown>;
}

describe("errori per il client", () => {
  it("un prototipo rifiutato tiene slug e ref di template lunghi, nella lista e nel messaggio (E4)", async () => {
    const longSlug = "storia-della-nostra-associazione";
    const longRef = "site/pagina-con-barra-laterale-sinistra";
    const html = example
      .replaceAll('data-ref="site/page"', `data-ref="${longRef}"`)
      .replaceAll('data-template="site/page"', `data-template="${longRef}"`)
      .replace('data-slug="contatti"', `data-slug="${longSlug}"`)
      .replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>')
      .replace(`data-slug="home" data-title="Home" data-template="${longRef}"`, 'data-slug="home" data-title="Home" data-template="site/inesistente"');
    const error = await refusal(html);
    expect(error).toBeInstanceOf(PrototypeInvalidError);
    const issues = safeErrorIssues(error) ?? [];
    expect(issues.map((issue) => issue.document)).toEqual(["page home", `page ${longSlug}`]);
    expect(issues[0]?.message).toMatch(/data-template="site\/inesistente" non è un template del prototipo: scegli fra .*site\/pagina-con-barra-laterale-sinistra/u);
    expect(safeErrorMessage(error)).toContain(`page ${longSlug}, riga`);
    expect(safeErrorMessage(error)).toContain(longRef);
    expect(JSON.stringify({ issues, message: safeErrorMessage(error) })).not.toContain("segreto rimosso");
    // The connector's path: its own scrub first, then the same rule.
    expect(safeErrorIssues(error, (text) => text.replaceAll("/nessuna-cartella", "<dati>"))?.[1]?.document).toBe(`page ${longSlug}`);
  });

  it("nelle liste dei prototipi i token restano nascosti, anche quando sembrano slug", () => {
    const tokens = [
      "page-3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10",
      "key-3ax6xnjp29jd6fds4gc373sgvjxteol0", // a long random word with digits
      "abcdef0123456789abcdef0123456789" + "-us6",
      "xoxb-12345-abcdefghij-klmnopqrst-uvwxyz", // a service prefix, slug-shaped
      "Bearer storia-della-nostra-associazione",
      "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "0123456789abcdef0123456789abcdef01234567",
      "dodici-parole_con-un-trattino-basso-lungo",
    ];
    for (const token of tokens) {
      const error = new PrototypeInvalidError(`page x: ${token}`, [{ document: `page ${token}`, line: 3, message: `valore ${token} non ammesso` }]);
      const sent = JSON.stringify({ issues: safeErrorIssues(error), message: safeErrorMessage(error) });
      expect(sent, token).not.toContain(token.replace(/^Bearer /u, ""));
      expect(sent, token).toContain("[segreto rimosso]");
    }
  });

  it("un rifiuto del prototipo tiene ogni slug valido, anche una parola lunga o con cifre, ma non UUID né esadecimali lunghi", () => {
    for (const slug of ["storiadellanostraassociazione", "precipitevolissimevolmente-storia", "covid19-aggiornamenti-della-settimana", "parolalunghissimasenzatrattini-con-un-altra"]) {
      const error = new PrototypeInvalidError(`page ${slug}: x`, [{ document: `page ${slug}`, line: 3, message: "x" }]);
      expect(JSON.stringify({ issues: safeErrorIssues(error), message: safeErrorMessage(error) }), slug).not.toContain("segreto rimosso");
    }
    for (const token of ["0123456789abcdef0123456789abcdef", "pagina-0123456789abcdef0123456789"]) {
      expect(safeErrorMessage(new PrototypeInvalidError(`page ${token}`, [])), token).toBe("page [segreto rimosso]");
    }
  });

  it("gli altri errori nascondono ogni sequenza lunga, anche a forma di slug", () => {
    const passphrase = "tramonto-cavallo-batteria-graffetta";
    expect(safeErrorMessage(new Error(`accesso negato per ${passphrase}`))).toBe("accesso negato per [segreto rimosso]");
    // The code alone is not enough: only the importer's refusal, with its list, keeps slugs.
    expect(safeErrorMessage(new HistosPublishError(`page ${passphrase}`, "cms-prototype-invalid", 422))).toBe("page [segreto rimosso]");
    expect(safeErrorMessage(new PrototypeInvalidError(`page ${passphrase}`, []), { keepSlugs: false })).toBe("page [segreto rimosso]");
  });

  it("un UUID da solo è l'identità di un documento e resta leggibile, in ogni errore (voce 198)", () => {
    const id = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
    // The refusal of the site that lost its document: «…not portable in [segreto rimosso]: url».
    const site = `Testata: The expression scope is not portable in ${id}: url.`;
    expect(safeErrorMessage(new HistosPublishError(site, "cms-remote-rejected", 422))).toBe(site);
    expect(safeErrorMessage(new Error(`A Histeon element has non-portable attributes. Document: ${id.toUpperCase()}.`))).toBe(`A Histeon element has non-portable attributes. Document: ${id.toUpperCase()}.`);
    expect(safeErrorMessage(new Error(`(${id}) e "${id}" e ${id}.zip`))).toBe(`(${id}) e "${id}" e ${id}.zip`);
    expect(safeErrorMessage(new PrototypeInvalidError(`page x: ${id}`, []))).toBe(`page x: ${id}`);
  });

  it("i segreti restano nascosti anche accanto a un UUID o con la sua forma (voce 198)", () => {
    const id = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
    const hidden = (text: string) => safeErrorMessage(new Error(text));
    // A third-party key may be a UUID: after a word that names a credential, or after Bearer, it is a secret.
    for (const text of [`Bearer ${id}`, `token: ${id}`, `api_key=${id}`, `X-Api-Key ${id}`, `Authorization: ${id}`, `password "${id}"`, `chiave ${id}`, `segreto=${id}`, `secret '${id}'`]) {
      expect(hidden(text), text).not.toContain(id);
      expect(hidden(text), text).toContain("[segreto rimosso]");
    }
    // Only a UUID alone: with something around it in the same run, or a longer hex run, it is not an identity.
    for (const run of [`page-${id}`, `${id}-ffff`, `${id}_x`, `${id.replaceAll("-", "")}`, "3b1f0d2e6c55-4c1a-9d9e-6a7f6f3f2a10-aa"]) {
      expect(hidden(`in ${run}.`), run).toBe("in [segreto rimosso].");
    }
    // The secrets of Publish and of a link keep their filter: base64url, hex, a service token, an application password.
    for (const secret of ["aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dEfG2hJ4kL6mN", "0123456789abcdef0123456789abcdef01234567", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "xoxb-12345-abcdefghij"]) {
      expect(hidden(`Document: ${id}, ${secret}`), secret).toBe(`Document: ${id}, [segreto rimosso]`);
    }
  });

  it("il nome di un Worker resta leggibile, i segreti dopo «Worker» no (voce 229)", () => {
    const hidden = (text: string) => safeErrorMessage(new Error(text));
    const long = "arcidiocesi-ortodossa-web-cloudflare-demo";
    for (const text of [
      `Cloudflare ha risposto 400: Cannot attach custom domain: Worker ${long} has no deployments`,
      `Il Worker “${long}” esiste ma non ha ancora una versione pubblicata: premi Prepara e pubblica.`,
      `www.example.test è già collegato al Worker ${long}. Scollegalo o scegli un altro hostname da Cloudflare.`,
      "Il Worker “appaoi-esempio-prova-works” non esiste nell’account Cloudflare selezionato.",
    ]) expect(hidden(text), text).toBe(text);
    // After «Worker», a run that is not a Worker name or reads as random stays hidden; without that word, a long slug too.
    for (const run of ["aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE", "0123456789abcdef0123456789abcdef", "key-3ax6xnjp29jd6fds4gc373sgvjxteol0"]) {
      expect(hidden(`Worker ${run} ok`), run).toBe("Worker [segreto rimosso] ok");
    }
    expect(hidden(`domain ${long}`)).toBe("domain [segreto rimosso]");
  });

  it("oltre i primi 100 problemi il client riceve quanti sono in tutto (E4)", () => {
    const listed: PrototypeIssue[] = Array.from({ length: 100 }, (_, index) => ({ document: "page home", line: index + 1, message: "L'attributo onclick non è ammesso." }));
    // As the importer counts them: the first 100 listed, 150 in all.
    const refused = prototypeInvalid(Object.assign(new PrototypeError("Il prototipo ha 150 errori: …", listed), { total: 150 }));
    expect(refused.total).toBe(150);
    const issues = safeErrorIssues(refused);
    expect(issues).toHaveLength(100);
    expect(safeErrorIssuesTotal(refused, issues?.length ?? 0)).toBe(150);
    expect(sentBody((response) => sendError(response, 422, safeErrorMessage(refused), "cms-prototype-invalid", issues, safeErrorIssuesTotal(refused, issues?.length ?? 0)))).toMatchObject({ code: "cms-prototype-invalid", issuesTotal: 150, issues: expect.any(Array) });
    // A4: a file name in front changes nothing in the count.
    expect(prototypeInvalid(Object.assign(new PrototypeError("…", listed), { total: 150 }), "a.html").total).toBe(150);
    // The whole list, or a count that is not one, sends no total.
    const whole = prototypeInvalid(new PrototypeError("Il prototipo ha 100 errori: …", listed));
    expect(whole.total).toBe(100);
    expect(safeErrorIssuesTotal(whole, 100)).toBeUndefined();
    expect(prototypeInvalid(Object.assign(new PrototypeError("…", listed), { total: "150" })).total).toBe(100);
    expect(prototypeInvalid(Object.assign(new PrototypeError("…", listed), { total: Number.POSITIVE_INFINITY })).total).toBe(100);
    expect(new PrototypeInvalidError("…", listed, 3).total).toBe(100);
    expect(safeErrorIssuesTotal(new HistosPublishError("…", "cms-prototype-invalid", 422), 1)).toBeUndefined();
    expect(sentBody((response) => sendError(response, 422, "…", "cms-prototype-invalid", issues, 100))).not.toHaveProperty("issuesTotal");
    expect(sentBody((response) => sendError(response, 422, "…", "cms-prototype-invalid", undefined, 150))).not.toHaveProperty("issuesTotal");
  });

  it("un messaggio per l'agente non nomina file né cartelle: né la cartella dati né la home dell'utente (16)", async () => {
    // A real error of Node, as the backup of an approved update raises it: the path is in the message and in `path`.
    const root = await mkdtemp(path.join(os.tmpdir(), "Histeon Publish dati "));
    roots.push(root);
    const missing = path.join(root, "histos-projects", "progetto", "media", "sha256", "53", "foto");
    const error = await lstat(missing).then(() => { throw new Error("Il file non doveva esistere."); }, (failure: unknown) => failure as Error);
    expect(error.message).toContain(root);
    const hidden = hideFilePaths(error.message, error);
    expect(hidden).not.toContain(root);
    expect(hidden).not.toContain("Histeon Publish dati");
    expect(hidden).toBe("ENOENT: no such file or directory, lstat '[percorso rimosso]'");
    // Without the error, from its text alone: quoted (spaces included) or bare, POSIX or Windows, and the home folder.
    expect(hideFilePaths("EACCES: permission denied, mkdir '/home/anna rossi/.local/share/histos/connector/backups'")).toBe("EACCES: permission denied, mkdir '[percorso rimosso]'");
    expect(hideFilePaths("ENOSPC: no space left on device, write -> /var/lib/histos/dati/x.tmp")).toBe("ENOSPC: no space left on device, write -> [percorso rimosso]");
    expect(hideFilePaths("EPERM: operation not permitted, rename 'C:\\Users\\Anna Rossi\\AppData\\x' -> 'C:\\Users\\Anna Rossi\\AppData\\y'")).toBe("EPERM: operation not permitted, rename '[percorso rimosso]' -> '[percorso rimosso]'");
    expect(hideFilePaths("Non leggo D:\\Siti\\dati\\foto.png né \\\\server\\condivisa\\x")).toBe("Non leggo [percorso rimosso] né [percorso rimosso]");
    expect(hideFilePaths(`Cartella ${os.homedir()} non scrivibile.`)).not.toContain(os.homedir());
    // What is not a file path stays: a URL of a remote media, "e/o", a fraction, a date.
    const kept = "Non riesco a scaricare https://example.com/media/ehi.png (404): 1/2 dei media, e/o 2026/10/27.";
    expect(hideFilePaths(kept)).toBe(kept);
  });

  it("nasconde tutta la cartella home anche con uno spazio o un apostrofo nel nome, e il resto di un percorso tagliato da uno spazio (9)", () => {
    // os.homedir() reads HOME (USERPROFILE on Windows) on every call.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const withHome = (home: string, check: () => void) => {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      try { check(); } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
    const clean = (text: string, ...names: string[]) => {
      const hidden = hideFilePaths(text);
      for (const name of names) expect(hidden.toLowerCase()).not.toContain(name);
      return hidden;
    };
    withHome("/home/anna rossi", () => {
      expect(os.homedir()).toBe("/home/anna rossi");
      // App-written messages with a bare path: before, "/home/anna" was hidden and "rossi/.local/share/…" went out.
      expect(clean("Non scrivo /home/anna rossi/.local/share/histos-publish/connector/backups/x.tmp: riprova.", "rossi", ".local", "histos-publish")).toBe("Non scrivo [percorso rimosso]: riprova.");
      expect(clean("Cartella dati /home/anna rossi/Histos Publish/dati non scrivibile.", "rossi", "publish", "dati non")).toBe("Cartella dati [percorso rimosso] non scrivibile.");
      expect(clean("Cartella /HOME/Anna Rossi/x e file:///home/anna%20rossi/y.html illeggibili.", "anna", "rossi")).toBe("Cartella [percorso rimosso] e file:[percorso rimosso] illeggibili.");
    });
    withHome("C:\\Users\\Anna Rossi", () => {
      expect(clean("Non leggo C:\\Users\\Anna Rossi\\AppData\\Roaming\\Histeon Publish\\dati\\x.png", "rossi", "appdata", "publish", "x.png")).toBe("Non leggo [percorso rimosso]");
      expect(clean("Non leggo C:/Users/Anna Rossi/AppData/x.png.", "rossi")).toBe("Non leggo [percorso rimosso].");
    });
    withHome("/home/o'brien", () => {
      expect(clean("rename '/home/o'brien/.local/share/x'", "brien", ".local")).toBe("rename '[percorso rimosso]'");
    });
    withHome("/home/altro", () => {
      // Not the home folder: an apostrophe in a quoted path does not end it, and the rest of a path cut by a space goes.
      expect(clean("EPERM: rename '/home/o'brien/.local/share/x' -> '/srv/y'", "brien", ".local")).toBe("EPERM: rename '[percorso rimosso]' -> '[percorso rimosso]'");
      expect(clean("Cartella /srv/Histos Publish/dati non scrivibile", "publish")).toBe("Cartella [percorso rimosso] non scrivibile");
      // A URL or a word after a path stays.
      expect(hideFilePaths("Non leggo /srv/a/b https://example.com/x/y né /srv/c, riprova.")).toBe("Non leggo [percorso rimosso] https://example.com/x/y né [percorso rimosso], riprova.");
    });
  });

  /** Runs `check` with `home` as the user's home folder: os.homedir() reads HOME (USERPROFILE on Windows) on every call. */
  function withHome(home: string, check: () => void): void {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try { check(); } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("nasconde tutto un percorso tra virgolette che parte dalla home, anche con uno spazio in una parte dopo (7)", () => {
    // Before: the home was hidden first, up to the first space, and that ended the quoted path: the agent read
    // «open '[percorso rimosso] di Anna Rossi.html'», «mkdir '[percorso rimosso] Publish'».
    withHome("/home/anna", () => {
      expect(hideFilePaths("ENOENT: no such file or directory, open '/home/anna/Documenti/Sito di Anna Rossi.html'")).toBe("ENOENT: no such file or directory, open '[percorso rimosso]'");
      expect(hideFilePaths("ENOENT: no such file or directory, open '/home/anna/My Site'")).toBe("ENOENT: no such file or directory, open '[percorso rimosso]'");
      expect(hideFilePaths("mkdir \"/home/anna/Histos Publish\" e `/home/anna/Sito di prova`")).toBe("mkdir \"[percorso rimosso]\" e `[percorso rimosso]`");
      expect(hideFilePaths("Non leggo 'file:///home/anna/Sito di prova/x.html'.")).toBe("Non leggo '[percorso rimosso]'.");
    });
    withHome("/home/anna rossi", () => {
      expect(hideFilePaths("EACCES: permission denied, mkdir '/home/anna rossi/.local/share/Histos Publish'")).toBe("EACCES: permission denied, mkdir '[percorso rimosso]'");
      expect(hideFilePaths("EPERM: operation not permitted, rename '/home/anna rossi/.local/share/Histos Publish' -> '/home/anna rossi/x'")).toBe("EPERM: operation not permitted, rename '[percorso rimosso]' -> '[percorso rimosso]'");
      expect(hideFilePaths("ENOENT: no such file or directory, open '/home/anna rossi/Documenti/Sito di Anna.html'")).toBe("ENOENT: no such file or directory, open '[percorso rimosso]'");
    });
    withHome("/Users/anna", () => {
      expect(hideFilePaths("EPERM: operation not permitted, rename '/Users/anna/Library/Application Support/Histos Publish/connector/x.tmp' -> '/Users/anna/Library/Application Support/Histos Publish'")).toBe("EPERM: operation not permitted, rename '[percorso rimosso]' -> '[percorso rimosso]'");
    });
    withHome("C:\\Users\\Anna", () => {
      expect(hideFilePaths("EPERM: operation not permitted, mkdir 'C:\\Users\\Anna\\AppData\\Roaming\\Histeon Publish'")).toBe("EPERM: operation not permitted, mkdir '[percorso rimosso]'");
    });
    // A quote in the home's name, followed by a space or a separator, does not end the path either.
    withHome("/home/l' anna", () => {
      expect(hideFilePaths("open '/home/l' anna/Sito di prova.html' -> '/home/l' anna'")).toBe("open '[percorso rimosso]' -> '[percorso rimosso]'");
    });
    withHome("/home/anna'", () => {
      expect(hideFilePaths("Non leggo '/home/anna'/Sito di prova.html' né /home/anna'/x y.")).toBe("Non leggo '[percorso rimosso]' né [percorso rimosso] y.");
    });
  });

  it("nasconde la cartella dati anche fuori dalla home, e la home o un percorso tagliati dal limite di 4 KiB (7)", () => {
    withHome("/home/anna", () => {
      // The data folder the app was started with (--data-dir) or by default (HISTOS_PUBLISH_DATA_DIR): unquoted, a
      // space in it left the rest of its name.
      expect(hideFilePaths("Cartella dati /srv/Histos Publish dati/connector non scrivibile.", undefined, ["/srv/Histos Publish dati"])).toBe("Cartella dati [percorso rimosso] non scrivibile.");
      expect(hideFilePaths("Non leggo D:\\Siti Web\\Histeon dati\\x.png, riprova.", undefined, ["D:\\Siti Web\\Histeon dati"])).toBe("Non leggo [percorso rimosso], riprova.");
      const saved = process.env.HISTOS_PUBLISH_DATA_DIR;
      process.env.HISTOS_PUBLISH_DATA_DIR = "/srv/Dati di Anna";
      try {
        expect(hideFilePaths("Cartella /srv/Dati di Anna/histos-projects non scrivibile.")).toBe("Cartella [percorso rimosso] non scrivibile.");
      } finally {
        if (saved === undefined) delete process.env.HISTOS_PUBLISH_DATA_DIR;
        else process.env.HISTOS_PUBLISH_DATA_DIR = saved;
      }
    });
    withHome("/home/anna rossi", () => {
      // The 4 KiB cut inside the home: before, «/home/anna» was hidden and «ro» went out.
      const prefix = "Non leggo ";
      for (const quote of ["", "'"]) {
        for (const inside of [1, 11, 13, 15]) {
          const filler = "·".repeat(4096 - prefix.length - quote.length - inside);
          const hidden = hideFilePaths(`${filler}${prefix}${quote}/home/anna rossi/Sito di prova/x.html${quote}`);
          expect(hidden).toBe(`${filler}${prefix}${quote}[percorso rimosso]`);
        }
      }
      // A quoted path the cut leaves open goes to the end; one that is closed keeps what follows it.
      const filler = "·".repeat(4096 - 30);
      expect(hideFilePaths(`${filler}apro '/srv/Sito di prova/una pagina lunga.html'`)).toBe(`${filler}apro '[percorso rimosso]`);
      expect(hideFilePaths("apro '/srv/Sito di prova/x.html' e poi l'/srv/a: fine")).toBe("apro '[percorso rimosso]' e poi l'[percorso rimosso]: fine");
    });
  });

  /** Runs `check` with HISTOS_PUBLISH_DATA_DIR set to `folder`: the default data folder hideFilePaths always hides. */
  function withDataDirectory(folder: string, check: () => void): void {
    const saved = process.env.HISTOS_PUBLISH_DATA_DIR;
    process.env.HISTOS_PUBLISH_DATA_DIR = folder;
    try { check(); } finally {
      if (saved === undefined) delete process.env.HISTOS_PUBLISH_DATA_DIR;
      else process.env.HISTOS_PUBLISH_DATA_DIR = saved;
    }
  }

  it("un apostrofo dopo una lettera non apre un percorso tra virgolette: il testo che segue resta (S2)", () => {
    withHome("/home/anna", () => {
      // Before: «Non trovo l'[percorso rimosso]' qui.», the path ran from the elision to the quote after ENOENT.
      expect(hideFilePaths("Non trovo l'/home/anna/Sito.html, c'è un errore: 'ENOENT' qui.")).toBe("Non trovo l'[percorso rimosso], c'è un errore: 'ENOENT' qui.");
      // The same outside the private folders («nell'[percorso rimosso]' qui.» before).
      expect(hideFilePaths("Il file è nell'/srv/x, c'è 'altro' qui.")).toBe("Il file è nell'[percorso rimosso], c'è 'altro' qui.");
      expect(hideFilePaths("Dall'/srv/a e dell'C:\\b, c'è `x` e 'y'.")).toBe("Dall'[percorso rimosso] e dell'[percorso rimosso], c'è `x` e 'y'.");
      // A quote after a space, a bracket, "=" or another quote still opens one, and takes it whole.
      expect(hideFilePaths("quell'\"/srv/c d\", (\"/srv/e f\") e path='/srv/g h'.")).toBe("quell'\"[percorso rimosso]\", (\"[percorso rimosso]\") e path='[percorso rimosso]'.");
    });
    withHome("/home/anna rossi", () => {
      // The home after an elision is still hidden whole, a space in it included.
      expect(hideFilePaths("Non trovo l'/home/anna rossi/Sito.html, c'è 'x'.")).toBe("Non trovo l'[percorso rimosso], c'è 'x'.");
    });
  });

  it("una cartella privata conta solo dove comincia un percorso, mai nell'indirizzo di un sito (S3)", () => {
    withHome("/home/anna", () => withDataDirectory("/data", () => {
      // Before: «https://example.com[percorso rimosso] (404)», «https:[percorso rimosso].example.com», «ui[percorso rimosso]».
      for (const text of [
        "Media ehi: non scaricato https://example.com/data/ehi.png (404).",
        "Scarico https://data.example.com/x.png, https://data/x.png e https://example.com:8080/data/y.png.",
        "Il template ui/data/card e blocks/data non ci sono.",
        "Vedi https://example.com/home/anna/x.png o https://example.com//home/anna.",
      ]) expect(hideFilePaths(text)).toBe(text);
      // Where a path starts (after ":" that is not "://", "=", a bracket), in a file URL, or further on in an absolute
      // path, the folder is still hidden.
      expect(hideFilePaths("Errore:/data/x, PATH=/usr/bin:/home/anna/bin e (/data/y).")).toBe("Errore:[percorso rimosso], PATH=[percorso rimosso] e ([percorso rimosso]).");
      expect(hideFilePaths("file:///home/anna/x, file://localhost/home/anna/z e FILE:/data/w.")).toBe("file:[percorso rimosso], file://localhost[percorso rimosso] e FILE:[percorso rimosso].");
    }));
    withHome("/home/anna rossi", () => {
      expect(hideFilePaths("Non leggo /var/home/anna rossi né /mnt/x//home/anna rossi/y.")).toBe("Non leggo [percorso rimosso] né [percorso rimosso].");
      expect(hideFilePaths("Non leggo https://example.com/home/anna rossi/x.png.")).toBe("Non leggo https://example.com/home/anna rossi/x.png.");
    });
    withHome("C:\\Users\\Anna Rossi", () => {
      expect(hideFilePaths("Non leggo \\\\?\\C:\\Users\\Anna Rossi né file:///C:/Users/Anna%20Rossi/x né /C:/Users/Anna%20Rossi/y.")).toBe("Non leggo [percorso rimosso] né file:///[percorso rimosso] né [percorso rimosso].");
    });
  });

  it("una cartella privata va via anche dopo un escape JSON, un'ellissi, una parentesi o in un indirizzo locale, e mai a metà (S5)", () => {
    // Before (round 5): the escapes and ".../" left the whole home («\n/home/anna rossi/Sito.html»), and "]", "-" or a
    // letter outside ASCII let a bare path take half of it («[ERR][percorso rimosso] rossi»).
    const json = (log: string) => `Valore ${JSON.stringify({ log })} rifiutato.`;
    withHome("/home/anna rossi", () => withDataDirectory("/data", () => {
      for (const [text, hidden] of [
        [json("Copia non riuscita.\n/home/anna rossi/Sito.html: permesso negato"), json("Copia non riuscita.\n[percorso rimosso]: permesso negato")],
        [json("file\t/home/anna rossi/x"), json("file\t[percorso rimosso]")],
        [json("fine\r\n/home/anna rossi/.local/share/histos-publish/x"), json("fine\r\n[percorso rimosso]")],
        [json("riga 1\n/data/x"), json("riga 1\n[percorso rimosso]")],
        ["{\"log\":\"riga\\u000a/home/anna rossi/x\"}", "{\"log\":\"riga\\u000a[percorso rimosso]\"}"],
        ["{\"log\":\"riga\\n\\/home\\/anna rossi\\/x\"}", "{\"log\":\"riga\\n[percorso rimosso]\"}"],
        ["Non leggo x\\\\/home/anna rossi/x ora.", "Non leggo x[percorso rimosso] ora."],
        ["Percorso troppo lungo: .../home/anna rossi/Sito.html", "Percorso troppo lungo: ...[percorso rimosso]"],
        ["[ERR]/home/anna rossi", "[ERR][percorso rimosso]"],
        ["Non leggo perché/home/anna rossi", "Non leggo perché[percorso rimosso]"],
        ["Opzione -d/home/anna rossi/dati non valida.", "Opzione -d[percorso rimosso] non valida."],
        ["at f@/home/anna rossi/x.js:1:2", "at f@[percorso rimosso]"],
        ["-/home/anna rossi/x\n+/data/y", "-[percorso rimosso]\n+[percorso rimosso]"],
        // A path of this computer or of a file system, even further on in it.
        ["Anteprima http://127.0.0.1:43129/home/anna rossi/x", "Anteprima http://127.0.0.1:43129[percorso rimosso]"],
        ["Errore in http://localhost:5173/@fs/home/anna rossi/src/x.ts:3", "Errore in http://localhost:5173/@fs[percorso rimosso]"],
        ["Apri vscode://file/home/anna rossi/x.js:1:2 o file:///mnt/x/home/anna rossi/y", "Apri vscode://file[percorso rimosso] o file:///mnt/x[percorso rimosso]"],
        ["Copia su sftp://host/home/anna rossi/x", "Copia su sftp://host[percorso rimosso]"],
        // A path that a private folder goes on with: the next one is in it, and a web address keeps its own.
        ["/home/anna rossi/x/data/y e https://example.com/data/z", "[percorso rimosso] e https://example.com/data/z"],
        // A pattern would take half of one left as it is: then every private folder goes.
        ["/srv/x ui/home/anna rossi", "[percorso rimosso] ui[percorso rimosso]"],
      ]) expect(hideFilePaths(text as string), text).toBe(hidden);
      // Still left as they are: the path of a web address, a name glued to the folder, a relative path.
      for (const text of [
        "Media https://example.com/data/x.png e https://example.com/home/anna rossi/x.png (404).",
        "Vedi https://x.org/-/data/x, https://x.org/@/data/y, https://x.org/.../data/z e https://example.com/~/data/w.",
        json("fine \nhttps://example.com/data/x"),
        "Il template ui/data/card, ~/data/x, ../data/y e v2/home/anna rossi.",
      ]) expect(hideFilePaths(text), text).toBe(text);
    }));
    withHome("C:\\Users\\Anna Rossi", () => {
      for (const [text, hidden] of [
        [json("Copia non riuscita.\nC:\\Users\\Anna Rossi\\Sito.html"), json("Copia non riuscita.\n[percorso rimosso]")],
        ["Non leggo -C:\\Users\\Anna Rossi ora.", "Non leggo -[percorso rimosso] ora."],
        ["Non leggo 1.C:\\Users\\Anna Rossi ora.", "Non leggo 1.[percorso rimosso] ora."],
        ["Apri vscode://file/C:/Users/Anna Rossi/x.ts:1", "Apri vscode://file/[percorso rimosso]"],
        // A drive glued to a letter is no path.
        ["Non leggo xC:\\Users\\Anna Rossi ora.", "Non leggo xC:\\Users\\Anna Rossi ora."],
      ]) expect(hideFilePaths(text as string), text).toBe(hidden);
    });
  });

  it("una cartella privata con una virgoletta nel nome va tutta anche come la scrive JSON (\\\")", () => {
    // Before: «{"path":"[percorso rimosso]" Anna/x y.png"}», the quote JSON escapes ended the quoted path.
    const folder = "/srv/Dati \"di\" Anna";
    expect(hideFilePaths(`Valore ${JSON.stringify({ path: `${folder}/x y.png` })} rifiutato.`, undefined, [folder])).toBe("Valore {\"path\":\"[percorso rimosso]\"} rifiutato.");
    withDataDirectory("/srv/a\"/b c", () => {
      expect(hideFilePaths(JSON.stringify({ path: "/srv/a\"/b c/d" }))).toBe("{\"path\":\"[percorso rimosso]\"}");
    });
  });

  it("non lascia nessuna parte della home né della cartella dati, con spazi, virgolette, simboli e unicode nei nomi (7, fuzz)", () => {
    // A fixed seed (mulberry32): a failure is the same on every run.
    let seed = 0x7f4a7c15;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const letters = [..."abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789àèéìòùçñöüßøåæœÅÉÑÜ"];
    // Each word holds a character no template has, so finding it in the result means it went out.
    const unique = [..."日本語中文한국ΩπλжщяŁŊŦ"];
    const word = (words: string[]) => {
      const chars = Array.from({ length: 3 + Math.floor(random() * 5) }, () => pick(letters));
      chars.splice(Math.floor(random() * (chars.length + 1)), 0, pick(unique));
      words.push(chars.join(""));
      return chars.join("");
    };
    // A folder's name: words joined by what a name may hold, a quote right before a space or a separator included.
    const joints = [" ", " ", "  ", "'", "' ", "\"", "`", "-", "_", ".", " (", ") ", "&", "$", "#", "%", "+", "[", "]", "@", "!", ",", "=", "~", "^", "{", "}", ";"];
    const folderName = (words: string[]) => {
      let name = word(words);
      for (let count = Math.floor(random() * 3); count > 0; count -= 1) name += pick(joints) + word(words);
      return random() < 0.2 ? name + pick(["'", ".", ")", "`", "\""]) : name;
    };
    // A file's path inside a private folder: spaces only where it is quoted.
    const rest = (words: string[], spaces: boolean, separator: string) => Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      let name = word(words);
      if (spaces && random() < 0.6) name += ` ${word(words)}`;
      return name;
    }).join(separator) + pick(["", ".html", ".png", ".tmp"]);
    let checked = 0;
    for (let round = 0; round < 300; round += 1) {
      const windows = random() < 0.35;
      const separator = windows ? "\\" : "/";
      const secret: string[] = [];
      const home = windows ? `C:\\Users\\${folderName(secret)}` : `${pick(["/home", "/Users"])}/${folderName(secret)}`;
      const dataFolder = random() < 0.5
        ? `${home}${separator}${pick(windows ? ["AppData\\Roaming\\HistosPublish", folderName(secret)] : [".local/share/histos-publish", folderName(secret)])}`
        : windows ? `D:\\${folderName(secret)}${separator}${folderName(secret)}` : `/srv/${folderName(secret)}/${folderName(secret)}`;
      const folder = pick([home, dataFolder]);
      const quote = pick(["'", "\"", "`"]);
      const named: string[] = [];
      const quoted = `${folder}${separator}${rest(named, true, separator)}`;
      const bare = `${folder}${separator}${rest(named, false, separator)}`;
      const url = `file://${windows ? "/" : ""}${encodeURI(bare.replaceAll("\\", "/"))}`;
      const cases: Array<{ text: string; error?: unknown; whole: boolean }> = [
        { text: `ENOENT: no such file or directory, open ${quote}${quoted}${quote}`, whole: true },
        { text: `EPERM: operation not permitted, rename ${quote}${quoted}${quote} -> ${quote}${folder}${quote}`, whole: true },
        { text: `EACCES: permission denied, mkdir ${quote}${quoted}${quote}`, error: { path: quoted }, whole: true },
        { text: `Non leggo ${bare}: riprova.`, whole: true },
        { text: `Cartella ${folder} non scrivibile.`, whole: true },
        { text: `Non leggo ${url} né ${quote}${url}${quote}, riprova.`, whole: true },
        // As JSON writes it (a quote in a name as \", a backslash doubled), and right after an elision (S2).
        { text: `Valore ${JSON.stringify({ path: quoted })} rifiutato.`, whole: true },
        { text: `Non trovo l'${bare}, c'è 'altro'.`, whole: true },
      ];
      // Cut by the 4 KiB limit somewhere inside the private folder or the path after it.
      const at = 1 + Math.floor(random() * (quoted.length - 1));
      const cutQuote = pick(["", quote]);
      cases.push({ text: `${"·".repeat(4096 - 10 - cutQuote.length - at)}Non leggo ${cutQuote}${cutQuote ? quoted : bare}${cutQuote} e altro.`, whole: true });
      withHome(home, () => {
        for (const { text, error, whole } of cases) {
          const hidden = hideFilePaths(text, error, [dataFolder]);
          const context = `HOME=${home} DATA=${dataFolder}\nIN : ${text}\nOUT: ${hidden}`;
          expect(hidden, context).toContain("[percorso rimosso]");
          expect(hidden, context).not.toContain("\uE000");
          const lower = hidden.toLowerCase();
          // No word of the home or of the data folder, and none of the path a quoted or unquoted name goes on with.
          for (const name of whole ? [...secret, ...named] : secret) expect(lower, `${context}\nleft: ${name}`).not.toContain(name.toLowerCase());
          for (const name of ["histospublish", "histos-publish", "appdata", "roaming", ".local"]) expect(lower, context).not.toContain(name);
          checked += 1;
        }
      });
    }
    expect(checked).toBe(300 * 9);
  }, 30_000);
});
