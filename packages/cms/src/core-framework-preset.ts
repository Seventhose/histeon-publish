import { validateCoreFrameworkPresetData, validateCoreFrameworkPresetJson, type CoreFrameworkPresetData } from "@histos-publish/histos-contract/core-preset";
import { generateCoreFrameworkCss } from "./core-framework-css.js";

const MAX_FILE_BYTES = 1_048_576;
const MAX_DECOMPRESSED_CHARACTERS = 1_048_576;
const MAX_DICTIONARY_ENTRIES = 250_000;

/**
 * Bounded UTF-16 LZ decoder for Core Framework's .core export.
 *
 * The bitstream follows the MIT-licensed lz-string algorithm (Copyright (c) 2013 pieroxy),
 * with explicit compressed-input, dictionary and output bounds for user-provided files.
 */
export function decompressCoreUtf16(input: string): string {
  if (!input || input.length > 524_288) throw new TypeError("Il file .core è vuoto o supera il limite consentito.");
  const dictionary: Array<string | undefined> = ["0", "1", "2"];
  let dictionarySize = 4;
  let enlargeIn = 4;
  let numBits = 3;
  let inputIndex = 1;
  let value = (input.charCodeAt(0) ?? 32) - 32;
  // Core's compressToUTF16 uses 15 bits per output character (resetValue 16384).
  let position = 16_384;
  let exhausted = false;

  const readBits = (count: number): number => {
    let bits = 0;
    let power = 1;
    for (let i = 0; i < count; i++) {
      if (exhausted) throw new TypeError("Il file .core termina prima del marcatore finale.");
      const bit = value & position;
      position >>= 1;
      if (position === 0) {
        position = 16_384;
        if (inputIndex >= input.length) {
          value = 0;
          exhausted = true;
        } else {
          value = (input.charCodeAt(inputIndex++) ?? 32) - 32;
        }
      }
      bits |= (bit > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  const readLiteral = (width: 8 | 16): string => String.fromCharCode(readBits(width));
  const first = readBits(2);
  let character: string;
  if (first === 0) character = readLiteral(8);
  else if (first === 1) character = readLiteral(16);
  else if (first === 2) return "";
  else throw new TypeError("Il file .core non contiene un flusso LZ valido.");

  dictionary[3] = character;
  let previous = character;
  const output: string[] = [character];
  let outputLength = character.length;
  const append = (part: string): void => {
    outputLength += part.length;
    if (outputLength > MAX_DECOMPRESSED_CHARACTERS) throw new TypeError("Il preset .core decompresso supera il limite di 1 MiB.");
    output.push(part);
  };

  while (true) {
    if (exhausted) throw new TypeError("Il file .core è incompleto o corrotto.");
    let code = readBits(numBits);
    let entry: string;
    if (code === 0) {
      dictionary[dictionarySize++] = readLiteral(8);
      code = dictionarySize - 1;
      enlargeIn--;
    } else if (code === 1) {
      dictionary[dictionarySize++] = readLiteral(16);
      code = dictionarySize - 1;
      enlargeIn--;
    } else if (code === 2) {
      return output.join("");
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    const known = dictionary[code];
    if (known !== undefined) entry = known;
    else if (code === dictionarySize) entry = previous + previous.charAt(0);
    else throw new TypeError("Il file .core contiene un riferimento LZ non valido.");

    append(entry);
    if (dictionarySize >= MAX_DICTIONARY_ENTRIES) throw new TypeError("Il preset .core supera il limite di complessità consentito.");
    dictionary[dictionarySize++] = previous + entry.charAt(0);
    enlargeIn--;
    previous = entry;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}

export interface ImportedCoreFrameworkPreset {
  source: CoreFrameworkPresetData;
  preset: Record<string, unknown>;
  css: string;
  cssKind: "embedded" | "generated" | "none" | "unsupported";
  warnings: string[];
}

function generatedPresetCss(preset: Record<string, unknown>): Pick<ImportedCoreFrameworkPreset, "css" | "cssKind" | "warnings"> {
  if (typeof preset.cssString === "string" && preset.cssString.trim()) {
    return { css: preset.cssString, cssKind: "embedded", warnings: [] };
  }
  if (preset.app_version === "1.1.0") {
    try {
      const generated = generateCoreFrameworkCss(preset);
      return { css: generated.css, cssKind: "generated", warnings: generated.warnings };
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 240) : "Il preset usa una funzione non riconosciuta.";
      return {
        css: "",
        cssKind: "unsupported",
        warnings: [`Il preset Core 1.1.0 è stato conservato, ma il CSS non è stato rigenerato: ${detail} Importa il CSS esportato da Core Framework.`],
      };
    }
  }
  return { css: "", cssKind: "none", warnings: [] };
}

/** Parse a selected .core compressed export or a Core Framework JSON export without network access. */
export function parseCoreFrameworkPresetFile(fileName: string, bytes: ArrayBuffer): ImportedCoreFrameworkPreset {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_FILE_BYTES) throw new TypeError("Il file preset Core supera il limite di 1 MiB.");
  const extension = fileName.toLowerCase().split(".").pop();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Il preset Core non è codificato in UTF-8 valido.");
  }

  if (extension === "core") {
    const source = validateCoreFrameworkPresetData({ format: "core-lz-utf16-v1", data: text }, "core-framework");
    const decoded = decompressCoreUtf16(text);
    const preset = validateCoreFrameworkPresetJson(decoded);
    return { source, preset, ...generatedPresetCss(preset) };
  }
  if (extension === "json") {
    const source = validateCoreFrameworkPresetData({ format: "core-json-v1", data: text }, "core-framework");
    const preset = validateCoreFrameworkPresetJson(text);
    return { source, preset, ...generatedPresetCss(preset) };
  }
  throw new TypeError("Scegli un file .core o .json esportato da Core Framework.");
}
