import os from "node:os";
import path from "node:path";

/** Where Histeon Publish keeps its data; the connector client looks for `connector/session.json` here. */
export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  if (env.HISTOS_PUBLISH_DATA_DIR?.trim()) return path.resolve(env.HISTOS_PUBLISH_DATA_DIR.trim());
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "HistosPublish");
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "histos-publish");
}

export const CONNECTOR_DIRECTORY_NAME = "connector";
export const SESSION_FILE_NAME = "session.json";
export const CLIENT_SCRIPT_NAME = "histos-publish-connector.mjs";

export function connectorDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, CONNECTOR_DIRECTORY_NAME);
}
