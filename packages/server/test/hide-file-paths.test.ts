import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hideFilePaths } from "../src/http.js";

const HIDDEN = "[percorso rimosso]";

/**
 * Runs `check` with `home` as the user's home folder (os.homedir() reads HOME, USERPROFILE on Windows, on every call)
 * and the default data folder inside it. A data folder of a test goes in hideFilePaths' `folders`, as written: through
 * HISTOS_PUBLISH_DATA_DIR, path.resolve would make "/data" a drive path on Windows.
 */
function withHome(home: string, check: () => void): void {
  const keys = ["HOME", "USERPROFILE", "HISTOS_PUBLISH_DATA_DIR", "XDG_DATA_HOME", "APPDATA"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ["HISTOS_PUBLISH_DATA_DIR", "XDG_DATA_HOME", "APPDATA"] as const) delete process.env[key];
  try { check(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** `log` in a JSON value, as an app error quotes what a process wrote. */
const json = (log: string) => `Valore ${JSON.stringify({ log })} rifiutato.`;

describe("percorsi nei messaggi per l'agente, letti anche decodificati (S7)", () => {
  it("un indirizzo locale subito dopo un escape JSON non lascia la home: file:///, sftp, scp, ssh, smb (S7-escape)", () => {
    // Before (round 6): «\nfile:///home/anna%20rossi/Sito.html» and the other addresses went out whole.
    withHome("/home/anna rossi", () => {
      for (const [text, hidden] of [
        [json("\nfile:///home/anna%20rossi/Sito.html"), json(`\nfile:${HIDDEN}`)],
        [json("fine \nfile:///home/anna rossi/x"), json(`fine \nfile:${HIDDEN}`)],
        [json("riga\tfile:///home/anna%20rossi/x"), json(`riga\tfile:${HIDDEN}`)],
        [json("Copia su:\nsftp://host/home/anna rossi/x"), json(`Copia su:\nsftp://host${HIDDEN}`)],
        [json("Copia su \nscp://host/home/anna rossi/x"), json(`Copia su \nscp://host${HIDDEN}`)],
        [json("\nssh://anna@host/home/anna rossi/x"), json(`\nssh://anna@host${HIDDEN}`)],
        [json("\nsmb://nas/home/anna rossi/x"), json(`\nsmb://nas${HIDDEN}`)],
        ["{\"log\":\"riga\\u000afile:///home/anna rossi/x\"}", `{"log":"riga\\u000afile:${HIDDEN}"}`],
        ["{\"log\":\"riga\\nfile:\\/\\/\\/home\\/anna rossi\\/x\"}", `{"log":"riga\\nfile:${HIDDEN}"}`],
        [JSON.stringify(["file:///home/anna rossi/x", "\nfile:///home/anna rossi/y"]), `["${HIDDEN}","\\nfile:${HIDDEN}"]`],
        // A JSON string in another: decoded twice.
        [`Valore ${JSON.stringify(json("Errore\nfile:///home/anna%20rossi/x"))}`, `Valore ${JSON.stringify(json(`Errore\nfile:${HIDDEN}`))}`],
      ]) expect(hideFilePaths(text as string), text).toBe(hidden);
    });
  });

  it("una barra scritta \\/ come fa PHP non nasconde la home a «:», e dopo «:» comincia un percorso (S7-barre)", () => {
    // Before: «Errore:\/home\/anna rossi\/x» went out whole, as "\/" after ":" read as the "//" of a URL.
    withHome("/home/anna rossi", () => {
      for (const [text, hidden] of [
        ["Errore:\\/home\\/anna rossi\\/x", `Errore:${HIDDEN}`],
        ["{\"msg\":\"Errore:\\/home\\/anna rossi\\/x.php\"}", `{"msg":"Errore:${HIDDEN}"}`],
        ["{\"msg\":\"PATH=\\/usr\\/bin:\\/home\\/anna rossi\\/bin\"}", `{"msg":"PATH=${HIDDEN}"}`],
        ["{\"msg\":\"open_basedir: (x:\\/home\\/anna rossi\\/)\"}", `{"msg":"open_basedir: (x:${HIDDEN})"}`],
      ]) expect(hideFilePaths(text as string), text).toBe(hidden);
    });
  });

  it("uno spazio o un apostrofo scritti dalla shell con «\\» non lasciano il resto del nome (S7-shell)", () => {
    // Before: «rsync: cannot open [percorso rimosso]\ rossi/Sito/x.html», the surname and the path after it.
    withHome("/home/anna rossi", () => {
      expect(hideFilePaths("rsync: cannot open /home/anna\\ rossi/Sito/x.html: Permission denied")).toBe(`rsync: cannot open ${HIDDEN}: Permission denied`);
      expect(hideFilePaths("Errore: /home/anna\\ rossi")).toBe(`Errore: ${HIDDEN}`);
      expect(hideFilePaths(json("rsync: /home/anna\\ rossi/x"))).toBe(json(`rsync: ${HIDDEN}`));
    });
    withHome("/home/o'brien", () => {
      expect(hideFilePaths("ls: /home/o\\'brien/x: No such file")).toBe(`ls: ${HIDDEN}: No such file`);
    });
  });

  it("i colori del terminale prima di un percorso non lo attaccano a un nome (S7-colori)", () => {
    // Before: «\u001b[31m/home/anna rossi/x» went out whole, the "m" that ends a colour glued like a name.
    withHome("/home/anna rossi", () => {
      expect(hideFilePaths("\u001b[31m/home/anna rossi/x\u001b[0m")).toBe(`\u001b[31m${HIDDEN}\u001b[0m`);
      expect(hideFilePaths("Errore: \u001b[1m\u001b[31m/home/anna rossi/x\u001b(B\u001b[m fine")).toBe(`Errore: \u001b[1m\u001b[31m${HIDDEN}\u001b(B\u001b[m fine`);
      expect(hideFilePaths(json("\u001b[31m/home/anna rossi/x\u001b[0m"))).not.toMatch(/anna|rossi/u);
      expect(hideFilePaths("\u001b[31mC:\\Users\\x\\nuovo\\y\u001b[0m e basta")).toBe(`\u001b[31m${HIDDEN}\u001b[0m e basta`);
    });
  });

  it("un indirizzo senza host è un percorso di questo computer: webpack:///, vscode:/// (S7-senza-host)", () => {
    // Before: «Errore in webpack:///home/anna rossi/src/x.js:3» went out whole, read as a web address.
    withHome("/home/anna rossi", () => {
      for (const [text, hidden] of [
        ["Errore in webpack:///home/anna rossi/src/x.js:3", `Errore in webpack:${HIDDEN}`],
        ["Apri vscode:///home/anna rossi/x.ts", `Apri vscode:${HIDDEN}`],
        [json("x\nwebpack:///home/anna rossi/x.js"), json(`x\nwebpack:${HIDDEN}`)],
        // A host is still a web address: "Errore://home/…" reads as one (round 5).
        ["Errore://home/anna rossi/x", "Errore://home/anna rossi/x"],
      ]) expect(hideFilePaths(text as string), text).toBe(hidden);
    });
  });

  it("va via solo la cartella privata che un percorso ha preso in parte: l'indirizzo di un sito resta (S7-solo-lei)", () => {
    withHome("/home/anna", () => {
      // Before (round 6): «Non leggo [percorso rimosso] ui[percorso rimosso] e https://example.com[percorso rimosso]».
      expect(hideFilePaths("Non leggo /srv/x ui/data/card e https://example.com/data/x.png", undefined, ["/data"])).toBe(`Non leggo ${HIDDEN} e https://example.com/data/x.png`);
    });
    withHome("/home/anna rossi", () => {
      // The one taken in part goes whole, the others stay where they are.
      expect(hideFilePaths("/srv/x ui/home/anna rossi e https://example.com/home/anna rossi/x.png")).toBe(`${HIDDEN} ui${HIDDEN} e https://example.com/home/anna rossi/x.png`);
      // A chain of them: each goes, however long.
      const chain = "/srv/x ui/home/anna rossi ".repeat(6);
      expect(hideFilePaths(chain)).not.toMatch(/anna|rossi/u);
    });
  });

  it("un indirizzo web con le barre scritte da PHP resta, anche in un JSON dentro un altro (S7-PHP)", () => {
    // Before: «"url":"https:\/\/example.com[percorso rimosso]"», the escaped slash opened a path.
    withHome("/home/anna rossi", () => {
      for (const url of ["https://example.com/data/x.png", "https://example.com/home/anna rossi/x.png"]) {
        const php = JSON.stringify({ code: "rest_upload_sideload_error", data: { url } }).replaceAll("/", "\\/");
        for (const text of [php, JSON.stringify(php), JSON.stringify(JSON.stringify(php)), json(`riga\n${url}`).replaceAll("/", "\\/")]) {
          expect(hideFilePaths(text, undefined, ["/data"]), text).toBe(text);
        }
      }
    });
  });

  it("al taglio dei 4 KiB non resta una parte della home, neanche attaccata a un nome (S7-taglio)", () => {
    // Before: «…/srv/x ui/home/anna ro», a folder glued to a name past a hidden path, cut inside its name.
    withHome("/home/anna rossi", () => {
      const lead = "Non leggo ";
      for (const [tail, kept] of [
        ["/srv/x ui/home/anna rossi/x", () => HIDDEN],
        ["[ERR]/home/anna rossi/x", (inside: number) => (inside <= 5 ? "[ERR]".slice(0, inside) : `[ERR]${HIDDEN}`)],
        ["\\n/home/anna rossi/x", (inside: number) => (inside <= 2 ? "\\n".slice(0, inside) : `\\n${HIDDEN}`)],
        [".../home/anna rossi/x", (inside: number) => (inside <= 3 ? "...".slice(0, inside) : `...${HIDDEN}`)],
        ["-d/home/anna rossi", (inside: number) => (inside <= 2 ? "-d".slice(0, inside) : `-d${HIDDEN}`)],
      ] as const) {
        for (const inside of [3, 8, 12, 14, 15, 17, 19, 22]) {
          const filler = "·".repeat(4096 - lead.length - inside);
          expect(hideFilePaths(`${lead}${filler}${tail}`), `${tail} ${inside}`).toBe(`${lead}${filler}${kept(inside)}`);
        }
      }
    });
  });

  it("un indirizzo di file come lo scrive pathToFileURL, o un percorso nella query di localhost, non lasciano la home (S7-%XX)", () => {
    for (const home of ["/home/c#dev", "/home/anna?x", "/home/anna rossi [x]", "/home/100%41 e lode"]) {
      withHome(home, () => {
        const url = pathToFileURL(`${home}/Sito di prova/x.html`).href;
        expect(hideFilePaths(`Non leggo ${url} adesso.`), url).toBe(`Non leggo file:${HIDDEN} adesso.`);
        expect(hideFilePaths(json(`x\n${url}`)), url).toBe(json(`x\nfile:${HIDDEN}`));
        const query = `http://localhost:4321/?file=${encodeURIComponent(`${home}/x.html`)}`;
        expect(hideFilePaths(`Anteprima ${query} pronta.`), query).not.toContain(encodeURIComponent(home.slice(6)));
      });
    }
    withHome("C:\\Users\\Anna Rossi", () => {
      expect(hideFilePaths(`Anteprima http://localhost:4321/?file=${encodeURIComponent("C:\\Users\\Anna Rossi\\x.html")} pronta.`)).toBe(`Anteprima http://localhost:4321/?file=${HIDDEN} pronta.`);
    });
  });

  it("un percorso che l'errore nomina non lascia la cartella privata che lo contiene (S7-errore)", () => {
    // Before: «'[percorso rimosso]/anna rossi/x y'» and «[percorso rimosso] rimosso] rossi/…».
    withHome("/home/anna rossi", () => {
      expect(hideFilePaths("EACCES: mkdir '/home' and '/home/anna rossi/x y'", { path: "/home" })).toBe(`EACCES: mkdir '${HIDDEN}' and '${HIDDEN}'`);
      expect(hideFilePaths("Non leggo /home/anna rossi/Sito/x.html", { path: "anna" })).toBe(`Non leggo ${HIDDEN}`);
    });
  });

  it("i casi del verificatore del round 6 (S7)", () => {
    const groups: Array<[home: string, data: string | undefined, cases: Array<[string, string]>]> = [
      ["/home/anna rossi", undefined, [
        ["Valore {\"log\":\"Errore di rete\\nfile:///home/anna%20rossi/Sito.html non trovato\"} rifiutato.", "Valore {\"log\":\"Errore di rete\\nfile:[percorso rimosso] non trovato\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nfile:///home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"riga\\nfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nfile:/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"riga\\nfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nvscode://file/home/anna rossi/x.js:1:2\"} rifiutato.", "Valore {\"log\":\"riga\\nvscode://file[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nhttp://127.0.0.1:43129/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"riga\\nhttp://127.0.0.1:43129[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nhttp://localhost:5173/@fs/home/anna rossi/src/x.ts\"} rifiutato.", "Valore {\"log\":\"riga\\nhttp://localhost:5173/@fs[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\tfile:///home/anna%20rossi/x\"} rifiutato.", "Valore {\"log\":\"riga\\tfile:[percorso rimosso]\"} rifiutato."],
        ["{\"log\":\"riga\\nfile:\\/\\/\\/home\\/anna rossi\\/x\"}", "{\"log\":\"riga\\nfile:[percorso rimosso]\"}"],
        ["{\"log\":\"riga\\u000afile:///home/anna rossi/x\"}", "{\"log\":\"riga\\u000afile:[percorso rimosso]\"}"],
        ["Valore {\"log\":\"Error: x\\n    at file:///home/anna%20rossi/x.js:1:2\"} rifiutato.", "Valore {\"log\":\"Error: x\\n    at file:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"Error: x\\nat file:///home/anna%20rossi/x.js:1:2\"} rifiutato.", "Valore {\"log\":\"Error: x\\nat file:[percorso rimosso]\"} rifiutato."],
        ["Errore:\\/home\\/anna rossi\\/x", "Errore:[percorso rimosso]"],
        ["{\"msg\":\"PATH=\\/usr\\/bin:\\/home\\/anna rossi\\/bin\"}", "{\"msg\":\"PATH=[percorso rimosso]\"}"],
        ["{\"msg\":\"Errore:\\/home\\/anna rossi\\/x.php\"}", "{\"msg\":\"Errore:[percorso rimosso]\"}"],
        ["{\"msg\":\"open_basedir: (x:\\/home\\/anna rossi\\/)\"}", "{\"msg\":\"open_basedir: (x:[percorso rimosso])\"}"],
        ["Errore in webpack:///home/anna rossi/src/x.js:3", "Errore in webpack:[percorso rimosso]"],
        ["\u001b[31m/home/anna rossi/x\u001b[0m", "\u001b[31m[percorso rimosso]\u001b[0m"],
        // Read as written, "\u001b" after a quote opens a path ("\" is a separator): the colour after it goes with it.
        ["Valore {\"log\":\"\\u001b[31m/home/anna rossi/x\\u001b[0m\"} rifiutato.", "Valore {\"log\":\"\\u001b[31m[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"\\nfile:///home/anna%20rossi/Sito.html\"} rifiutato.", "Valore {\"log\":\"\\nfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"fine \\nfile:///home/anna%20rossi/Sito.html\"} rifiutato.", "Valore {\"log\":\"fine \\nfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"fine:\\n\\nfile:///home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"fine:\\n\\nfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"\\tfile:///home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"\\tfile:[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"Copia su:\\nsftp://host/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"Copia su:\\nsftp://host[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"Copia su \\nscp://host/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"Copia su \\nscp://host[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"\\nssh://anna@host/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"\\nssh://anna@host[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"\\nsmb://nas/home/anna rossi/x\"} rifiutato.", "Valore {\"log\":\"\\nsmb://nas[percorso rimosso]\"} rifiutato."],
        ["[\"file:///home/anna rossi/x\",\"\\nfile:///home/anna rossi/y\"]", "[\"[percorso rimosso]\",\"\\nfile:[percorso rimosso]\"]"],
        ["{\"files\":[\"\\nfile:///home/anna%20rossi/x\"]}", "{\"files\":[\"\\nfile:[percorso rimosso]\"]}"],
        ["rsync: cannot open /home/anna\\ rossi/Sito/x.html: Permission denied", "rsync: cannot open [percorso rimosso]: Permission denied"],
        ["Errore: /home/anna\\ rossi", "Errore: [percorso rimosso]"],
        // A private folder in the path of a web address, glued to a name, stays (S3); after a letter outside ASCII it
        // does not (round 6).
        ["Copia su https://x.org/city/home/anna rossi/x", "Copia su https://x.org/city/home/anna rossi/x"],
        ["https://example.com/città/home/anna rossi/x.png", "https://example.com/città[percorso rimosso]"],
        ["{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}", "{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}"],
      ]],
      ["C:\\Users\\Anna Rossi", undefined, [
        ["Valore {\"log\":\"riga\\nfile:///C:/Users/Anna%20Rossi/x.html\"} rifiutato.", "Valore {\"log\":\"riga\\nfile:///[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nvscode://file/C:/Users/Anna Rossi/x.ts:1\"} rifiutato.", "Valore {\"log\":\"riga\\nvscode://file/[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"riga\\nC:/Users/Anna Rossi/x\"} rifiutato.", "Valore {\"log\":\"riga\\n[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"\\nfile:///C:/Users/Anna%20Rossi/x.html\"} rifiutato.", "Valore {\"log\":\"\\nfile:///[percorso rimosso]\"} rifiutato."],
        ["Valore {\"log\":\"fine \\nfile://localhost/C:/Users/Anna Rossi/x\"} rifiutato.", "Valore {\"log\":\"fine \\nfile://localhost/[percorso rimosso]\"} rifiutato."],
      ]],
      ["/home/anna", "/data", [
        ["Media https://example.com/città/data/x.png (404).", "Media https://example.com/città[percorso rimosso] (404)."],
        ["{\"code\":\"rest_upload_sideload_error\",\"data\":{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}}", "{\"code\":\"rest_upload_sideload_error\",\"data\":{\"url\":\"https:\\/\\/example.com\\/data\\/x.png\"}}"],
        ["Media https://example.com/[x]/data/x.png (404).", "Media https://example.com/[x][percorso rimosso] (404)."],
        ["Media https://[2001:db8::1]/data/x.png (404).", "Media https://[2001:db8::1][percorso rimosso] (404)."],
        ["Non leggo /srv/x ui/data/card e https://example.com/data/x.png", "Non leggo [percorso rimosso] e https://example.com/data/x.png"],
      ]],
    ];
    for (const [home, data, cases] of groups) {
      withHome(home, () => {
        for (const [text, hidden] of cases) expect(hideFilePaths(text, undefined, data ? [data] : []), text).toBe(hidden);
      });
    }
  });

  it("non lascia nessuna parte della home né della cartella dati in ogni lettura: JSON, JSON in JSON, PHP, shell, colori, file URL (S7, fuzz)", () => {
    // A fixed seed (xorshift): a failure is the same on every run.
    let seed = 0x9e3779b9;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    // Each word holds a syllable no template has; many start with a letter an escape takes ("\n", "\t", "\b", "\u").
    const markers = ["qxz", "vkj", "wzq", "jxv", "zqk", "Ж", "λ", "ø"];
    const letters = [..."nnttrrbbffuuabcdeghilmopsvABCDEFNTRU0123456789àèé"];
    const word = (words: string[]) => {
      const made = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(letters)).join("") + pick(markers);
      words.push(made);
      return made;
    };
    const joints = [" ", "  ", "'", " (", ") ", ".", ",", "&", "+", "=", "@", "%", "~", "[", "]", "#", "$", "!", ";", "-"];
    const folderName = (words: string[]) => {
      let made = word(words);
      for (let count = Math.floor(random() * 3); count > 0; count -= 1) made += pick(joints) + word(words);
      return made;
    };
    const shellEscaped = (path: string) => path.replace(/([ '"()&;!$#[\]{}^~`,=+@%*?<>|\\])/gu, "\\$1");
    let checked = 0;
    for (let round = 0; round < 400; round += 1) {
      const windows = random() < 0.3;
      const separator = windows ? "\\" : "/";
      const secret: string[] = [];
      const home = windows ? `C:\\Users\\${folderName(secret)}` : `${pick(["/home", "/Users"])}/${folderName(secret)}`;
      const dataFolder = windows ? undefined : `/srv/${folderName(secret)}`;
      const folder = dataFolder && random() < 0.5 ? dataFolder : home;
      const named: string[] = [];
      const full = `${folder}${separator}${Array.from({ length: 1 + Math.floor(random() * 2) }, () => word(named)).join(separator)}${pick(["", ".html"])}`;
      const slashed = full.replaceAll("\\", "/");
      const url = windows ? `file:///${encodeURI(slashed)}` : pathToFileURL(full).href;
      const lead = pick(["", "Errore: ", "riga 1", "fine ", "x:", "[ERR]", "(", "-"]);
      const texts = [
        json(`${lead}\n${full}`),
        json(`${lead}\t${url}`),
        json(`${lead}\n${url}`),
        `Valore ${JSON.stringify(json(`${lead}\n${full}`))}`,
        `Valore ${JSON.stringify(json(`${lead}\n${url}`))}`,
        JSON.stringify({ path: full }).replaceAll("/", "\\/"),
        JSON.stringify({ msg: `Errore:${slashed}` }).replaceAll("/", "\\/"),
        `\u001b[31m${full}\u001b[0m e basta`,
        json(`\u001b[1m${full}\u001b(B\u001b[m`),
        json(`x\nsftp://host${windows ? "/" : ""}${slashed}`),
        json(`x\nwebpack://${windows ? "/" : ""}${slashed}:3`),
        json(`x\nhttp://127.0.0.1:4321${windows ? "/" : ""}${slashed}`),
        `Anteprima http://localhost:4321/?file=${encodeURIComponent(full)} pronta.`,
        ...(windows ? [] : [`rsync: cannot open ${shellEscaped(full)}: Permission denied`, json(`rsync: ${shellEscaped(full)}`)]),
      ];
      withHome(home, () => {
        for (const text of texts) {
          const hidden = hideFilePaths(text, undefined, dataFolder ? [dataFolder] : []);
          const context = `HOME=${home} DATA=${dataFolder ?? ""}\nIN : ${text}\nOUT: ${hidden}`;
          expect(hidden, context).not.toContain("\uE000");
          const lower = hidden.toLowerCase();
          for (const name of secret) expect(lower, `${context}\nleft: ${name}`).not.toContain(name.toLowerCase());
          checked += 1;
        }
      });
    }
    expect(checked).toBeGreaterThan(400 * 13);
    // What stays: a private folder in the path of a web address, however JSON, PHP or a terminal writes it.
    withHome("/home/anna rossi", () => {
      for (const url of ["https://example.com/data/x.png", "https://example.com/home/anna rossi/x.png", "https://x.org/a/data/b"]) {
        for (const text of [
          `Media ${url} (404).`,
          JSON.stringify({ url }),
          JSON.stringify({ url }).replaceAll("/", "\\/"),
          JSON.stringify(JSON.stringify({ url }).replaceAll("/", "\\/")),
          json(`riga\n${url}`),
          json(`riga\n${url}`).replaceAll("/", "\\/"),
          `\u001b[34m${url}\u001b[0m`,
        ]) expect(hideFilePaths(text, undefined, ["/data"]), text).toBe(text);
      }
    });
  }, 60_000);
});
