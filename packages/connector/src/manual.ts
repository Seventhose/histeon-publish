import { PROTOTYPE_AI_MANUAL } from "./manual.generated.js";
import { MANUAL_SECTIONS } from "./tools.js";

export { PROTOTYPE_AI_MANUAL };

/**
 * One chapter of the manual: `section` names the chapters in order (`flusso` is "## 1.", `connettore` is "## 20."),
 * `tutto` or nothing gives the whole manual. The rules at the top come with every chapter.
 */
export function manualSection(section?: string): string {
  if (!section || section === "tutto") return PROTOTYPE_AI_MANUAL;
  const index = (MANUAL_SECTIONS as readonly string[]).indexOf(section);
  if (index < 1) return PROTOTYPE_AI_MANUAL;
  const intro = PROTOTYPE_AI_MANUAL.split(/\n---\n/u)[0]?.trim() ?? "";
  const start = PROTOTYPE_AI_MANUAL.indexOf(`\n## ${index}. `);
  if (start < 0) return PROTOTYPE_AI_MANUAL;
  const next = PROTOTYPE_AI_MANUAL.indexOf("\n## ", start + 1);
  const chapter = PROTOTYPE_AI_MANUAL.slice(start + 1, next < 0 ? undefined : next).replace(/\n---\s*$/u, "").trim();
  return `${intro}\n\n---\n\n${chapter}\n`;
}
