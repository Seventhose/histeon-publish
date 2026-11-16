/**
 * A site as a WordPress export file, for a WordPress with no Histeon on it: Strumenti → Importa takes it. Text and
 * structure go; the file format has no room for the images themselves.
 */

export interface WxrExportItem {
  id: number;
  type: "page" | "post";
  title: string;
  slug: string;
  status: "draft" | "published";
  date: string | null;
  excerpt: string;
  html: string;
  terms: Array<{ kind: "category" | "post_tag"; slug: string; name: string }>;
  /**
   * The featured image of a post (doc 23 item 119): an attachment item with the image's address on the published
   * site, which the WordPress importer downloads, and `_thumbnail_id` on the post pointing to it.
   */
  thumbnail?: { id: number; url: string; title: string; alt: string };
}

const escapeXml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** CDATA cannot hold its own end: WordPress's exporter cuts it in two the same way. */
const cdata = (value: string): string => `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

export function buildWxr(input: { title: string; link: string; language: string; terms: ReadonlyArray<{ kind: "category" | "post_tag"; slug: string; name: string; parent: string }>; items: readonly WxrExportItem[] }): string {
  const categories = input.terms.filter((term) => term.kind === "category").map((term, index) => `<wp:category><wp:term_id>${index + 1}</wp:term_id><wp:category_nicename>${cdata(term.slug)}</wp:category_nicename><wp:category_parent>${cdata(term.parent)}</wp:category_parent><wp:cat_name>${cdata(term.name)}</wp:cat_name></wp:category>`);
  const tags = input.terms.filter((term) => term.kind === "post_tag").map((term, index) => `<wp:tag><wp:term_id>${index + 1000}</wp:term_id><wp:tag_slug>${cdata(term.slug)}</wp:tag_slug><wp:tag_name>${cdata(term.name)}</wp:tag_name></wp:tag>`);
  const attachments = new Map<number, { item: WxrExportItem; thumbnail: NonNullable<WxrExportItem["thumbnail"]> }>();
  for (const item of input.items) if (item.thumbnail && !attachments.has(item.thumbnail.id)) attachments.set(item.thumbnail.id, { item, thumbnail: item.thumbnail });
  const attachmentItems = [...attachments.values()].map(({ item, thumbnail }) => {
    const date = (item.date ?? "").replace("T", " ").replace(/(?:\.\d+)?Z$/u, "");
    const alt = thumbnail.alt ? `<wp:postmeta><wp:meta_key>${cdata("_wp_attachment_image_alt")}</wp:meta_key><wp:meta_value>${cdata(thumbnail.alt)}</wp:meta_value></wp:postmeta>` : "";
    return `<item><title>${cdata(thumbnail.title)}</title><dc:creator>${cdata("admin")}</dc:creator><content:encoded>${cdata("")}</content:encoded><excerpt:encoded>${cdata("")}</excerpt:encoded><wp:post_id>${thumbnail.id}</wp:post_id><wp:post_date>${cdata(date)}</wp:post_date><wp:post_date_gmt>${cdata(date)}</wp:post_date_gmt><wp:comment_status>${cdata("closed")}</wp:comment_status><wp:ping_status>${cdata("closed")}</wp:ping_status><wp:post_name>${cdata("")}</wp:post_name><wp:status>${cdata("inherit")}</wp:status><wp:post_parent>${item.id}</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type>${cdata("attachment")}</wp:post_type><wp:post_password>${cdata("")}</wp:post_password><wp:is_sticky>0</wp:is_sticky><wp:attachment_url>${cdata(thumbnail.url)}</wp:attachment_url>${alt}</item>`;
  });
  const items = input.items.map((item) => {
    const date = (item.date ?? "").replace("T", " ").replace(/(?:\.\d+)?Z$/u, "");
    const terms = item.terms.map((term) => `<category domain="${term.kind}" nicename="${escapeXml(term.slug).replaceAll("\"", "&quot;")}">${cdata(term.name)}</category>`).join("");
    return `<item><title>${cdata(item.title)}</title><dc:creator>${cdata("admin")}</dc:creator><content:encoded>${cdata(item.html)}</content:encoded><excerpt:encoded>${cdata(item.excerpt)}</excerpt:encoded><wp:post_id>${item.id}</wp:post_id><wp:post_date>${cdata(date)}</wp:post_date><wp:post_date_gmt>${cdata(date)}</wp:post_date_gmt><wp:comment_status>${cdata("closed")}</wp:comment_status><wp:ping_status>${cdata("closed")}</wp:ping_status><wp:post_name>${cdata(item.slug)}</wp:post_name><wp:status>${cdata(item.status === "published" ? "publish" : "draft")}</wp:status><wp:post_parent>0</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type>${cdata(item.type)}</wp:post_type><wp:post_password>${cdata("")}</wp:post_password><wp:is_sticky>0</wp:is_sticky>${terms}${item.thumbnail ? `<wp:postmeta><wp:meta_key>${cdata("_thumbnail_id")}</wp:meta_key><wp:meta_value>${cdata(String(item.thumbnail.id))}</wp:meta_value></wp:postmeta>` : ""}</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">\n<channel>\n<title>${escapeXml(input.title)}</title><link>${escapeXml(input.link)}</link><language>${escapeXml(input.language)}</language><wp:wxr_version>1.2</wp:wxr_version><wp:base_site_url>${escapeXml(input.link)}</wp:base_site_url><wp:base_blog_url>${escapeXml(input.link)}</wp:base_blog_url>\n${categories.join("\n")}\n${tags.join("\n")}\n${[...attachmentItems, ...items].join("\n")}\n</channel>\n</rss>\n`;
}
