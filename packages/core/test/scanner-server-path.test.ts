import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { scanFiles } from "../src/index.js";

/**
 * The server-path rule of the publishing scanner, both sides (round-6 review, B2): a /home/ in the path of a public
 * address is a page of that site and does not block publishing (it used to: https://www.comune.example.it/home/servizi
 * stopped the whole site); every folder of the server still does, written raw, JSON-escaped, after a query or a
 * fragment, behind a private or loopback host, an IP literal or user info. Round 7: the path is read as RFC 3986 reads
 * it (pchar), a script's patterns about /home/ are not folders, a hosting account's folders after the account block
 * inside a public address too, and slashes written as references, escapes or percent-encoding are read decoded.
 */

function serverPathLine(text: string, file = "index.html"): number | null {
  const finding = scanFiles([{ path: file, size: Buffer.byteLength(text), contents: Buffer.from(text) }]).find((item) => item.code === "server-path");
  if (!finding) return null;
  expect(finding).toMatchObject({ severity: "block", message: "Il contenuto espone un percorso del server." });
  return finding.line ?? 0;
}

// A page of a public site, or no folder at all: nothing for the server-path rule.
const NOT_SERVER_PATHS: Array<[string, string]> = [
  ["il link del comune (repro)", '<a href="https://www.comune.example.it/home/servizi">Servizi</a>'],
  ["http, non solo https", '<a href="http://www.comune.example.it/home/servizi">Servizi</a>'],
  ["maiuscole", '<a href="HTTPS://WWW.COMUNE.EXAMPLE.IT/HOME/SERVIZI">Servizi</a>'],
  ["home più avanti nel percorso", '<a href="https://www.example.com/it/home/chi-siamo/">Chi siamo</a>'],
  ["con la porta", '<a href="https://www.example.com:8443/home/servizi">Servizi</a>'],
  ["con query e frammento dopo il percorso", '<a href="https://www.example.com/home/servizi?tab=1#orari">Orari</a>'],
  ["host in punycode", '<a href="https://xn--citt-5qa.it/home/servizi">Città</a>'],
  ["host con un trattino", '<a href="https://comune-di-esempio.it/home/">Comune</a>'],
  ["percorso con lettere accentate", '<a href="https://www.example.it/città/home/servizi">Servizi</a>'],
  ["percorso con un segmento percent-encoded", '<a href="https://www.example.it/a%20b/home/servizi">Servizi</a>'],
  ["percorso con /home/ ripetuto", '<a href="https://www.example.com/home/home/servizi">Servizi</a>'],
  ["testo semplice", "Vedi https://www.comune.example.it/home/servizi per gli orari."],
  ["srcset di indirizzi pubblici", '<img srcset="https://cdn.example.com/home/a.jpg 1x, https://cdn.example.com/home/b.jpg 2x" alt="">'],
  ["CSS url() senza virgolette", ".hero{background:url(https://cdn.example.com/home/bg.jpg)}"],
  ["CSS url() fra virgolette", '.hero{background:url("https://cdn.example.com/home/bg.jpg")}'],
  ["JSON con le barre escapate", '<script type="application/json">{"url":"https:\\/\\/www.example.com\\/home\\/servizi"}</script>'],
  ["JSON con barre escapate e normali", '{"url":"https://www.example.com\\/home\\/servizi"}'],
  ["javascript: che apre un indirizzo pubblico", "<a href=\"javascript:location.href='https://www.example.com/home/x'\">x</a>"],
  ["data: che contiene un indirizzo pubblico", '<a href="data:text/plain,https://www.example.com/home/x">x</a>'],
  ["/home/ codificato in un indirizzo pubblico", '<a href="https://www.example.com/%68ome/x">x</a>'],
  ["barra codificata dopo home", '<a href="https://www.example.com/home%2Fx">x</a>'],
  ["una regola di uno script su /home/, escapata", '<script>const route = /^\\/home\\/(\\w+)$/;</script>'],
  // Round 7 (B2): a script's patterns about addresses under /home/ are not folders (they blocked in round 6).
  ["regola di uno script: /\\/home\\/.*/", "<script>if (/\\/home\\/.*/.test(location.pathname)) show();</script>"],
  ["regola di uno script: /^\\/home\\/.+$/", "<script>const r = /^\\/home\\/.+$/;</script>"],
  ["regola di uno script: /\\/home\\/-?\\d+/", "<script>const r = /\\/home\\/-?\\d+/;</script>"],
  ["regola di uno script: /\\/home\\/[^/]+/", "<script>const r = /\\/home\\/[^/]+/;</script>"],
  // Round 7 (B2): the path of a public address read as RFC 3986 reads it (pchar), so these links are pages of public
  // sites (they blocked: the path stopped at , : ; ( ) and what followed was read alone).
  ["web.archive.org con un indirizzo pubblico dentro", '<a href="https://web.archive.org/web/2020/https://www.comune.example.it/home/servizi">a</a>'],
  ["trasformazioni di cloudinary con le virgole", '<img src="https://res.cloudinary.com/demo/image/upload/c_fill,w_300/home/hero.jpg" alt="">'],
  ["una virgola fa parte del percorso", '<a href="https://www.example.com/a,/home/utente/x">x</a>'],
  ["i due punti di Wikipedia", '<a href="https://it.wikipedia.org/wiki/Speciale:Contributi/home/x">a</a>'],
  ["parametri ;v=1 nel percorso", '<a href="https://www.example.com/a;v=1/home/x">a</a>'],
  ["parentesi bilanciate di Wikipedia", '<a href="https://en.wikipedia.org/wiki/Home_(film)/home/x">a</a>'],
  ["la chiocciola di un profilo", '<a href="https://medium.com/@autore/home/x">a</a>'],
  ["&amp; nel percorso", '<a href="https://www.example.com/a&amp;b/home/x">a</a>'],
  ["un link fra parentesi nel testo", "(vedi https://www.example.com/home/servizi) e poi altro"],
  // Round 7 (B2): what the encoded slashes decode to is a public address's path, or no folder at all.
  ["barre come riferimenti in un indirizzo pubblico", '<a href="https:&#47;&#47;www.example.com&#47;home&#47;servizi">x</a>'],
  ["barre \\u002F in un indirizzo pubblico", '<script>var u = "https:\\u002F\\u002Fwww.example.com\\u002Fhome\\u002Fservizi";</script>'],
  ["link di condivisione con l'indirizzo codificato", '<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.sito.it%2Fhome%2Fservizi">Condividi</a>'],
  ["&#47; e &#x2F; in un testo qualsiasi", "<p>1&#47;2 di 10&#x2F;2026, e \\u002F da solo</p>"],
  ["</script> scritto come \\u002F", '<script>document.write("<\\u002Fscript>");</script>'],
  // Round 7 (B2): words of a hosting layout are not one when they are not the folder right after the account.
  ["una pagina «web» subito dopo /home/", '<a href="https://www.example.com/home/web/">x</a>'],
  ["una pagina che contiene «web»", '<a href="https://www.example.com/home/servizi/web-design/">x</a>'],
  ["una parola generica alla fine del percorso", '<a href="https://www.example.com/home/blog/html">x</a>'],
  // Round 8 (B2): web, html, sites and wp are what pages under /home/ are named like, not a panel's folders.
  ...["web", "html", "sites", "wp"].map((folder): [string, string] => [`una pagina /home/servizi/${folder}/`, `<a href="https://www.sito.it/home/servizi/${folder}/">x</a>`]),
  ["una pagina /home/notizie/tmp", '<a href="https://www.sito.it/home/notizie/tmp">x</a>'],
  ["una pagina /home/utente/www", '<a href="https://www.sito.it/home/utente/www">x</a>'],
];

