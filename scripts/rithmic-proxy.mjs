import net from "net";
import { WebSocketServer } from "ws";

// Configurações
const WS_PORT = 8080;
const TCP_HOST = "localhost";
const TCP_PORT = 3000;

// Cria o servidor WebSocket
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`Servidor WebSocket rodando em ws://localhost:${WS_PORT}`);

wss.on("connection", (ws, req) => {
  const requestId = Date.now();
  console.log(`[Proxy] Conexão WebSocket estabelecida: ${requestId}`);

  // Cria conexão TCP com o servidor de destino
  const tcpSocket = net.connect({ host: TCP_HOST, port: TCP_PORT }, () => {
    console.log(`[Proxy] TCP conectado a ${TCP_HOST}:${TCP_PORT}`);
  });

  // WebSocket -> TCP
  ws.on("message", (data) => {
    if (tcpSocket.readyState === "open") {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
      console.log(`[Proxy] WS->TCP: ${payload.length} bytes`);
      tcpSocket.write(payload);
    }
  });

  // TCP -> WebSocket
  tcpSocket.on("data", (data) => {
    if (ws.readyState === ws.OPEN) {
      console.log(`[Proxy] TCP->WS: ${data.length} bytes`);
      ws.send(data);
    }
  });

  // Tratamento de erros e fechamento
  ws.on("close", (code, reason) => {
    console.log(`[Proxy] WS fechado: ${code} ${reason}`);
    tcpSocket.destroy();
  });

  tcpSocket.on("close", () => {
    console.log(`[Proxy] TCP desconectado`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1001, "Servidor TCP desconectou");
    }
  });

  tcpSocket.on("error", (err) => {
    console.error(`[Proxy] Erro TCP: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `Erro interno: ${err.message}`);
    }
  });

  ws.on("error", (err) => {
    console.error(`[Proxy] Erro WS: ${err.message}`);
    tcpSocket.destroy();
  });
});

wss.on("error", (err) => {
  console.error(`[Proxy] Erro no servidor WebSocket: ${err.message}`);
});
