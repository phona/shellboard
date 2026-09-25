import { WebSocket } from "ws";
import type { WsEvent } from "@shellboard/contracts";

export class EventBus {
  private readonly clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => {
      this.clients.delete(ws);
    });
  }

  publish(event: WsEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}