// A folder of the server: blocked, at the line where it is.
const SERVER_PATHS: Array<[string, string]> = [
  ["percorso nudo nel testo", "<p>Il sito sta in /home/utente/public_html</p>"],
  ["percorso nudo in un href", '<a href="/home/servizi/">Servizi</a>'],
  ["http dichiarato prima, poi uno spazio e il percorso", "Vedi https://www.example.com/ oppure /home/utente/sito"],
  ["indirizzo pubblico e percorso separati da una virgola e uno spazio", '<img srcset="https://www.example.com/a.jpg, /home/utente/x.jpg 2x" alt="">'],
  ["percorso nella query", '<a href="https://www.example.com/scarica?file=/home/utente/.env">x</a>'],
  ["percorso nel frammento", '<a href="https://www.example.com/pagina#/home/utente/x">x</a>'],
  ["localhost", '<a href="http://localhost/home/utente/x">x</a>'],
  ["localhost con la porta", '<a href="http://localhost:3000/home/utente/x">x</a>'],
  ["sottodominio di localhost", '<a href="https://app.localhost/home/utente/x">x</a>'],
  ["host .local", '<a href="https://server.local/home/utente/x">x</a>'],
  ["host .internal", '<a href="https://build.internal/home/utente/x">x</a>'],
  ["host con una sola etichetta", '<a href="https://intranet/home/utente/x">x</a>'],
  ["IPv4 di loopback", '<a href="http://127.0.0.1/home/utente/x">x</a>'],
  ["IPv4 privato", '<a href="http://192.168.1.10/home/utente/x">x</a>'],
  ["IPv6 di loopback", '<a href="http://[::1]/home/utente/x">x</a>'],
  ["host percent-encoded", '<a href="https://%6c%6fcalhost/home/utente/x">x</a>'],
  ["user info", '<a href="https://utente@www.example.com/home/utente/x">x</a>'],
  ["host pubblico come user info di localhost", '<a href="https://www.example.com@localhost/home/utente/x">x</a>'],
  ["host con il punto finale", '<a href="https://www.example.com./home/utente/x">x</a>'],
  ["protocol-relative", '<img src="//cdn.example.com/home/utente/a.jpg" alt="">'],
  ["schema ftp", '<a href="ftp://www.example.com/home/utente/x">x</a>'],
  ["schema che finisce in https", '<a href="fakehttps://www.example.com/home/utente/x">x</a>'],
  ["file://", '<a href="file:///home/utente/x">x</a>'],
  ["javascript: con un percorso del server", "<a href=\"javascript:fetch('/home/utente/.ssh/id_rsa')\">x</a>"],
  ["data: con un percorso del server", '<a href="data:text/html,<a href=/home/utente/x>">x</a>'],
  ["srcset con un candidato locale", '<img srcset="https://cdn.example.com/a.jpg 1x, /home/utente/b.jpg 2x" alt="">'],
  ["CSS url() locale", '.hero{background:url("/home/utente/bg.jpg")}'],
  ["CSS: indirizzo pubblico e poi url() locale attaccati", ".a{background:url(https://cdn.example.com/a.png),url(/home/utente/b.png)}"],
  ["commento CSS dopo un indirizzo pubblico", ".a{background:url(https://cdn.example.com/a.png)/*/home/utente*/}"],
  ["indirizzo locale dentro il percorso di uno pubblico", '<a href="https://www.example.com/r/https://localhost/home/utente/x">x</a>'],
  ["indirizzo pubblico dentro il percorso di uno locale", '<a href="https://localhost/r/https://www.example.com/home/utente/x">x</a>'],
  ["JSON escapato", '<script>var cfg = {"upload_dir":"\\/home\\/utente\\/public_html\\/wp-content"};</script>'],
  ["JSON escapato con localhost", '{"url":"http:\\/\\/localhost\\/home\\/utente\\/x"}'],
  ["/var/www/", "<p>/var/www/html/index.php</p>"],
  ["/var/www/ nel percorso di un indirizzo pubblico", '<a href="https://www.example.com/var/www/html/">x</a>'],
  ["/var/www/ escapato", '{"root":"\\/var\\/www\\/html"}'],
  ["IIS", "<p>C:\\inetpub\\wwwroot\\sito</p>"],
  ["IIS in JSON", '{"root":"C:\\\\inetpub\\\\wwwroot"}'],
  // Round 7 (B2): a JSON-escaped home is still one when it reads as a folder.
  ["upload_dir di WordPress", '<script>var u = {"basedir":"\\/home\\/utente\\/public_html\\/wp-content\\/uploads","baseurl":"https:\\/\\/www.sito.it\\/wp-content\\/uploads"};</script>'],
  ["JSON escapato, solo la cartella", '{"dir":"\\/home\\/utente"}'],
  ["JSON escapato con la barra finale", '{"dir":"\\/home\\/utente\\/"}'],
  ["JSON escapato in un attributo, fra &quot;", '<div data-x="{&quot;dir&quot;:&quot;\\/home\\/utente&quot;}"></div>'],
  ["JSON escapato due volte", '{"cfg":"{\\"dir\\":\\"\\\\\\/home\\\\\\/utente\\\\\\/x\\"}"}'],
  ["JSON escapato due volte senza barre escapate", '{"cfg":"\\\\/home\\\\/utente"}'],
  ["nome con una lettera \\u00e8", '{"dir":"\\/home\\/caf\\u00e8\\/x"}'],
  ["una regola che scrive una cartella intera", "<script>const r = /\\/home\\/user\\/profile\\//;</script>"],
  // Round 9 (B2): a script's regular expression that names a concrete account blocks too (round 7/8 let it through).
  ["regola di uno script: /^\\/home\\/user$/", "<script>const r = /^\\/home\\/user$/;</script>"],
  ["regola di uno script: /\\/home\\/user\\/?$/", "<script>const r = /\\/home\\/user\\/?$/;</script>"],
  ["regola di uno script: /\\/home\\/user\\/.*/", "<script>const r = /\\/home\\/user\\/.*/;</script>"],
  ["stringa di uno script", "<script>const s = '\\/home\\/x';</script>"],
  // Round 7 (B2): the folders of a hosting account after the account, inside a public address too.
  ["indirizzo di upload sbagliato (repro)", '<img src="https://www.sito.it/home/utente/public_html/wp-content/uploads/a.jpg" alt="">'],
  ["public_html alla fine del percorso", '<a href="https://www.sito.it/home/utente/public_html">x</a>'],
  ["maiuscole", '<a href="https://www.sito.it/home/utente/PUBLIC_HTML/x">x</a>'],
  ["in JSON escapato", '{"url":"https:\\/\\/www.sito.it\\/home\\/utente\\/public_html\\/a.jpg"}'],
  ...["www", "htdocs", "httpdocs", "domains", "wp-content", "private_html", "subdomains", "logs", "tmp"].map((folder): [string, string] => [`/home/utente/${folder}/ in un indirizzo pubblico`, `<a href="https://www.sito.it/home/utente/${folder}/x">x</a>`]),
  // Round 7 (B2): where an address ends though RFC 3986 would go on.
  ["commento CSS attaccato all'indirizzo", ".a{background:url(https://cdn.example.com/a.png)}/*https://cdn.example.com/a.png/*/home/utente*/"],
  ["JSON fra &quot; in un attributo", '<div data-x="{&quot;u&quot;:&quot;https://www.example.com/a&quot;,&quot;p&quot;:&quot;/home/utente/x&quot;}"></div>'],
  ["stringhe fra apici in uno script", "<script>f('https://www.example.com/a','/home/utente/x');</script>"],
  ["indirizzo locale dentro web.archive.org", '<a href="https://web.archive.org/web/2020/http://localhost/home/utente/x">x</a>'],
  ["parentesi chiusa senza aperta", "(https://www.example.com/a)/home/utente/x"],
  ["percento senza due cifre esadecimali", '<a href="https://www.example.com/a%zz/home/utente/x">x</a>'],
  // Round 7 (B2): slashes written as character references, escapes or percent-encoding.
  ["&#47; decimale", "<p>Il sito sta in &#47;home&#47;utente&#47;public_html</p>"],
  ["&#047; con gli zeri e senza punto e virgola", "<p>&#047home&#047utente</p>"],
  ["&#x2F; esadecimale", "<p>&#x2F;home&#x2F;utente</p>"],
  ["&#x2f; minuscolo", "<p>&#x2f;home&#x2f;utente</p>"],
  ["&sol;", "<p>&sol;home&sol;utente</p>"],
  ["\\u002F", '<script>var d = "\\u002Fhome\\u002Futente";</script>'],
  ["\\u{2f}", '<script>var d = "\\u{2f}home\\u{2f}utente";</script>'],
  ["\\x2F", '<script>var d = "\\x2Fhome\\x2Futente";</script>'],
  ["%2F nel testo", "<p>%2Fhome%2Futente%2Fsito</p>"],
  ["%2F nella query di un indirizzo pubblico", '<a href="https://www.example.com/scarica?file=%2Fhome%2Futente%2F.env">x</a>'],
  ["indirizzo locale codificato in un link di condivisione", '<a href="https://www.facebook.com/sharer/sharer.php?u=http%3A%2F%2Flocalhost%2Fhome%2Futente%2Fx">x</a>'],
  ["/var/www/ con i riferimenti", "<p>&#47;var&#47;www&#47;html</p>"],
  ["public_html codificato in un indirizzo pubblico", '<img src="https:&#47;&#47;www.sito.it&#47;home&#47;utente&#47;public_html&#47;a.jpg" alt="">'],
];

