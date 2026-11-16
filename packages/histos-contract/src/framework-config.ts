export interface ExternalFrameworkConfiguration {
  format: "opaque-utf8-v1";
  data: string;
}

const MAX_CONFIGURATION_BYTES = 1_048_576;

function assertWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) throw new TypeError("La configurazione del framework contiene un byte nullo.");
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) throw new TypeError("La configurazione del framework contiene testo UTF-8 non valido.");
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("La configurazione del framework contiene testo UTF-8 non valido.");
    }
  }
}

/** Keep a user-supplied framework configuration byte-for-byte without interpreting it. */
export function validateExternalFrameworkConfiguration(value: unknown): ExternalFrameworkConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("La configurazione del framework non è valida.");
  const configuration = value as Record<string, unknown>;
  if (Object.keys(configuration).some((key) => !["format", "data"].includes(key))
    || configuration.format !== "opaque-utf8-v1"
    || typeof configuration.data !== "string"
    || configuration.data.length === 0
    || configuration.data.length > MAX_CONFIGURATION_BYTES) {
    throw new TypeError("La configurazione del framework non è valida o usa un formato non supportato.");
  }
  assertWellFormedUtf16(configuration.data);
  if (new TextEncoder().encode(configuration.data).byteLength > MAX_CONFIGURATION_BYTES) {
    throw new TypeError("La configurazione del framework supera il limite di 1 MiB.");
  }
  return { format: "opaque-utf8-v1", data: configuration.data };
}
