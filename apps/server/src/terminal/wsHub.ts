import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerConfig } from "../config.js";
import { originAllowed, requestAuthorized } from "../auth.js";

export type WsRouteHandler = (
  pathname: string,
  ws: WebSocket,
  request: IncomingMessage,
) => void;

export function attachWsHub(
  server: { on: (event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown },
  config: ServerConfig,
  handler: WsRouteHandler,
): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!originAllowed(request, config)) {
      socket.destroy();
      return;
    }
    if (!requestAuthorized(request, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    wss.handleUpgrade(request, socket, head, (ws) => handler(pathname, ws, request));
  });
}
