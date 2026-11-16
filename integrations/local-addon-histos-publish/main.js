// Local 10.1.2 rebuilds its enabled-addons preference from add-ons loaded in
// the main process. A renderer-only add-on is therefore disabled on restart.
// This no-op main entry lets Local persist the enabled state; the actual UI
// integration lives in renderer.js.
class HistosPublishLocalAddonMain {
  constructor() {}
}

module.exports = HistosPublishLocalAddonMain;