describe("percorsi del server nel contenuto pubblicato", () => {
  it.each(NOT_SERVER_PATHS)("non blocca: %s", (_name, text) => {
    expect(serverPathLine(text)).toBeNull();
  });

  it.each(SERVER_PATHS)("blocca: %s", (_name, text) => {
    expect(serverPathLine(text)).toBe(1);
  });

  it("dopo indirizzi pubblici con /home/ il percorso vero blocca alla sua riga", () => {
    const text = [
      '<a href="https://www.comune.example.it/home/servizi">Servizi</a>',
      '<a href="https://www.example.com/home/x">x</a> <img srcset="https://cdn.example.com/home/a.jpg 1x">',
      "<p>Backup in /home/deploy/backup.tar</p>",
    ].join("\n");
    expect(serverPathLine(text)).toBe(3);
  });

  it("anche nei fogli di stile e negli script, e in un file grande con molti indirizzi pubblici", () => {
    expect(serverPathLine("a{background:url(https://cdn.example.com/home/x.png)}", "assets/site.css")).toBeNull();
    expect(serverPathLine("fetch('https://api.example.com/home/feed')\nconst root = '/home/deploy';", "assets/app.js")).toBe(2);
    const many = `${'<a href="https://www.example.com/home/x">x</a>\n'.repeat(20_000)}<p>/home/deploy/site</p>`;
    expect(serverPathLine(many)).toBe(20_001);
  });

  it("anche negli script del sito: le regole sugli indirizzi passano, le cartelle no (round 7)", () => {
    expect(serverPathLine("if (/\\/home\\/.*/.test(location.pathname)) show();", "assets/app.js")).toBeNull();
    expect(serverPathLine("const r = /\\/home\\/-?\\d+/;", "assets/app.js")).toBeNull();
    expect(serverPathLine("const r = /\\/home\\/-?\\d+/;\nconst cfg = {\"dir\":\"\\/home\\/deploy\\/www\"};", "assets/app.js")).toBe(2);
  });

  it("un percorso codificato blocca alla riga dove è scritto, anche dopo altre barre codificate (round 7)", () => {
    const text = ["<p>1&#47;2 e 10&#x2F;2026</p>", '<a href="https://www.example.com/a%2Fb">x</a>', "<p>Backup in &#47;home&#47;deploy&#47;backup.tar</p>"].join("\n");
    expect(serverPathLine(text)).toBe(3);
    // A plain path before an encoded one, or after it: the first of the two.
    expect(serverPathLine(`<p>/home/deploy/x</p>\n${text}`)).toBe(1);
    expect(serverPathLine(`<p>%2Fhome%2Fdeploy</p>\n<p>/home/deploy/x</p>`)).toBe(1);
    // Many encoded slashes before it: still the right line, in reasonable time.
    const many = `${"<p>1&#47;2 \\u002F 3%2F4</p>\n".repeat(50_000)}<p>&#47;home&#47;deploy</p>`;
    expect(serverPathLine(many)).toBe(50_001);
  });

  it("una lunga fila di barre inverse o di & non rallenta il controllo (round 7)", () => {
    const started = Date.now();
    expect(serverPathLine(`${"\\".repeat(2 * 1024 * 1024)}\n<p>\\/home\\/deploy\\/www</p>`)).toBe(2);
    expect(serverPathLine(`https://www.example.com/${"&".repeat(1024 * 1024)}\n/home/deploy/x`)).toBe(2);
    expect(serverPathLine(`https:${"\\".repeat(1024 * 1024)}/home/deploy/x`)).toBe(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

/**
 * Round 8 (B2): the JSON-escaped homes that round 7 let through because of what followed the name (a line number, a
 * JSON escape, a list separator, a query…). Round 9: what follows the name no longer decides anything: an escaped home
 * whose name starts as an account's (a letter, a digit, `_`, `%XX`, `\u00e8`, a character reference) is a folder,
 * so a script's regular expression that names a concrete account blocks too; one with no name passes.
 */
const ESCAPED_HOMES: Array<[string, string]> = [
  ["due cartelle e poi :riga", '{"msg":"Errore in \\/home\\/utente\\/index.php:12"}'],
  ["due cartelle e poi uno spazio", '{"msg":"Errore in \\/home\\/utente\\/index.php on line 12\\n"}'],
  ["due cartelle e poi \\n", '{"log":"\\/home\\/utente\\/debug.log\\n"}'],
  ["una variabile PATH", '{"path":"\\/home\\/utente\\/bin:\\/usr\\/bin"}'],
  ["un elenco con le virgole", '{"dirs":"\\/home\\/utente,\\/srv"}'],
  ["la cartella e poi \\r\\n", '{"cwd":"\\/home\\/utente\\r\\n"}'],
  ["una barra verticale", '{"a":["\\/home\\/utente\\/x.php|\\/y"]}'],
  ["una query", '{"u":"\\/home\\/utente\\/a.php?x=1"}'],
  ["un frammento", '{"u":"\\/home\\/utente\\/a.php#L3"}'],
  ["una parentesi chiusa", '{"u":"\\/home\\/utente\\/a.php)"}'],
  ["fra parentesi", '{"u":"(\\/home\\/utente)"}'],
  ["un nome con uno spazio", '{"u":"\\/home\\/utente\\/a b.php"}'],
  ["un %20", '{"u":"\\/home\\/utente\\/a%20b.php"}'],
  ["una barra inversa escapata", '{"u":"\\/home\\/utente\\/x\\\\y"}'],
  ["una virgoletta \\u0022", '"\\/home\\/utente\\/x.php\\u0022"'],
  ["un uguale", '{"u":"\\/home\\/utente\\/x=1"}'],
  ["una virgola alla fine", '{"u":"\\/home\\/utente\\/x.php,"}'],
  ["upload_dir", '{"basedir":"\\/home\\/utente\\/public_html\\/wp-content\\/uploads"}'],
  ["in profondità e poi :riga", '{"file":"\\/home\\/utente\\/public_html\\/wp-content\\/plugins\\/x.php:7"}'],
  ["un nome che comincia con un punto", '{"h":"\\/home\\/.cache\\/x"}'],
  ["un nome che comincia con un trattino", '{"h":"\\/home\\/-mario\\/x"}'],
  ["la cartella e poi ;", 'x="\\/home\\/utente;"'],
  ["la cartella e poi :", '{"\\/home\\/utente:1":1}'],
  ["la cartella e poi \\n e altro", '"\\/home\\/utente\\nnext"'],
  ["la cartella e poi \\t", '"\\/home\\/utente\\tx"'],
  ["fra apici", "x='\\/home\\/utente';"],
  ["la cartella e poi $ in una stringa", '{"h":"\\/home\\/utente$"}'],
  ["un glob in una stringa", '{"h":"\\/home\\/utente\\/*"}'],
  ["barre miste in una stringa", '{"h":"\\/home\\/utente/x.php"}'],
  ["barre miste e una lettera come un flag", '{"h":"\\/home\\/utente/i"}'],
  ["la cartella e poi | in una stringa", '{"h":"\\/home\\/a|\\/home\\/b"}'],
  ["JSON escapato due volte con un regex dopo", '{"cfg":"\\\\\\/home\\\\\\/utente\\\\\\/?"}'],
  ["una cartella vuota prima del nome", '{"h":"\\/home\\/\\/utente\\/x"}'],
  ["una cartella . prima del nome", '{"h":"\\/home\\/.\\/utente"}'],
];

const SCRIPT_PATTERNS: Array<[string, string]> = [
  ["/\\/home\\/.*/", "if (/\\/home\\/.*/.test(p)) x();"],
  ["/\\/home\\/-?\\d+/", "const r = /\\/home\\/-?\\d+/;"],
  ["/^\\/home\\/.+$/", "const r = /^\\/home\\/.+$/;"],
  ["/\\/home\\/(\\w+)/", "const r = /\\/home\\/(\\w+)/;"],
  ["/\\/home\\/[a-z]+/", "const r = /\\/home\\/[a-z]+/;"],
  ["/\\/home\\/\\d+/g", "const r = /\\/home\\/\\d+/g;"],
  ["/\\/home\\/(?:x|y)/ in uno script", "<script>const r = /\\/home\\/(?:x|y)/;</script>"],
  // Round 9 (B2): a literal's closing `/` after `\/home\/` is no empty folder, and its flags are no account.
  ["/\\/home\\//g", 's=p.replace(/\\/home\\//g,"/");'],
  ["/^\\/home\\//.test", 'if(/^\\/home\\//.test(location.pathname)){x="a"}'],
  ["/\\/home\\//i,", 'var r=/\\/home\\//i,s="x";'],
  ["/^\\/home\\//", 's=p.replace(/^\\/home\\//,"");'],
  ["/^\\/home\\/?$/", "const isHome = /^\\/home\\/?$/.test(p);"],
  ["/\\/home\\/(.*)/", "a.match(/\\/home\\/(.*)/)"],
  ["split(/\\/home\\//)", "x.split(/\\/home\\//)[1]"],
  ["/\\/home\\/[^/]+$/", "const r = /\\/home\\/[^/]+$/;"],
];

/** Round 9 (B2): the regular expressions of a script that name a concrete account (they passed in rounds 7 and 8). */
const SCRIPT_PATTERNS_WITH_ACCOUNT: Array<[string, string]> = [
  ["/^\\/home\\/user$/", "const r = /^\\/home\\/user$/;"],
  ["/\\/home\\/user\\/?$/", "const r = /\\/home\\/user\\/?$/;"],
  ["/\\/home\\/user/.test(p)", "/\\/home\\/user/.test(p)"],
  ["/^\\/home\\/user/i alla fine del file", "/^\\/home\\/user/i"],
  ["/^\\/home\\/user/i e poi </script>", "<script>const r = /^\\/home\\/user/i</script>"],
  ["/^\\/home\\/user/gi, in un array", "const rs = [/^\\/home\\/user/gi, /x/];"],
  ["/\\/home\\/user|\\/about/", "/\\/home\\/user|\\/about/"],
  ["/\\/home\\/user(?:\\/|$)/", "const r = /\\/home\\/user(?:\\/|$)/;"],
  ["/\\/home\\/user\\/(\\d+)/", "const r = /\\/home\\/user\\/(\\d+)/;"],
  ["/\\/home\\/index\\.html$/", "const r = /\\/home\\/index\\.html$/;"],
  ["/\\/home\\/user\\/.*/", "const r = /\\/home\\/user\\/.*/;"],
  ["/^\\/home\\/news$/ in un elenco di rotte", 'routes:[{re:/^\\/home\\/news$/,c:"a"}]'],
  ["/\\/home\\/g/", "x=/\\/home\\/g/.test(y)"],
  ['new RegExp("^\\\\/home\\\\/user$")', 'new RegExp("^\\\\/home\\\\/user$")'],
];

/**
 * Round 9 (B2): JSON-escaped homes in HTML whose quotes are character references (esc_html, esc_attr), followed by a
 * regular expression's syntax: round 8 read the next closing tag's `/` as a literal's end and let them through. And
 * names that start with a character written encoded.
 */
const ESCAPED_HOMES_ROUND_9: Array<[string, string]> = [
  ["fra &quot;, poi )", "<pre>{&quot;msg&quot;:&quot;open_basedir (\\/home\\/utente)&quot;}</pre>"],
  ["fra &quot;, un glob", "<pre>{&quot;pattern&quot;:&quot;\\/home\\/utente\\/*&quot;}</pre>"],
  ["fra &quot;, un elenco con |", "<pre>{&quot;allowed&quot;:&quot;\\/home\\/utente|\\/tmp&quot;}</pre>"],
  ["fra &quot;, poi $", "<code>{&quot;home&quot;:&quot;\\/home\\/utente$&quot;}</code>"],
  ["fra &quot;, fra quadre", "<pre>[&quot;[\\/home\\/utente]&quot;]</pre>"],
  ["fra &quot;, poi {a,b}", "<pre>{&quot;g&quot;:&quot;\\/home\\/utente\\/{a,b}&quot;}</pre>"],
  ["fra &quot;, poi ?", "<pre>{&quot;u&quot;:&quot;\\/home\\/utente?x=1&quot;}</pre>"],
  ["fra &#039;", "<pre>{&#039;u&#039;:&#039;\\/home\\/utente)&#039;}</pre>"],
  ["nel testo fra parentesi", "<p>Errore (\\/home\\/utente)</p>"],
  ["un nome che comincia con %C3%A9", '{"u":"\\/home\\/%C3%A9milie\\/public_html\\/a.jpg"}'],
  ["un nome che comincia con %75", '{"u":"\\/home\\/%75tente\\/x"}'],
  ["un nome che comincia con &#117;", "<p>\\/home\\/&#117;tente\\/x</p>"],
  ["un nome che comincia con &#x75;", "<p>\\/home\\/&#x75;tente\\/x</p>"],
  ["un nome che comincia con &eacute;", "<p>\\/home\\/&eacute;milie\\/x</p>"],
  ["un nome che comincia con \\u00e8 escapato due volte", '{"cfg":"\\\\\\/home\\\\\\/\\\\u00e8lena"}'],
  ["un nome che comincia con _", '{"h":"\\/home\\/_deploy"}'],
  ["un nome che comincia con una cifra", '{"h":"\\/home\\/1utente"}'],
];

/** Round 9 (B2): what follows an escaped home with no account's name. */
const ESCAPED_HOMES_WITHOUT_NAME: Array<[string, string]> = [
  ["fra &quot; e basta", "<pre>{&quot;prefix&quot;:&quot;\\/home\\/&quot;}</pre>"],
  ["fra &#039; e basta", "<pre>{&#039;prefix&#039;:&#039;\\/home\\/&#039;}</pre>"],
  ["una concatenazione", 'p="\\/home\\/"+u'],
  ["un .. dopo", '{"u":"\\/home\\/..\\/x"}'],
];

/**
 * Round 10 (B2): an escaped home followed by a plain `/` or `./` (mixed escaping), which round 9 let through. After a
 * plain slash the name blocks when a slash follows it or a string ends there; a literal's flags or method do not.
 */
const MIXED_ESCAPED_HOMES: Array<[string, string]> = [
  ["\\/home\\//utente\\/public_html", '{"u":"\\/home\\//utente\\/public_html"}'],
  ["\\/home\\/./utente alla fine della stringa", '{"u":"\\/home\\/./utente"}'],
  ["\\/home\\//utente fra apici", "x='\\/home\\//utente';"],
  ["\\/home\\//utente e poi &quot;", "<pre>{&quot;u&quot;:&quot;\\/home\\//utente&quot;}</pre>"],
  ["\\/home\\//utente e poi \\\"", '{"t":"{\\"u\\":\\"\\/home\\//utente\\"}"}'],
  ["una barra escapata e poi una semplice", '{"u":"\\/home\\/\\//utente\\/x"}'],
  ["un nome di sole lettere di flag e poi una barra", '{"u":"\\/home\\//gi\\/public_html"}'],
  ["un nome che comincia con un punto", '{"u":"\\/home\\//.cache\\/x"}'],
];

/** Round 10 (B2): literals whose closing `/` follows `\/home\/`, then flags, a method or a separator. */
const MIXED_SCRIPT_PATTERNS: Array<[string, string]> = [
  ["/\\/home\\//gi in un attributo", '<a data-re="/\\/home\\//gi">x</a>'],
  ["/\\/home\\//.source", "var s=/\\/home\\//.source;"],
  ["/\\/home\\//y.exec(p)", "/\\/home\\//y.exec(p)"],
  ["/\\/home\\//dgimsuy", 's=p.replace(/\\/home\\//dgimsuy,"")'],
  ["/\\/home\\/./g", "var r=/\\/home\\/./g;"],
  ["/\\/home\\//g alla fine del file", "x=/\\/home\\//g"],
  ["/\\/home\\//g e poi a capo", "x=/\\/home\\//g\ny=1"],
];

describe("percorsi del server JSON-escapati e regole degli script (round 8)", () => {
  it.each(MIXED_ESCAPED_HOMES)("blocca: %s (round 10)", (_name, text) => {
    expect(serverPathLine(text)).toBe(1);
  });

  it.each(MIXED_SCRIPT_PATTERNS)("non blocca la regola %s (round 10)", (_name, text) => {
    expect(serverPathLine(text, "assets/app.js")).toBeNull();
    expect(serverPathLine(text)).toBeNull();
  });

  it.each(ESCAPED_HOMES)("blocca: %s", (_name, text) => {
    expect(serverPathLine(text)).toBe(1);
    expect(serverPathLine(`<script>var d = ${text};</script>`)).toBe(1);
  });

  it.each(SCRIPT_PATTERNS)("non blocca la regola %s", (_name, text) => {
    expect(serverPathLine(text, "assets/app.js")).toBeNull();
    expect(serverPathLine(text)).toBeNull();
  });

  it.each(SCRIPT_PATTERNS_WITH_ACCOUNT)("blocca la regola che nomina un account %s (round 9)", (_name, text) => {
    expect(serverPathLine(text, "assets/app.js")).toBe(1);
    expect(serverPathLine(text)).toBe(1);
  });

  it.each(ESCAPED_HOMES_ROUND_9)("blocca: %s (round 9)", (_name, text) => {
    expect(serverPathLine(text)).toBe(1);
  });

  it.each(ESCAPED_HOMES_WITHOUT_NAME)("non blocca: %s (round 9)", (_name, text) => {
    expect(serverPathLine(text)).toBeNull();
  });

  it("una regola che scrive una cartella intera blocca ancora", () => {
    expect(serverPathLine("const r = /\\/home\\/user\\/profile\\//;", "assets/app.js")).toBe(1);
  });
});

/**
 * Round 8 (B2): the hosting layout inside a public address read as a server reads the path: empty and `.` folders
 * skipped, `%XX` decoded once, `;` parameters dropped, `..` refused; and a document root a few folders down
 * (HestiaCP's /home/<account>/web/<domain>/public_html).
 */
const HOSTING_LAYOUTS: Array<[string, string]> = [
  ["una barra doppia", "https://www.sito.it/home//utente/public_html/wp-content/a.jpg"],
  ["una barra doppia dopo l'account", "https://www.sito.it/home/utente//public_html/a.jpg"],
  ["un segmento .", "https://www.sito.it/home/utente/./public_html/a.jpg"],
  ["un segmento . codificato", "https://www.sito.it/home/utente/%2e/public_html/a.jpg"],
  ["%70ublic_html", "https://www.sito.it/home/utente/%70ublic_html/a.jpg"],
  ["public_html tutto codificato alla fine", "https://www.sito.it/home/utente/%70%75%62%6c%69%63%5f%68%74%6d%6c"],
  ["un parametro ; sulla cartella", "https://www.sito.it/home/utente/public_html;x/a.jpg"],
  ["un parametro ; sull'account", "https://www.sito.it/home/utente;x/public_html/a.jpg"],
  ["un ..", "https://www.sito.it/home/utente/../x/a.jpg"],
  ["un .. codificato", "https://www.sito.it/home/utente/%2e%2e/x/a.jpg"],
  ["HestiaCP: web/<dominio>/public_html", "https://www.sito.it/home/utente/web/sito.it/public_html/wp-content/a.jpg"],
  ["DirectAdmin: domains/<dominio>/public_html", "https://www.sito.it/home/utente/domains/sito.it/public_html/a.jpg"],
  ["in JSON escapato con una barra doppia", '{"u":"https:\\/\\/www.sito.it\\/home\\/\\/utente\\/public_html\\/a.jpg"}'],
  // Round 9 (B2): as a browser reads the address (WHATWG URL): a backslash is a slash, tab and newline are dropped.
  ["barre inverse", '<img src="https://www.sito.it/home/utente\\public_html\\wp-content\\uploads\\a.jpg">'],
  ["barre inverse dopo una barra", '<img src="https://www.sito.it/home/utente/public_html\\a.jpg">'],
  ["%5C", '<img src="https://www.sito.it/home/utente%5Cpublic_html%5Ca.jpg">'],
  ["%5c minuscolo alla fine", '<img src="https://www.sito.it/home/utente%5cpublic_html">'],
  ["&#9; nel nome della cartella", '<img src="https://www.sito.it/home/utente/public&#9;_html/a.jpg">'],
  ["&#x9; dopo l'account", '<img src="https://www.sito.it/home/utente&#x9;/public_html/a.jpg">'],
  ["&Tab; e &NewLine;", '<img src="https://www.sito.it/home/utente/pub&Tab;lic&NewLine;_html/a.jpg">'],
  ["un tab vero", '<img src="https://www.sito.it/home/utente/public\t_html/a.jpg">'],
  ["un a capo nell'attributo", '<img src="https://www.sito.it/home/utente/\npublic_html/a.jpg">'],
  ["&#112; per la p", '<img src="https://www.sito.it/home/utente/&#112;ublic_html/a.jpg">'],
];

describe("cartelle di un hosting dentro un indirizzo pubblico, come le legge il server (round 8)", () => {
  it.each(HOSTING_LAYOUTS)("blocca: %s", (_name, text) => {
    expect(serverPathLine(text)).toBe(1);
  });

  it("le pagine con quei nomi più in fondo, o senza account, passano", () => {
    expect(serverPathLine('<a href="https://www.sito.it/home/servizi/web/hosting/">x</a>')).toBeNull();
    expect(serverPathLine('<a href="https://www.sito.it/home/guide/a/b/c/public_html">x</a>')).toBeNull();
    expect(serverPathLine('<a href="https://www.sito.it/home/%2e/">x</a>')).toBeNull();
  });

  it("una barra inversa o un a capo dopo una pagina pubblica non rendono cartelle i nomi qualsiasi (round 9)", () => {
    expect(serverPathLine('{"u":"https:\\/\\/www.sito.it\\/home\\/servizi\\"}')).toBeNull();
    expect(serverPathLine('{"m":"vedi https://www.sito.it/home/servizi\\nposta"}')).toBeNull();
    expect(serverPathLine('<a href="https://www.sito.it/home/servizi\\orari">x</a>\n<p>altro</p>')).toBeNull();
    expect(serverPathLine("Vedi https://www.sito.it/home/servizi\n\tpoi le notizie")).toBeNull();
    // Each address reads only up to the next one: many of them in a row, in a time that grows with the text.
    const started = Date.now();
    expect(serverPathLine("https://www.a.it/home/a\\b\\c&#9;d ".repeat(60_000))).toBeNull();
    expect(serverPathLine(`https://www.a.it/home/a${"\\x".repeat(500_000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("memoria del controllo su una cartella scritta in molti pezzi (round 10)", () => {
  it("6 MiB di a\\, a%5C o a&#9; dopo un account, con 128 MB di heap", () => {
    // Before: every piece of the written folder went into an array, and the decoding held every match at once: 1.3 GB
    // at 24 MiB, and with a 128 MB heap the process aborted (out of memory, which no caller can catch) at 6 MiB.
    const directory = mkdtempSync(path.join(tmpdir(), "histos-scanner-"));
    try {
      const source = readFileSync(fileURLToPath(new URL("../src/scanner.ts", import.meta.url)), "utf8");
      writeFileSync(path.join(directory, "scanner.mjs"), transformSync(source, { loader: "ts", format: "esm" }).code);
      const units = ["a\\", "a%5C", "a&#9;"];
      writeFileSync(
        path.join(directory, "run.mjs"),
        `import { scanFiles } from "./scanner.mjs";
for (const unit of ${JSON.stringify(units)}) {
  const text = "https://www.a.it/home/a/" + unit.repeat(Math.ceil((6 * 1024 * 1024) / unit.length));
  console.log(scanFiles([{ path: "a.html", size: text.length, contents: Buffer.from(text) }]).some((item) => item.code === "server-path"));
}
`,
      );
      const result = spawnSync(process.execPath, ["--max-old-space-size=128", "run.mjs"], { cwd: directory, encoding: "utf8", timeout: 150_000 });
      expect(result.stderr).toBe("");
      expect([result.status, result.stdout]).toEqual([0, "false\nfalse\nfalse\n"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it("un .. dopo molti pezzi della stessa cartella blocca ancora", () => {
    expect(serverPathLine(`<img src="https://www.sito.it/home/utente${"\\a".repeat(10)}\\..\\x">`)).toBe(1);
    expect(serverPathLine(`<img src="https://www.sito.it/home/utente${"%5Ca".repeat(10)}%5C..%5Cx">`)).toBe(1);
  });
});

describe("tempo del controllo su file di indirizzi senza separatori (round 8)", () => {
  it("una galleria di indirizzi pubblici separati da virgole, e indirizzi JSON attaccati, in un tempo lineare", () => {
    // Before: 64 KB of the gallery took 2 s, 128 KB 8.5 s (each path was read to the end of the run and back).
    let gallery = "";
    for (let index = 0; gallery.length < 2 * 1024 * 1024; index += 1) gallery += `https://cdn.example.com/img/${index}.jpg,`;
    const started = Date.now();
    expect(serverPathLine(`<a href="https://www.comune.example.it/home/servizi">s</a>\n<div data-gallery="${gallery}"></div>`)).toBeNull();
    expect(serverPathLine("https:\\/\\/www.a.it\\/home\\/a\\/".repeat(80_000))).toBeNull();
    expect(serverPathLine(`<div data-gallery="${gallery}"></div>\n<p>/home/deploy/x</p>`)).toBe(2);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("molte cartelle home escapate o fra le regole, in un tempo lineare", () => {
    const started = Date.now();
    expect(serverPathLine("/\\/home\\/a|b/;".repeat(200_000), "assets/app.js")).toBe(1);
    expect(serverPathLine("/\\/home\\//g;".repeat(200_000), "assets/app.js")).toBeNull();
    expect(serverPathLine("/\\/home\\/a|".repeat(200_000), "assets/app.js")).toBe(1);
    expect(serverPathLine("/\\/home\\/.*/;".repeat(200_000), "assets/app.js")).toBeNull();
    expect(serverPathLine("\\/home\\/-,".repeat(200_000))).toBeNull();
    expect(serverPathLine(`https://www.x.it${"/home/a".repeat(200_000)}`)).toBeNull();
    expect(serverPathLine(`https://www.x.it/home/a${"/.".repeat(500_000)}/x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
