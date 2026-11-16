import { Ajv, type AnySchema, type ErrorObject } from "ajv";
import { HistosPublishError } from "./errors.js";
import { validateWordPressRestUrl } from "./forms.js";
import type { SiteConfig, SourceSpec } from "./types.js";

export const SITE_CONFIG_SCHEMA: AnySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "source"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    name: { type: "string", minLength: 1, maxLength: 80 },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path"],
      properties: {
        kind: { type: "string", enum: ["directory", "html", "zip", "url", "cms"] },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        root: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    include: { type: "array", items: { type: "string", maxLength: 512 } },
    exclude: { type: "array", items: { type: "string", maxLength: 512 } },
    crawl: {
      type: "object",
      additionalProperties: false,
      properties: {
        concurrency: { type: "integer", minimum: 1, maximum: 8 },
        delayMs: { type: "integer", minimum: 0, maximum: 30000 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        maxPages: { type: "integer", minimum: 1, maximum: 20000 },
        maxDepth: { type: "integer", minimum: 0, maximum: 20 },
        maxBytes: { type: "integer", minimum: 1, maximum: 1073741824 },
        respectRobots: { type: "boolean" },
        ignoreRobots: { type: "boolean" },
        siteManaged: { type: "boolean" },
        bypassCache: { type: "boolean" },
        includeFeeds: { type: "boolean" },
        urls: { type: "array", maxItems: 500, items: { type: "string", maxLength: 4096 } },
        render: { type: "boolean" },
      },
    },
    rewrite: {
      type: "object",
      additionalProperties: false,
      properties: {
        destinationDomain: { type: "string", maxLength: 255 },
      externalAssets: { type: "array", items: { type: "string", maxLength: 4096 } },
      removeEmoji: { type: "boolean" },
      },
    },
  dynamic: {
    type: "object",
    additionalProperties: false,
    properties: {
      hideComments: { type: "boolean" },
      wooCommerceCatalog: { type: "boolean" },
    },
  },
    pagefind: { type: "boolean" },
    forms: {
      type: "object",
      additionalProperties: false,
      properties: {
        wordpress: {
          type: "object",
          additionalProperties: false,
          required: ["restUrl", "fluentFormIds", "turnstileSiteKey"],
          properties: {
            restUrl: { type: "string", minLength: 12, maxLength: 2048 },
            fluentFormIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 2147483647 } },
            turnstileSiteKey: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    cloudflare: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: { type: "string", maxLength: 64 },
        script: { type: "string", pattern: "^[a-z0-9-]{1,63}$" },
        domain: { type: "string", maxLength: 255 },
        workersDev: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1, maximum: 100000 },
        workerModule: {
          type: "object",
          additionalProperties: false,
          required: ["path", "name"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            name: { type: "string", minLength: 1, maxLength: 255 },
          },
        },
        kv: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,62}(?:=[A-Za-z0-9_.-]{1,200})?$" } },
      },
    },
    deployTarget: { type: "string", enum: ["cloudflare", "ftp"] },
    hosting: {
      type: "object",
      additionalProperties: false,
      required: ["protocol", "host", "port", "remoteDirectory"],
      properties: {
        protocol: { type: "string", enum: ["ftp", "ftps", "sftp"] },
        host: { type: "string", minLength: 1, maxLength: 253 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        remoteDirectory: { type: "string", maxLength: 1024 },
        publicUrl: { type: "string", maxLength: 2048 },
        username: { type: "string", maxLength: 255 },
        allowInsecureFtp: { type: "boolean" },
        tlsCaCertificate: { type: "string", minLength: 1, maxLength: 65536 },
        authMethod: { type: "string", enum: ["password", "privateKey"] },
        hostKeyFingerprint: { type: "string", pattern: "^SHA256:[A-Za-z0-9+/]{43}$" },
      },
    },
  },
};

const validate = new Ajv({ allErrors: true, strict: true }).compile<SiteConfig>(SITE_CONFIG_SCHEMA);

function migrateContactForm7Settings(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const config = structuredClone(value) as Record<string, unknown>;
  const forms = config.forms;
  if (forms === null || typeof forms !== "object" || Array.isArray(forms)) return config;
  const wordpress = (forms as Record<string, unknown>).wordpress;
  if (wordpress === null || typeof wordpress !== "object" || Array.isArray(wordpress)) return config;
  const settings = wordpress as Record<string, unknown>;
  if (!("contactForm7Ids" in settings)) return config;
  delete settings.contactForm7Ids;
  // A Contact Form 7 ID must never be silently reused as a Fluent Forms ID.
  if (!("fluentFormIds" in settings)) delete config.forms;
  return config;
}

export function parseSiteConfig(value: unknown): SiteConfig {
  const normalized = migrateContactForm7Settings(value);
  if (!validate(normalized)) {
    const details = (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"}: ${error.message ?? "valore non valido"}`).join("; ");
    throw new HistosPublishError(`Configurazione non valida: ${details}`, "config-invalid", 2);
  }
  const config = normalized as SiteConfig;
  if (config.source.kind === "cms" && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(config.source.path) || config.source.root !== undefined || config.crawl?.render === true)) {
    throw new HistosPublishError("Un sito che pubblica un progetto Histeon CMS indica solo l’id del progetto.", "config-invalid", 2);
  }
  if ((config.crawl?.ignoreRobots === true || config.crawl?.respectRobots === false) && config.crawl.siteManaged !== true) {
    throw new HistosPublishError("Per ignorare robots.txt devi dichiarare di gestire il sito.", "config-invalid", 2);
  }
  if (config.forms?.wordpress) {
    config.forms.wordpress.restUrl = validateWordPressRestUrl(config.forms.wordpress.restUrl);
    if (/\s/u.test(config.forms.wordpress.turnstileSiteKey)) throw new HistosPublishError("La chiave pubblica Turnstile non può contenere spazi.", "forms-config-invalid", 2);
  }
  if (config.deployTarget === "ftp" && !config.hosting) {
    throw new HistosPublishError("Configura l’hosting FTP/FTPS/SFTP prima di selezionarlo come destinazione.", "hosting-config-missing", 2);
  }
  if (config.hosting?.publicUrl) {
    let publicUrl: URL;
    try { publicUrl = new URL(config.hosting.publicUrl); }
    catch { throw new HistosPublishError("L’indirizzo pubblico deve essere un URL HTTP o HTTPS valido.", "hosting-url-invalid", 2); }
    if (!(["http:", "https:"].includes(publicUrl.protocol)) || publicUrl.username || publicUrl.password || !publicUrl.hostname) {
      throw new HistosPublishError("L’indirizzo pubblico deve essere un URL HTTP o HTTPS senza credenziali.", "hosting-url-invalid", 2);
    }
    config.hosting.publicUrl = publicUrl.href.replace(/\/$/u, "");
  }
  if (config.hosting?.protocol === "ftp" && config.hosting.allowInsecureFtp !== true) {
    throw new HistosPublishError("FTP senza cifratura richiede una conferma esplicita. Se il tuo hosting lo consente, scegli FTPS.", "hosting-insecure-ftp-not-confirmed", 2);
  }
  return config;
}

export function createSiteConfig(name: string, source: SourceSpec): SiteConfig {
  return parseSiteConfig({ schemaVersion: 1, name, source });
}
