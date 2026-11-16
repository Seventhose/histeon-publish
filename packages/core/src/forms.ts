import * as parse5 from "parse5";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import type { FormsBuildResult, SiteConfig } from "./types.js";
import type { SourceFile } from "./filesystem.js";

interface HtmlAttribute { name: string; value: string }
interface HtmlNode {
  tagName?: string;
  nodeName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  parentNode?: HtmlNode;
}

export const FLUENT_FORMS_CLIENT_PATH = "xb-form-client.js";

export function turnstileSecretAccount(worker: string): string {
  return `turnstile-${worker}`;
}

export interface FluentFormsBuildResult {
  files: SourceFile[];
  report: FormsBuildResult;
  findings: Array<{ code: string; severity: "warn"; file: string; message: string }>;
  linkedFiles: string[];
}

function walk(node: HtmlNode, visit: (item: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function setAttribute(node: HtmlNode, name: string, value: string): void {
  const found = node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (found) found.value = value;
  else node.attrs?.push({ name, value });
}

function descendantNodes(node: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  walk(node, (child) => { if (child !== node) result.push(child); });
  return result;
}

function isFluentForm(node: HtmlNode): boolean {
  if (node.tagName?.toLowerCase() !== "form") return false;
  const classes = (attribute(node, "class") ?? "").split(/\s+/u);
  return classes.includes("frm-fluent-form") || classes.some((name) => /^fluent_form_\d+$/u.test(name));
}

function formId(form: HtmlNode): number | undefined {
  const classes = (attribute(form, "class") ?? "").split(/\s+/u);
  const classId = classes.find((name) => /^fluent_form_\d+$/u.test(name))?.match(/\d+$/u)?.[0];
  const elementId = attribute(form, "id")?.match(/^fluentform_(\d+)$/u)?.[1];
  const candidates = [attribute(form, "data-form_id"), attribute(form, "data-form-id"), elementId, classId].filter((value): value is string => Boolean(value));
  if (candidates.length === 0 || candidates.some((value) => !/^\d{1,10}$/u.test(value)) || new Set(candidates).size !== 1) return undefined;
  const parsed = Number(candidates[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hasUnsupportedControl(form: HtmlNode): boolean {
  const nodes = descendantNodes(form);
  if (nodes.some((node) => node.tagName?.toLowerCase() === "input" && (attribute(node, "type") ?? "").toLowerCase() === "file")) return true;
  const content = nodes.map((node) => `${node.tagName ?? ""} ${(node.attrs ?? []).map((item) => `${item.name}=${item.value}`).join(" ")}`).join(" ");
  return /(?:g-recaptcha|hcaptcha|h-captcha|cf-turnstile|captcha|ff[_-]?payment|stripe|paypal)/iu.test(content);
}

function insertBeforeClosingBody(html: string, markup: string): string {
  const closing = /<\/body\s*>/iu;
  return closing.test(html) ? html.replace(closing, `${markup}</body>`) : `${html}${markup}`;
}

export function fluentFormsClientSource(): string {
  return `(() => {
  const forms = [...document.querySelectorAll('form[data-histos-fluent-form]')];
  if (!forms.length) return;
  const say = (italian, english) => document.documentElement.lang.toLowerCase().startsWith('en') ? english : italian;
  for (const form of forms) {
    const widget = document.createElement('div');
    widget.className = 'cf-turnstile';
    widget.dataset.sitekey = form.dataset.histosTurnstileSitekey || '';
    widget.dataset.action = 'histos_form';
    const submit = form.querySelector('button[type="submit"], input[type="submit"], .ff-btn-submit');
    if (submit?.parentNode) submit.parentNode.insertBefore(widget, submit);
    else form.append(widget);
  }
  if (!document.querySelector('script[data-histos-turnstile]')) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.histosTurnstile = 'true';
    document.head.append(script);
  }
  const showStatus = (form, message, state) => {
    let status = form.querySelector('.histos-form-status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'histos-form-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      form.append(status);
    }
    status.textContent = message;
    form.dataset.histosState = state;
  };
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('form[data-histos-fluent-form]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (form.dataset.histosBusy === 'true') return;
    form.dataset.histosBusy = 'true';
    const button = form.querySelector('button[type="submit"], input[type="submit"], .ff-btn-submit');
    if (button) button.disabled = true;
    try {
      const submitted = [];
      for (const control of [...form.elements]) {
        if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
        if (!control.name || control.disabled || control.closest('.has-conditions')?.classList.contains('ff_excluded')) continue;
        if (control instanceof HTMLInputElement) {
          const type = control.type.toLowerCase();
          if (type === 'file') {
            showStatus(form, say('Questo modulo contiene un allegato non supportato.', 'This form contains an unsupported file upload.'), 'error');
            return;
          }
          if (['submit', 'button', 'reset', 'image'].includes(type) || (['checkbox', 'radio'].includes(type) && !control.checked)) continue;
          submitted.push([control.name, control.value]);
        } else if (control instanceof HTMLSelectElement && control.multiple) {
          for (const option of [...control.selectedOptions]) submitted.push([control.name, option.value]);
        } else {
          submitted.push([control.name, control.value]);
        }
      }
      const token = submitted.find(([name]) => name === 'cf-turnstile-response')?.[1];
      if (typeof token !== 'string' || token.length < 1) {
        showStatus(form, say('Completa la verifica antispam.', 'Complete the anti-spam check.'), 'error');
        return;
      }
      const fields = Object.create(null);
      let count = 0;
      for (const [name, value] of submitted) {
        if (name === 'cf-turnstile-response') continue;
        if (Object.hasOwn(fields, name)) {
          const previous = fields[name];
          fields[name] = Array.isArray(previous) ? [...previous, value] : [previous, value];
        } else {
          fields[name] = value;
          count += 1;
        }
      }
      if (count > 50 || submitted.length > 50) {
        showStatus(form, say('Il modulo supera i limiti consentiti. Contatta il gestore del sito.', 'This form exceeds the allowed limits. Contact the site owner.'), 'error');
        return;
      }
      const response = await fetch('/xb-form', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form: form.dataset.histosFluentForm, fields, turnstileToken: token })
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.status === 'sent') {
        showStatus(form, say('Grazie. Il messaggio è stato inviato.', 'Thank you. Your message has been sent.'), 'sent');
        form.reset();
      } else if (response.status === 422 && result?.status === 'invalid') {
        showStatus(form, say('Controlla i campi e riprova.', 'Check the fields and try again.'), 'invalid');
      } else {
        showStatus(form, say('Non è stato possibile inviare il messaggio. Riprova più tardi.', 'The message could not be sent. Please try again later.'), 'error');
      }
    } catch {
      showStatus(form, say('Non è stato possibile inviare il messaggio. Riprova più tardi.', 'The message could not be sent. Please try again later.'), 'error');
    } finally {
      form.dataset.histosBusy = 'false';
      const widget = form.querySelector('.cf-turnstile');
      if (window.turnstile && widget) window.turnstile.reset(widget);
      if (button) button.disabled = false;
    }
  }, true);
})();\n`;
}

export async function addFluentForms(files: readonly SourceFile[], config: SiteConfig["forms"], signal?: AbortSignal): Promise<FluentFormsBuildResult | undefined> {
  const settings = config?.wordpress;
  if (!settings) return undefined;
  throwIfAborted(signal);
  const configuredIds = new Set(settings.fluentFormIds);
  const attachedIds = new Set<number>();
  const unsupportedFiles = new Set<string>();
  const linkedFiles = new Set<string>();
  let attachedForms = 0;
  const transformed = new Map<string, Buffer>();
  for (const file of files.filter((item) => /\.html?$/iu.test(item.path))) {
    throwIfAborted(signal);
    const html = file.bytes.toString("utf8");
    const document = parse5.parse(html) as unknown as HtmlNode;
    let changed = false;
    walk(document, (node) => {
      if (!isFluentForm(node)) return;
      const id = formId(node);
      if (id === undefined || !configuredIds.has(id)) return;
      if (hasUnsupportedControl(node)) {
        unsupportedFiles.add(file.path);
        return;
      }
      setAttribute(node, "action", "/xb-form");
      setAttribute(node, "method", "post");
      setAttribute(node, "data-pagefind-ignore", "all");
      setAttribute(node, "data-histos-fluent-form", String(id));
      setAttribute(node, "data-histos-turnstile-sitekey", settings.turnstileSiteKey);
      attachedIds.add(id);
      attachedForms += 1;
      changed = true;
    });
    if (changed) {
      const serialized = parse5.serialize(document as never);
      transformed.set(file.path, Buffer.from(insertBeforeClosingBody(serialized, '<script defer src="/xb-form-client.js"></script>'), "utf8"));
      linkedFiles.add(file.path);
    }
  }

  const unmatchedIds = [...configuredIds].filter((id) => !attachedIds.has(id)).sort((left, right) => left - right);
  const resultFiles = files.map((file) => {
    const bytes = transformed.get(file.path);
    return bytes ? { ...file, bytes, size: bytes.byteLength } : file;
  });
  const enabled = attachedIds.size > 0;
  if (enabled) resultFiles.push({ path: FLUENT_FORMS_CLIENT_PATH, bytes: Buffer.from(fluentFormsClientSource(), "utf8") });
  const findings = [
    ...[...unsupportedFiles].sort().map((file) => ({ code: "fluent-forms-unsupported", severity: "warn" as const, file, message: "Il modulo Fluent Forms contiene un caricamento file, una verifica antispam già integrata o un pagamento non supportato. Rimane inattivo nella copia statica." })),
    ...unmatchedIds.map((id) => ({ code: "fluent-forms-unmatched", severity: "warn" as const, file: "", message: `Il modulo Fluent Forms ${id} configurato non è presente nelle pagine pubblicate e non verrà collegato.` })),
  ];
  return {
    files: resultFiles,
    report: {
      enabled,
      adapter: "wordpress-fluent-forms",
      restUrl: settings.restUrl,
      turnstileSiteKey: settings.turnstileSiteKey,
      fluentFormIds: [...attachedIds].sort((left, right) => left - right),
      attachedForms,
      unsupportedFiles: [...unsupportedFiles].sort(),
      unmatchedIds,
      linkedFiles: [...linkedFiles].sort(),
    },
    findings,
    linkedFiles: [...linkedFiles].sort(),
  };
}

export function validateWordPressRestUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new HistosPublishError("Inserisci l’indirizzo REST di WordPress, per esempio https://sito.example/wp-json/.", "forms-config-invalid", 2); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith("/wp-json/")) {
    throw new HistosPublishError("L’indirizzo deve essere HTTPS, senza credenziali o query, e terminare con /wp-json/.", "forms-config-invalid", 2);
  }
  return parsed.href;
}
