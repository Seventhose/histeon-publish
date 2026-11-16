/** `node:path` in the browser bundle of the importer (doc 18 F6): POSIX paths, enough for the in-memory project. */
export const sep = "/";
export function normalize(value: string): string {
  const absolute = value.startsWith("/");
  const out: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out.at(-1) !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}
export const join = (...parts: string[]): string => normalize(parts.filter(Boolean).join("/"));
export const resolve = (...parts: string[]): string => {
  let result = "";
  for (const part of parts) result = part.startsWith("/") ? part : `${result}/${part}`;
  return normalize(result.startsWith("/") ? result : `/${result}`);
};
export const isAbsolute = (value: string): boolean => value.startsWith("/");
export const dirname = (value: string): string => {
  const index = normalize(value).lastIndexOf("/");
  return index <= 0 ? (value.startsWith("/") ? "/" : ".") : normalize(value).slice(0, index);
};
export const basename = (value: string, extension?: string): string => {
  const base = normalize(value).split("/").at(-1) ?? "";
  return extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base;
};
export const extname = (value: string): string => /(\.[^./]*)$/u.exec(basename(value))?.[1] ?? "";
export const relative = (from: string, to: string): string => {
  const left = resolve(from).split("/").filter(Boolean);
  const right = resolve(to).split("/").filter(Boolean);
  let common = 0;
  while (common < left.length && left[common] === right[common]) common++;
  return [...left.slice(common).map(() => ".."), ...right.slice(common)].join("/");
};
export const posix = { sep, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative };
export default { ...posix, posix };
