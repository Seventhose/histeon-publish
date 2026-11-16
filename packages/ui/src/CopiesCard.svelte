<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "./lib/api.js";
  import { translate, type Language } from "./lib/i18n.js";

  /** Encrypted copies in a folder of one's choice, and the way to open one again. */
  let { language }: { language: Language } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  let active = $state("");
  let folder = $state("");
  let passphrase = $state("");
  let message = $state("");
  let opening = $state("");
  let check = $state<Check | null>(null);
  type Check = { result: "ok" | "wrong" | "none"; at: string };

  onMount(() => {
    void api<{ folder: string; check: Check | null }>("/api/settings/copies")
      .then((answer) => { active = answer.folder; folder = answer.folder; check = answer.check; })
      .catch((error: unknown) => { message = error instanceof Error ? error.message : ""; });
  });
  async function checkNow(): Promise<void> {
    try {
      check = (await api<{ check: Check }>("/api/settings/copies/check", { method: "POST" })).check;
    } catch (error) { message = error instanceof Error ? error.message : ""; }
  }
  async function save(event: Event): Promise<void> {
    event.preventDefault();
    try {
      active = (await api<{ folder: string }>("/api/settings/copies", { method: "PUT", body: JSON.stringify({ folder, passphrase }) })).folder;
      passphrase = "";
      message = "";
    } catch (error) { message = error instanceof Error ? error.message : ""; }
  }
  async function turnOff(): Promise<void> {
    try {
      active = (await api<{ folder: string }>("/api/settings/copies", { method: "PUT", body: JSON.stringify({ folder: "" }) })).folder;
      folder = "";
      message = "";
    } catch (error) { message = error instanceof Error ? error.message : ""; }
  }
  async function open(file: File): Promise<void> {
    try {
      const copy = await new Promise<string>((done, failed) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => failed(new Error(file.name));
        reader.readAsDataURL(file);
      });
      const { archive } = await api<{ archive: string }>("/api/settings/copies/open", { method: "POST", body: JSON.stringify({ copy, passphrase: opening }) });
      try {
        const bytes = Uint8Array.from(atob(archive), (char) => char.charCodeAt(0));
        const { project } = await api<{ project: { name: string } }>("/api/cms/v1/projects/restore", { method: "POST", headers: { "Content-Type": "application/zip" }, body: bytes });
        message = t("copies.restored", { name: project.name });
      } catch (error) {
        // The site is still here: the copy never replaces it, and goes to a file to compare or restore by hand.
        if (!(error instanceof ApiError) || error.code !== "cms-project-duplicate") throw error;
        const link = document.createElement("a");
        link.href = `data:application/octet-stream;base64,${archive}`;
        link.download = file.name.replace(/\.sealed$/u, "");
        link.click();
        message = t("copies.opened");
      }
    } catch (error) { message = error instanceof Error ? error.message : ""; }
  }
</script>

<section class="panel-card settings-data" data-testid="settings-copies">
  <h2>{t("copies.title")}</h2>
  <p class="muted">{t("copies.hint")}</p>
  {#if active}
    <p>{t("copies.on", { folder: active })} <button class="button text small" onclick={() => void turnOff()}>{t("copies.off")}</button></p>
    {#if check?.result === "wrong"}
      <p class="delete-error" role="alert">{t("copies.checkWrong")}</p>
    {:else if check?.result === "ok"}
      <p class="muted">{t("copies.checkOk", { date: new Date(check.at).toLocaleDateString(language) })}</p>
    {/if}
    <button class="button outline small" data-testid="copies-check" onclick={() => void checkNow()}>{t("copies.check")}</button>
  {:else}
    <form onsubmit={save}>
      <label class="field-label">{t("copies.folder")}<input bind:value={folder} placeholder="/home/…/pCloud" data-testid="copies-folder" /></label>
      <label class="field-label">{t("copies.passphrase")}<input type="password" bind:value={passphrase} autocomplete="new-password" data-testid="copies-passphrase" /></label>
      <button class="button primary small" data-testid="copies-save">{t("copies.save")}</button>
    </form>
  {/if}
  <details>
    <summary>{t("copies.open")}</summary>
    <label class="field-label">{t("copies.passphrase")}<input type="password" bind:value={opening} autocomplete="off" /></label>
    <input type="file" accept=".sealed" aria-label={t("copies.open")} onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void open(file); }} />
  </details>
  {#if message}<p class="muted" role="status">{message}</p>{/if}
</section>
