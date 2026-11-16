import type { IncomingMessage, ServerResponse } from "node:http";
import { HistosPublishError } from "@histos-publish/core";
import { PROTOTYPE_AI_MANUAL } from "@histos-publish/cms";
import type { ConnectorService } from "./connector-server.js";
import { readJson, safeErrorMessage, sendError, sendJson } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * `/api/connector*`: the user's controls for the AI connector, behind the session token and the Origin check of
 * every `/api` route. Only the app can turn the connector on, widen what it may do, or approve a WordPress send.
 */
export async function handleConnectorApi(request: IncomingMessage, response: ServerResponse, parts: string[], url: URL, connector: ConnectorService): Promise<boolean> {
  if (parts[1] !== "connector") return false;
  try {
    return await route(request, response, parts, url, connector);
  } catch (error) {
    // The shared mapping (requestErrorStatus) only trusts the status of cms-… codes and would answer 500 to "already
    // active" or "approval missing": the errors of these routes carry their HTTP status themselves.
    if (error instanceof HistosPublishError && error.exitCode >= 400 && error.exitCode <= 599 && !response.headersSent) {
      sendError(response, error.exitCode, safeErrorMessage(error), error.code);
      return true;
    }
    throw error;
  }
}

async function route(request: IncomingMessage, response: ServerResponse, parts: string[], url: URL, connector: ConnectorService): Promise<boolean> {
  const method = request.method ?? "GET";
  if (parts.length === 2 && method === "GET") {
    const after = Number(url.searchParams.get("after") ?? "0");
    sendJson(response, 200, connector.snapshot(Number.isSafeInteger(after) && after >= 0 ? after : 0));
    return true;
  }
  if (parts.length === 2 && method === "POST") {
    const body = await readJson(request, 1024);
    if (Object.keys(body).some((key) => key !== "enabled" && key !== "autoStart") || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.autoStart !== undefined && typeof body.autoStart !== "boolean")) {
      throw new HistosPublishError("Richiesta non valida.", "connector-request-invalid", 400);
    }
    if (body.enabled === true) await connector.start();
    if (body.enabled === false) await connector.stop("user");
    if (typeof body.autoStart === "boolean") connector.setAutoStart(body.autoStart && connector.enabled);
    sendJson(response, 200, connector.snapshot());
    return true;
  }
  if (parts.length === 3 && parts[2] === "interrupt" && method === "POST") {
    sendJson(response, 200, { interrupted: connector.interrupt() });
    return true;
  }
  if (parts.length === 3 && parts[2] === "manual" && method === "GET") {
    const bytes = Buffer.from(PROTOTYPE_AI_MANUAL, "utf8");
    response.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": bytes.byteLength,
      "Content-Disposition": 'attachment; filename="prototipo-histos-manuale-ai.md"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return true;
  }
  if (parts.length === 3 && parts[2] === "activity" && method === "DELETE") {
    await connector.activity.clear();
    sendJson(response, 200, { cleared: true });
    return true;
  }
  if (parts.length === 4 && parts[2] === "wordpress" && method === "GET") {
    // The project's «Siti collegati» card reads one site's mode: the choice lives next to the connection.
    const connectionId = parts[3] ?? "";
    if (!UUID.test(connectionId) || !connector.hasWordPressConnection(connectionId)) throw new HistosPublishError("Collegamento WordPress non trovato.", "cms-remote-connection-missing", 404);
    sendJson(response, 200, { connectionId, mode: connector.wordpressMode(connectionId) });
    return true;
  }
  if (parts.length === 4 && parts[2] === "wordpress" && method === "PUT") {
    const connectionId = parts[3] ?? "";
    if (!UUID.test(connectionId)) throw new HistosPublishError("Collegamento WordPress non valido.", "cms-remote-connection-missing", 404);
    const body = await readJson(request, 1024);
    if (Object.keys(body).length !== 1 || (body.mode !== "off" && body.mode !== "dry-run" && body.mode !== "confirm" && body.mode !== "auto")) throw new HistosPublishError("Scegli mai, solo prove, con conferma o senza chiedere.", "connector-request-invalid", 400);
    connector.setWordPressMode(connectionId, body.mode);
    sendJson(response, 200, { connectionId, mode: connector.wordpressMode(connectionId) });
    return true;
  }
  if (parts.length === 4 && parts[2] === "approvals" && method === "POST") {
    const requestId = parts[3] ?? "";
    if (!UUID.test(requestId)) throw new HistosPublishError("Questa richiesta non è più in attesa.", "connector-approval-missing", 404);
    const body = await readJson(request, 1024);
    if (Object.keys(body).length !== 1 || (body.decision !== "approve" && body.decision !== "reject")) throw new HistosPublishError("Decisione non valida.", "connector-request-invalid", 400);
    sendJson(response, 200, connector.decide(requestId, body.decision));
    return true;
  }
  throw new HistosPublishError("Percorso API non trovato.", "api-route-missing", 404);
}
