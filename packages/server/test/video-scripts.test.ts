import { describe, expect, it } from "vitest";
import { withDocumentScripts } from "../src/cms-api.js";

describe("script dei video (voce 84)", () => {
  it("si aggiunge solo alle pagine con un blocco Video, dopo gli script del documento", () => {
    const withVideo = withDocumentScripts('<html><body><a class="xb-art-video" href="https://youtu.be/dQw4w9WgXcQ">V</a></body></html>', ["console.log(1)"]);
    expect(withVideo.match(/<script type="module">/gu)?.length).toBe(2);
    expect(withVideo.indexOf("console.log(1)")).toBeLessThan(withVideo.indexOf("youtube-nocookie"));
    expect(withVideo.endsWith("</script></body></html>")).toBe(true);
    const without = '<html><body><p>Testo</p></body></html>';
    expect(withDocumentScripts(without, [])).toBe(without);
  });
});
