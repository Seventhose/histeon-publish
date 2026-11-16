import { describe, expect, it } from "vitest";
import { availableCmsDeployTargets, cmsDeployTargetLabel, type CmsDeploySite } from "../src/lib/cms-deploy.js";

describe("selezione della destinazione di deploy CMS", () => {
  const sites: CmsDeploySite[] = [
    { id: "cf-ready", name: "Cloudflare pronto", deployTarget: "cloudflare", accountId: "a".repeat(32), worker: "cms-site" },
    { id: "cf-missing-account", name: "Account assente", deployTarget: "cloudflare", accountId: null, worker: "cms-site-2" },
    { id: "ftp-ready", name: "Hosting pronto", deployTarget: "ftp", accountId: null, worker: null, hosting: { protocol: "sftp", host: "ftp.example.test", remoteDirectory: "/public" }, hostingCredentialsConfigured: true },
    { id: "ftp-missing-credentials", name: "Hosting incompleto", deployTarget: "ftp", accountId: null, worker: null, hosting: { protocol: "ftps", host: "ftp.example.test", remoteDirectory: "/public" }, hostingCredentialsConfigured: false },
  ];

  it("mostra soltanto le destinazioni configurate e identifica esplicitamente il provider", () => {
    const targets = availableCmsDeployTargets(sites, { configured: true, available: true });
    expect(targets.map((site) => site.id)).toEqual(["cf-ready", "ftp-ready"]);
    const cloudflare = targets.find((site) => site.id === "cf-ready");
    const hosting = targets.find((site) => site.id === "ftp-ready");
    if (!cloudflare || !hosting) throw new Error("Destinazioni configurate non trovate.");
    expect(cmsDeployTargetLabel(cloudflare)).toContain("Cloudflare");
    expect(cmsDeployTargetLabel(hosting)).toContain("SFTP");
  });

  it("non propone Cloudflare senza token utilizzabile, ma usa l’account predefinito quando serve", () => {
    expect(availableCmsDeployTargets(sites, { configured: false, available: true }).map((site) => site.id)).toEqual(["ftp-ready"]);
    const withoutSiteAccount = [{ id: "cf-default", name: "Account predefinito", accountId: null, worker: "cms-default" }];
    expect(availableCmsDeployTargets(withoutSiteAccount, { configured: true, available: true }, "c".repeat(32))).toHaveLength(1);
  });
});
