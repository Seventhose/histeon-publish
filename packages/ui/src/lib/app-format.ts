import type { Language } from "./i18n.js";

export const formatDate = (language: Language, value?: string) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
};
export const formatBytes = (language: Language, bytes?: number) => {
  if (bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${new Intl.NumberFormat(language === "it" ? "it-IT" : "en-US", { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
};

const DEPLOY_PHASES: Record<string, [string, string]> = {
  preflight: ["controllo dei file", "file check"],
  session: ["sessione", "session"],
  upload: ["caricamento", "upload"],
  version: ["versione", "version"],
  deploy: ["deploy", "deploy"],
};
/**
 * Why a Cloudflare publish failed, with the phase where it stopped (doc 23, voce 228): «Fermata alla fase
 * caricamento: …». Without a known phase, the message alone; without a message, undefined.
 */
export const deployFailure = (language: Language, error: unknown, phase: unknown): string | undefined => {
  if (typeof error !== "string" || error === "") return undefined;
  const names = typeof phase === "string" ? DEPLOY_PHASES[phase] : undefined;
  if (!names) return error;
  return language === "it" ? `Fermata alla fase ${names[0]}: ${error}` : `Stopped at the ${names[1]} phase: ${error}`;
};
