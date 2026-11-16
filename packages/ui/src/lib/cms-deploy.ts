export interface CmsDeploySite {
  id: string;
  name: string;
  deployTarget?: "cloudflare" | "ftp";
  accountId: string | null;
  worker: string | null;
  hosting?: { protocol: "ftp" | "ftps" | "sftp"; host: string; remoteDirectory: string } | null;
  hostingCredentialsConfigured?: boolean;
}

export interface CmsDeployTokenState {
  configured: boolean;
  available: boolean;
}

export function availableCmsDeployTargets(sites: readonly CmsDeploySite[], token: CmsDeployTokenState | undefined, defaultAccountId = ""): CmsDeploySite[] {
  return sites.filter((site) => {
    if (site.deployTarget === "ftp") return Boolean(site.hosting?.host && site.hosting.protocol && site.hostingCredentialsConfigured);
    const accountId = site.accountId || defaultAccountId;
    return Boolean(token?.configured && token.available && accountId && /^[0-9a-f]{32}$/iu.test(accountId) && site.worker && /^[a-z0-9-]{1,63}$/u.test(site.worker));
  });
}

export function cmsDeployTargetLabel(site: CmsDeploySite): string {
  if (site.deployTarget === "ftp") return `${site.name} · ${site.hosting?.protocol.toUpperCase()} · ${site.hosting?.host}`;
  return `${site.name} · Cloudflare · ${site.worker}`;
}
