const net = require('net');
const { v4: uuidv4 } = require('uuid');

/**
 * TCPProxy - Raw TCP proxy for capturing JSON packet traffic
 * 
 * GT and similar apps communicate via raw TCP sockets sending JSON.
 * This proxy sits between client and server, captures every byte,
 * detects JSON packet boundaries, and emits parsed sessions.
 * 
 * Supports:
 *  - Newline-delimited JSON (NDJSON) — most common for game/chat protocols
 *  - Length-prefixed JSON (4-byte big-endian header + JSON payload)
 *  - Raw JSON detection (braces matching when no delimiter found)
 *  - Multiple simultaneous connections
 *  - Full bidirectional capture (outgoing + incoming)
 */
class TCPProxy {
  constructor() {
    this.servers = new Map(); // listenPort -> { server, targetHost, targetPort, connections }
    this.onPacket = null;     // (packet) => void — called for each captured packet
    this.onConnection = null; // (conn) => void — called when a new TCP connection is established
    this.onDisconnect = null; // (conn) => void — called when a connection closes
    this._connectionCounter = 0;
  }

  /**
   * Start a TCP proxy: listen on localPort, forward to targetHost:targetPort
   * Returns the server info
   */
  async startProxy(localPort, targetHost, targetPort, label = '') {
    if (this.servers.has(localPort)) {
      throw new Error(`TCP proxy already running on port ${localPort}`);
    }

    return new Promise((resolve, reject) => {
      const connections = new Map();
      const server = net.createServer((clientSocket) => {
        this._handleConnection(clientSocket, targetHost, targetPort, localPort, connections, label);
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${localPort} is already in use`));
        } else {
          reject(err);
        }
      });

      server.listen(localPort, '0.0.0.0', () => {
        const info = {
          localPort,
          targetHost,
          targetPort,
          label: label || `${targetHost}:${targetPort}`,
          server,
          connections
        };
        this.servers.set(localPort, info);
        console.log(`[TCPProxy] Listening on :${localPort} → ${targetHost}:${targetPort} (${label || 'TCP'})`);
        resolve(info);
      });
    });
  }

  /**
   * Stop a specific TCP proxy
   */
  async stopProxy(localPort) {
    const info = this.servers.get(localPort);
    if (!info) return;

    // Close all active connections
    for (const [connId, conn] of info.connections) {
      try { conn.clientSocket.destroy(); } catch (e) {}
      try { conn.serverSocket.destroy(); } catch (e) {}
    }
    info.connections.clear();

    return new Promise((resolve) => {
      info.server.close(() => {
        this.servers.delete(localPort);
        console.log(`[TCPProxy] Stopped proxy on :${localPort}`);
        resolve();
      });
      setTimeout(resolve, 2000);
    });
  }

  /**
   * Stop all TCP proxies
   */
  async stopAll() {
    const ports = [...this.servers.keys()];
    for (const port of ports) {
      await this.stopProxy(port);
    }
  }

  /**
   * Get status of all running proxies
   */
  getStatus() {
    const result = [];
    for (const [port, info] of this.servers) {
      result.push({
        localPort: port,
        targetHost: info.targetHost,
        targetPort: info.targetPort,
        label: info.label,
        activeConnections: info.connections.size
      });
    }
    return result;
  }

  /**
   * Handle a new incoming TCP connection
   */
  _handleConnection(clientSocket, targetHost, targetPort, localPort, connections, label) {
    const connId = ++this._connectionCounter;
    const connectionId = uuidv4();
    const startTime = Date.now();

    const connInfo = {
      id: connectionId,
      connId,
      localPort,
      targetHost,
      targetPort,
      label,
      clientSocket,
      serverSocket: null,
      clientAddr: `${clientSocket.remoteAddress}:${clientSocket.remotePort}`,
      startTime,
      outgoingPackets: 0,
      incomingPackets: 0,
      outgoingBytes: 0,
      incomingBytes: 0,
      // JSON parsing state for each direction
      _clientBuffer: Buffer.alloc(0),
      _serverBuffer: Buffer.alloc(0),
      _packetSeq: 0
    };

    connections.set(connectionId, connInfo);

    if (this.onConnection) {
      this.onConnection({
        id: connectionId,
        connId,
        localPort,
        targetHost,
        targetPort,
        label,
        clientAddr: connInfo.clientAddr,
        startTime
      });
    }

    // Connect to the real target
    const serverSocket = net.connect(targetPort, targetHost, () => {
      connInfo.serverSocket = serverSocket;
      console.log(`[TCPProxy] Connection #${connId}: ${connInfo.clientAddr} → ${targetHost}:${targetPort}`);
    });

    connInfo.serverSocket = serverSocket;

    // Client → Server (outgoing)
    clientSocket.on('data', (chunk) => {
      connInfo.outgoingBytes += chunk.length;
      try { serverSocket.write(chunk); } catch (e) {}

      // Parse JSON packets from the stream
      this._processChunk(chunk, connInfo, 'outgoing');
    });

    // Server → Client (incoming)
    serverSocket.on('data', (chunk) => {
      connInfo.incomingBytes += chunk.length;
      try { clientSocket.write(chunk); } catch (e) {}

      // Parse JSON packets from the stream
      this._processChunk(chunk, connInfo, 'incoming');
    });

    // Cleanup on close
    const cleanup = () => {
      connections.delete(connectionId);
      if (this.onDisconnect) {
        this.onDisconnect({
          id: connectionId,
          connId,
          duration: Date.now() - startTime,
          outgoingPackets: connInfo.outgoingPackets,
          incomingPackets: connInfo.incomingPackets,
          outgoingBytes: connInfo.outgoingBytes,
          incomingBytes: connInfo.incomingBytes
        });
      }
    };

    clientSocket.on('end', () => { try { serverSocket.end(); } catch (e) {} });
    serverSocket.on('end', () => { try { clientSocket.end(); } catch (e) {} });
    clientSocket.on('close', cleanup);
    clientSocket.on('error', () => { serverSocket.destroy(); });
    serverSocket.on('error', () => { clientSocket.destroy(); });
    serverSocket.setTimeout(120000, () => { serverSocket.destroy(); clientSocket.destroy(); });
  }

  /**
   * Process a chunk of data, detect JSON boundaries, emit packets
   */
  _processChunk(chunk, connInfo, direction) {
    const bufferKey = direction === 'outgoing' ? '_clientBuffer' : '_serverBuffer';
    connInfo[bufferKey] = Buffer.concat([connInfo[bufferKey], chunk]);

    // Try to extract JSON packets from buffer
    let extracted;
    while ((extracted = this._extractJsonPacket(connInfo[bufferKey])) !== null) {
      const { json, parsed, remaining, raw } = extracted;
      connInfo[bufferKey] = remaining;

      const seq = ++connInfo._packetSeq;
      if (direction === 'outgoing') {
        connInfo.outgoingPackets++;
      } else {
        connInfo.incomingPackets++;
      }

      if (this.onPacket) {
        this.onPacket({
          id: uuidv4(),
          connectionId: connInfo.id,
          connId: connInfo.connId,
          direction,
          seq,
          timestamp: Date.now(),
          localPort: connInfo.localPort,
          targetHost: connInfo.targetHost,
          targetPort: connInfo.targetPort,
          label: connInfo.label,
          clientAddr: connInfo.clientAddr,
          raw: raw,
          json: json,
          parsed: parsed,
          size: Buffer.byteLength(raw, 'utf-8'),
          // Derive useful fields from the JSON if possible
          type: this._detectPacketType(parsed),
          action: this._detectAction(parsed)
        });
      }
    }

    // Safety: prevent buffer from growing unbounded if no JSON is found
    if (connInfo[bufferKey].length > 1024 * 1024) {
      // Emit as raw data and reset
      if (this.onPacket) {
        this.onPacket({
          id: uuidv4(),
          connectionId: connInfo.id,
          connId: connInfo.connId,
          direction,
          seq: ++connInfo._packetSeq,
          timestamp: Date.now(),
          localPort: connInfo.localPort,
          targetHost: connInfo.targetHost,
          targetPort: connInfo.targetPort,
          label: connInfo.label,
          clientAddr: connInfo.clientAddr,
          raw: connInfo[bufferKey].toString('utf-8').substring(0, 10000),
          json: null,
          parsed: null,
          size: connInfo[bufferKey].length,
          type: 'raw',
          action: 'data'
        });
      }
      connInfo[bufferKey] = Buffer.alloc(0);
    }
  }

  /**
   * Try to extract a complete JSON object/array from the buffer.
   * Supports:
   *  1. Newline-delimited JSON (most common)
   *  2. Length-prefixed (4-byte big-endian header)
   *  3. Brace-matching for bare JSON
   */
  _extractJsonPacket(buffer) {
    if (buffer.length === 0) return null;

    const str = buffer.toString('utf-8');

    // Strategy 1: Newline-delimited JSON (NDJSON)
    const newlineIdx = str.indexOf('\n');
    if (newlineIdx !== -1) {
      const line = str.substring(0, newlineIdx).trim();
      const remainingStr = str.substring(newlineIdx + 1);
      const remaining = Buffer.from(remainingStr, 'utf-8');

      if (line.length === 0) {
        // Empty line, skip
        return this._extractJsonPacket(remaining);
      }

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(line);
        return { json: line, parsed, remaining, raw: line };
      } catch (e) {
        // Not JSON, emit as raw text line
        return { json: null, parsed: null, remaining, raw: line };
      }
    }

    // Strategy 2: Length-prefixed (4 bytes BE uint32 + payload)
    if (buffer.length >= 4) {
      const possibleLen = buffer.readUInt32BE(0);
      // Sanity check: length should be reasonable (1 byte to 10MB)
      if (possibleLen > 0 && possibleLen < 10 * 1024 * 1024 && buffer.length >= 4 + possibleLen) {
        const payload = buffer.slice(4, 4 + possibleLen).toString('utf-8');
        const remaining = buffer.slice(4 + possibleLen);
        try {
          const parsed = JSON.parse(payload);
          return { json: payload, parsed, remaining, raw: payload };
        } catch (e) {
          // Length prefix didn't yield valid JSON, fall through
        }
      }
    }

    // Strategy 3: Brace matching for complete JSON objects
    if (str.trimStart().startsWith('{') || str.trimStart().startsWith('[')) {
      const trimmedStart = str.length - str.trimStart().length;
      const startChar = str.trimStart()[0];
      const endChar = startChar === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = trimmedStart; i < str.length; i++) {
        const ch = str[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            const jsonStr = str.substring(trimmedStart, i + 1);
            const remainingStr = str.substring(i + 1);
            const remaining = Buffer.from(remainingStr, 'utf-8');
            try {
              const parsed = JSON.parse(jsonStr);
              return { json: jsonStr, parsed, remaining, raw: jsonStr };
            } catch (e) {
              // Brace matched but not valid JSON
              return null;
            }
          }
        }
      }
      // Incomplete JSON, wait for more data
      return null;
    }

