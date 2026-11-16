/**
 * Videos in the page (list item 84): the «Video» block stays a link in what is stored and sent, and the content keeps
 * no iframe. On the published site this script turns the link into the player on a click, and only for YouTube
 * (through youtube-nocookie.com) and Vimeo (with dnt=1). Nothing is loaded from those sites before the click.
 * Any other address stays a plain link.
 */
export const VIDEO_PLAYER_SCRIPT = `// Histeon: a video link becomes its player on a click (YouTube without cookies, Vimeo); nothing loads before.
for (const link of document.querySelectorAll("a.xb-art-video[href]")) {
  link.addEventListener("click", (event) => {
    // A click with a modifier (new tab, new window) stays the browser's.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    let url;
    try { url = new URL(link.href); } catch { return; }
    if (url.protocol !== "https:") return;
    const host = url.hostname.replace(/^(www|m)\\./, "");
    let src = null;
    const youtube = host === "youtube.com" && url.pathname === "/watch" ? url.searchParams.get("v") : host === "youtu.be" ? url.pathname.slice(1) : null;
    if (youtube && /^[A-Za-z0-9_-]{6,20}$/.test(youtube)) src = "https://www.youtube-nocookie.com/embed/" + youtube + "?autoplay=1";
    const vimeo = host === "vimeo.com" ? url.pathname.slice(1) : null;
    if (vimeo && /^[0-9]{1,12}$/.test(vimeo)) src = "https://player.vimeo.com/video/" + vimeo + "?autoplay=1&dnt=1";
    if (!src) return;
    event.preventDefault();
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.title = link.textContent.trim() || "Video";
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.className = "xb-art-video-frame";
    frame.style.cssText = "display:block;width:100%;aspect-ratio:16/9;border:0";
    link.replaceWith(frame);
    frame.focus();
  });
}
// The builder's Video window: [data-xb-video] holds the player's own address, checked here as Histeon for WordPress
// checks it (behaviors.js); the link around the poster becomes the player on a click.
for (const box of document.querySelectorAll("[data-xb-video]")) {
  const src = box.getAttribute("data-xb-video") || "";
  const link = box.querySelector("a[href]");
  if (!link || !/^https:\\/\\/(www\\.youtube-nocookie\\.com\\/embed\\/[A-Za-z0-9_-]{11}|player\\.vimeo\\.com\\/video\\/[0-9]{1,12})$/.test(src)) continue;
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const frame = document.createElement("iframe");
    frame.src = src + (src.includes("vimeo") ? "?autoplay=1&dnt=1" : "?autoplay=1&rel=0");
    frame.title = link.getAttribute("aria-label") || link.textContent.trim() || "Video";
    frame.allow = "autoplay; fullscreen; picture-in-picture";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.className = "xb-video__frame";
    link.replaceWith(frame);
    frame.focus();
  });
}
`;

/** Whether a built page holds a video link the script upgrades. */
export const pageHasVideo = (html: string): boolean => /class="[^"]*\bxb-art-video\b/u.test(html) || pageHasVideoBox(html);

/** Whether a built page holds a video of the builder's Video window (`[data-xb-video]`, a poster in a link). */
export const pageHasVideoBox = (html: string): boolean => /\sdata-xb-video="/u.test(html);

/** The box of the builder's video, as Histeon for WordPress styles it (behaviors.css): the poster fills it. */
export const VIDEO_BOX_CSS = "[data-xb-video]{position:relative;aspect-ratio:16/9;overflow:hidden;background:#111}[data-xb-video]>a{display:block;width:100%;height:100%}[data-xb-video]>a img,[data-xb-video] .xb-video__frame{display:block;width:100%;height:100%;object-fit:cover;border:0}[data-xb-video] .xb-video__icon{position:absolute;inset:50% auto auto 50%;width:68px;height:48px;margin:-24px 0 0 -34px;border-radius:12px;background:rgb(0 0 0/.72)}[data-xb-video] .xb-video__icon::after{content:\"\";position:absolute;inset:14px auto auto 27px;border-style:solid;border-width:10px 0 10px 17px;border-color:transparent transparent transparent #fff}[data-xb-video]>a:hover .xb-video__icon,[data-xb-video]>a:focus-visible .xb-video__icon{background:#e33}";

/**
 * Doc 23 item 120: whether a built page uses one of Histeon's behaviours (tabs, toggles, reveal, videos, maps): it then
 * gets the same script and style as on WordPress, and only then.
 */
export const pageUsesBehaviors = (html: string): boolean => /\sdata-xb-(?:tabs|toggle|reveal|video|map)(?:[\s=>])/u.test(html) || pageHasVideo(html);
