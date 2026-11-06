import { WebSocket, WebSocketServer } from "ws";
import { webSocketArcjet as wsArcjet } from "../arcjet.js";

const matchSubscribers = new Map();

function subscribe(matchId, socket) {
  const id = Number(matchId); // Normalize to Number
  if (!matchSubscribers.has(id)) {
    matchSubscribers.set(id, new Set());
  }
  matchSubscribers.get(id).add(socket);
}

function unsubscribe(matchId, socket) {
  const id = Number(matchId); // Normalize to Number
  const subscribers = matchSubscribers.get(id);
  if (!subscribers) return;
  subscribers.delete(socket);
  if (subscribers.size === 0) {
    matchSubscribers.delete(id);
  }
}

function cleanUpSubscription(socket) {
  for (const matchId of socket.subscriptions) {
    unsubscribe(matchId, socket);
  }
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify(payload));
  }
}

function broadcastToMatch(matchId, payload) {
  const id = Number(matchId); // Normalize to Number
  const subscribers = matchSubscribers.get(id);

  if (!subscribers || subscribers.size === 0) {
    console.log(`[WS] No subscribers found for match ID: ${id}`);
    return;
  }

  const message = JSON.stringify(payload);
  for (const client of subscribers) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function handleMessage(socket, data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    sendJson(socket, { type: "error", message: "Invalid Json" });
    return; // Stop execution if parsing fails
  }

  // Allow flexible matchId parsing (handles both string and number inputs)
  if (message?.type === "subscribe" && message.matchId !== undefined) {
    const matchIdNum = Number(message.matchId);
    subscribe(matchIdNum, socket);
    socket.subscriptions.add(matchIdNum);
    sendJson(socket, { type: "subscribed", matchId: matchIdNum });
    return;
  }

  if (message?.type === "unsubscribe" && message.matchId !== undefined) {
    const matchIdNum = Number(message.matchId);
    unsubscribe(matchIdNum, socket);
    socket.subscriptions.delete(matchIdNum);
    sendJson(socket, { type: "unsubscribed", matchId: matchIdNum });
  }
}

let globalWssInstance = null;

export function broadcastMatchCreated(match) {
  if (globalWssInstance) {
    broadcastToAll(globalWssInstance, { type: "match_created", data: match });
  }
}

export function broadcastCommentary(matchId, comment) {
  broadcastToMatch(Number(matchId), { type: "commentary", data: comment });
}

export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
    maxPayload: 1024 * 1024,
  });

  globalWssInstance = wss;

  server.on("upgrade", async (req, socket, head) => {
    try {
      if (wsArcjet) {
        const decision = await wsArcjet.protect(req);
        if (decision.isDenied()) {
          socket.end(
            `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            () => socket.destroy(),
          );
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch (error) {
      console.error("ws upgrade error:", error);
      socket.destroy();
    }
  });

  wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.subscriptions = new Set();
    sendJson(socket, { type: "welcome" });

    socket.on("message", (data) => {
      handleMessage(socket, data);
    });

    socket.on("close", () => {
      cleanUpSubscription(socket);
    });
    socket.on("error", console.error);
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(interval));

  return { broadcastMatchCreated, broadcastCommentary };
}
