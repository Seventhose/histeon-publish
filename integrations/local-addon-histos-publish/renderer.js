module.exports = function registerHistosPublishAddon(context) {
  const hooks = context && context.hooks;
  if (!hooks || typeof hooks.addFilter !== "function") return;

  hooks.addFilter("siteInfoMoreMenu", function addHistosPublishMenuItem(menu, site) {
    if (!Array.isArray(menu) || !site || typeof site.domain !== "string" || !site.domain.trim()) return menu;

    menu.push({
      label: "Apri in Histeon Publish",
      enabled: true,
      click: function openSiteInHistosPublish() {
        const target = new URL(`http://${site.domain.trim()}`);
        const hostname = target.hostname.toLowerCase();
        if (hostname !== "localhost" && !hostname.endsWith(".localhost") && !hostname.endsWith(".local")) {
          context.notifier.notify({
            title: "Histeon Publish",
            message: "Local non ha restituito un dominio .local valido per questo sito.",
          });
          return;
        }

        const deepLink = new URL("histos-publish://import");
        deepLink.searchParams.set("url", target.href);
        deepLink.searchParams.set("name", String(site.name || "Sito Local").slice(0, 80));

        const fallback = () => context.notifier.notify({
          title: "Histeon Publish",
          message: "Non riesco ad aprire Histeon Publish. Controlla che sia installato e che il collegamento histos-publish:// sia registrato.",
          open: deepLink.href,
        });
        try {
          const shell = context.electron && context.electron.shell;
          if (shell && typeof shell.openExternal === "function") {
            Promise.resolve(shell.openExternal(deepLink.href)).catch(fallback);
          } else {
            fallback();
          }
        } catch {
          fallback();
        }
      },
    });

    return menu;
  });
};
