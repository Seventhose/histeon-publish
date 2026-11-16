import { describe, expect, it } from "vitest";
import { isServerExecutablePath } from "../src/scanner.js";

describe("server-executable bundle paths", () => {
  it.each([
    "index.php", "a/b.PHP5", "x.phtml", "x.phar", "x.pht", "x.phps", "x.php.jpg", "img/logo.phtml.png", "x.php.", "x.php ", "x.php. .",
    "page.shtml", "x.cgi", "cgi-bin/run", "cgi-bin/a/b.txt", "x.asp", "x.aspx", "handler.ashx", "x.cfm", "x.jsp",
    "web.config", "sub/web.config", ".htpasswd", ".htaccess", ".user.ini", "php.ini",
  ])("blocks %s", (file) => {
    expect(isServerExecutablePath(file)).toBe(true);
  });

  it.each(["index.html", "jquery.min.js", "messages.pl.json", "docs/example.py", "style.css", "photo.jpg", "phpinfo-guide.html", "my.php-notes.txt", "web.config.example.txt"])("keeps %s", (file) => {
    expect(isServerExecutablePath(file)).toBe(false);
  });
});