    // No pattern matched, wait for more data
    return null;
  }

  /**
   * Try to detect the packet type from parsed JSON
   * Looks for common fields like "type", "event", "cmd", "op", "action", "method"
   */
  _detectPacketType(parsed) {
    if (!parsed || typeof parsed !== 'object') return 'data';
    
    // Common type fields
    const typeFields = ['type', 'event', 'cmd', 'op', 'opcode', 'command', 'msgType', 'msg_type', 'packet_type', 'packetType', 'kind', 'category'];
    for (const field of typeFields) {
      if (parsed[field] !== undefined) {
        return String(parsed[field]);
      }
    }

    // Check nested common patterns
    if (parsed.header && parsed.header.type) return String(parsed.header.type);
    if (parsed.meta && parsed.meta.type) return String(parsed.meta.type);
    if (parsed.data && parsed.data.type) return String(parsed.data.type);

    return 'data';
  }

  /**
   * Try to detect the action/method from parsed JSON
   */
  _detectAction(parsed) {
    if (!parsed || typeof parsed !== 'object') return '';

    const actionFields = ['action', 'method', 'name', 'endpoint', 'route', 'path', 'channel', 'topic', 'subject'];
    for (const field of actionFields) {
      if (parsed[field] !== undefined && typeof parsed[field] === 'string') {
        return parsed[field];
      }
    }

    if (parsed.header && parsed.header.action) return parsed.header.action;
    if (parsed.meta && parsed.meta.action) return parsed.meta.action;

    return '';
  }
}

module.exports = TCPProxy;
