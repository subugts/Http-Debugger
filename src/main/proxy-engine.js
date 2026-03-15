const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

/**
 * ProxyEngine - System-wide HTTP/HTTPS traffic sniffer
 * Automatically configures macOS system proxy to capture ALL local HTTP traffic.
 * No manual proxy configuration needed — just click Capture.
 */
class ProxyEngine {
  constructor(port = 8888) {
    this.port = port;
    this.server = null;
    this.onRequest = null;
    this.onSessionUpdate = null;
    this.isRunning = false;
    this._ca = null;
    this._certs = new Map();
    this._originalProxySettings = {};
    this._networkServices = [];
    this._generateCA();
  }

  _generateCA() {
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
      });
      this._caKey = privateKey;
      this._caPublicKey = publicKey;
    } catch (e) {
      this._caKey = null;
    }
  }

  // ==========================================
  // macOS System Proxy Management
  // ==========================================

  /**
   * Detect all active network services (Wi-Fi, Ethernet, etc.)
   */
  _detectNetworkServices() {
    try {
      const output = execSync('networksetup -listallnetworkservices', { encoding: 'utf-8' });
      const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('An asterisk'));
      this._networkServices = lines;
      console.log(`[ProxyEngine] Detected network services: ${lines.join(', ')}`);
      return lines;
    } catch (e) {
      this._networkServices = ['Wi-Fi', 'Ethernet'];
      return this._networkServices;
    }
  }

  /**
   * Save current proxy settings so we can restore them later
   */
  _saveOriginalProxySettings() {
    this._originalProxySettings = {};
    for (const service of this._networkServices) {
      try {
        const httpProxy = execSync(`networksetup -getwebproxy "${service}"`, { encoding: 'utf-8' });
        const httpsProxy = execSync(`networksetup -getsecurewebproxy "${service}"`, { encoding: 'utf-8' });
        this._originalProxySettings[service] = {
          http: this._parseProxyOutput(httpProxy),
          https: this._parseProxyOutput(httpsProxy)
        };
      } catch (e) {
        // Service might not support proxy settings
      }
    }
  }

  _parseProxyOutput(output) {
    const result = { enabled: false, server: '', port: 0 };
    const lines = output.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim().toLowerCase() === 'enabled') {
        result.enabled = value.toLowerCase() === 'yes';
      } else if (key.trim().toLowerCase() === 'server') {
        result.server = value;
      } else if (key.trim().toLowerCase() === 'port') {
        result.port = parseInt(value) || 0;
      }
    }
    return result;
  }

  /**
   * Set system-wide HTTP & HTTPS proxy to our proxy server
   */
  _enableSystemProxy() {
    const errors = [];
    for (const service of this._networkServices) {
      try {
        execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setwebproxystate "${service}" on`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxystate "${service}" on`, { encoding: 'utf-8' });
        console.log(`[ProxyEngine] ✅ System proxy set on: ${service}`);
      } catch (e) {
        errors.push(`${service}: ${e.message}`);
      }
    }
    if (errors.length > 0) {
      console.warn(`[ProxyEngine] ⚠️ Could not set proxy on some services:`, errors);
    }
  }

  /**
   * Restore original system proxy settings
   */
  _restoreSystemProxy() {
    for (const service of this._networkServices) {
      try {
        const original = this._originalProxySettings[service];
        if (original && original.http.enabled) {
          execSync(`networksetup -setwebproxy "${service}" ${original.http.server} ${original.http.port}`, { encoding: 'utf-8' });
          execSync(`networksetup -setwebproxystate "${service}" on`, { encoding: 'utf-8' });
        } else {
          execSync(`networksetup -setwebproxystate "${service}" off`, { encoding: 'utf-8' });
        }
        if (original && original.https.enabled) {
          execSync(`networksetup -setsecurewebproxy "${service}" ${original.https.server} ${original.https.port}`, { encoding: 'utf-8' });
          execSync(`networksetup -setsecurewebproxystate "${service}" on`, { encoding: 'utf-8' });
        } else {
          execSync(`networksetup -setsecurewebproxystate "${service}" off`, { encoding: 'utf-8' });
        }
        console.log(`[ProxyEngine] ✅ System proxy restored on: ${service}`);
      } catch (e) {
        try {
          execSync(`networksetup -setwebproxystate "${service}" off`, { encoding: 'utf-8' });
          execSync(`networksetup -setsecurewebproxystate "${service}" off`, { encoding: 'utf-8' });
        } catch (e2) {
          console.error(`[ProxyEngine] ❌ Failed to restore proxy on ${service}:`, e2.message);
        }
      }
    }
  }

  // ==========================================
  // Proxy Server Start / Stop
  // ==========================================

  async start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      // 1. Detect network services
      this._detectNetworkServices();
      // 2. Save current proxy settings
      this._saveOriginalProxySettings();

      // 3. Create proxy server
      this.server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res);
      });

      this.server.on('connect', (req, clientSocket, head) => {
        this._handleConnect(req, clientSocket, head);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use. Change the port in Settings.`));
        } else {
          reject(err);
        }
      });

      // 4. Listen on 0.0.0.0 (all interfaces)
      this.server.listen(this.port, '0.0.0.0', () => {
        this.isRunning = true;

        // 5. Set system proxy to route ALL traffic through us
        try {
          this._enableSystemProxy();
          console.log(`[ProxyEngine] 🚀 Listening on 0.0.0.0:${this.port} — System proxy ACTIVE — capturing ALL local HTTP traffic`);
        } catch (e) {
          console.warn(`[ProxyEngine] ⚠️ Could not auto-set system proxy: ${e.message}. Set it manually.`);
        }

        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      // 1. Restore system proxy FIRST (so network continues working)
      try {
        this._restoreSystemProxy();
        console.log('[ProxyEngine] System proxy restored.');
      } catch (e) {
        console.error('[ProxyEngine] Error restoring system proxy:', e.message);
      }

      if (!this.isRunning || !this.server) {
        this.isRunning = false;
        resolve();
        return;
      }

      this.server.close(() => {
        this.isRunning = false;
        console.log('[ProxyEngine] Proxy server stopped.');
        resolve();
      });

      // Force close after 3 seconds
      setTimeout(() => {
        this.isRunning = false;
        resolve();
      }, 3000);
    });
  }

  // ==========================================
  // HTTP Request Handling
  // ==========================================

  _handleHttpRequest(clientReq, clientRes) {
    const startTime = Date.now();
    const sessionId = uuidv4();

    let targetUrl = clientReq.url;
    let parsedUrl;

    try {
      if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
        parsedUrl = new URL(targetUrl);
      } else {
        const host = clientReq.headers.host || 'localhost';
        parsedUrl = new URL(`http://${host}${targetUrl}`);
      }
    } catch (e) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: Invalid URL');
      return;
    }

    const targetHost = parsedUrl.hostname;
    const targetPort = parsedUrl.port || 80;
    const targetPath = parsedUrl.pathname + parsedUrl.search;

    if (!targetHost) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: No host');
      return;
    }

    // Skip requests to our own proxy to avoid infinite loops
    if ((targetHost === '127.0.0.1' || targetHost === 'localhost') && parseInt(targetPort) === this.port) {
      clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
      clientRes.end('HTTP Debugger Proxy Active');
      return;
    }

    // === Streaming: emit pending session immediately ===
    const pendingSession = this._createSession({
      id: sessionId,
      method: clientReq.method,
      url: targetUrl,
      protocol: 'HTTP',
      host: targetHost,
      path: targetPath,
      statusCode: 0,
      statusMessage: 'Pending...',
      requestHeaders: clientReq.headers,
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      requestSize: 0,
      responseSize: 0,
      duration: 0,
      requestTimestamp: startTime,
      isPending: true
    });
    if (this.onRequest) {
      this.onRequest(pendingSession);
    }

    const requestBodyChunks = [];
    clientReq.on('data', (chunk) => requestBodyChunks.push(chunk));
    clientReq.on('end', () => {
      const requestBody = Buffer.concat(requestBodyChunks);

      const proxyHeaders = { ...clientReq.headers };
      delete proxyHeaders['proxy-connection'];
      delete proxyHeaders['proxy-authorization'];
      proxyHeaders.host = parsedUrl.host;

      const proxyOptions = {
        hostname: targetHost,
        port: targetPort,
        path: targetPath,
        method: clientReq.method,
        headers: proxyHeaders
      };

      const proxyReq = http.request(proxyOptions, (proxyRes) => {
        const responseChunks = [];
        proxyRes.on('data', (chunk) => responseChunks.push(chunk));
        proxyRes.on('end', () => {
          const responseBody = Buffer.concat(responseChunks);
          const duration = Date.now() - startTime;

          try {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            clientRes.end(responseBody);
          } catch (e) { /* client disconnected */ }

          const session = this._createSession({
            id: sessionId,
            method: clientReq.method,
            url: targetUrl,
            protocol: 'HTTP',
            host: targetHost,
            path: targetPath,
            statusCode: proxyRes.statusCode,
            statusMessage: proxyRes.statusMessage,
            requestHeaders: clientReq.headers,
            responseHeaders: proxyRes.headers,
            requestBody: requestBody.length > 0 ? requestBody.toString('utf-8') : null,
            responseBody: responseBody.toString('utf-8'),
            requestSize: requestBody.length,
            responseSize: responseBody.length,
            duration: duration,
            requestTimestamp: startTime,
            remoteAddress: proxyRes.socket?.remoteAddress,
            remotePort: proxyRes.socket?.remotePort,
            isPending: false
          });

          if (this.onSessionUpdate) {
            this.onSessionUpdate(session);
          }
        });
      });

      proxyReq.on('error', (err) => {
        try {
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          clientRes.end(`Proxy Error: ${err.message}`);
        } catch (e) { /* client gone */ }

        const session = this._createSession({
          id: sessionId,
          method: clientReq.method,
          url: targetUrl,
          protocol: 'HTTP',
          host: targetHost,
          path: targetPath,
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          requestHeaders: clientReq.headers,
          responseHeaders: {},
          requestBody: requestBody.length > 0 ? requestBody.toString('utf-8') : null,
          responseBody: `Error: ${err.message}`,
          requestSize: requestBody.length,
          responseSize: 0,
          duration: Date.now() - startTime,
          error: err.message,
          requestTimestamp: startTime,
          isPending: false
        });

        if (this.onSessionUpdate) {
          this.onSessionUpdate(session);
        }
      });

      proxyReq.setTimeout(60000, () => {
        proxyReq.destroy();
      });

      if (requestBody.length > 0) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  }

  // ==========================================
  // HTTPS CONNECT Tunnel Handling
  // ==========================================

  _handleConnect(req, clientSocket, head) {
    const startTime = Date.now();
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;
    const sessionId = uuidv4();

    // === Streaming: emit pending CONNECT session immediately ===
    const pendingTunnel = this._createSession({
      id: sessionId,
      method: 'CONNECT',
      url: `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}`,
      protocol: 'HTTPS',
      host: hostname,
      path: '/',
      statusCode: 0,
      statusMessage: 'Connecting...',
      requestHeaders: req.headers || {},
      responseHeaders: {},
      requestBody: null,
      responseBody: null,
      requestSize: 0,
      responseSize: 0,
      duration: 0,
      isTunnel: true,
      isPending: true,
      requestTimestamp: startTime
    });
    if (this.onRequest) {
      this.onRequest(pendingTunnel);
    }

    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: HTTP-Debugger\r\n' +
        '\r\n'
      );

      let requestSize = 0;
      let responseSize = 0;
      let sessionCreated = false;

      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      clientSocket.on('data', (chunk) => {
        requestSize += chunk.length;
      });

      serverSocket.on('data', (chunk) => {
        responseSize += chunk.length;
      });

      const createTunnelSession = () => {
        if (sessionCreated) return;
        sessionCreated = true;
        const duration = Date.now() - startTime;
        const session = this._createSession({
          id: sessionId,
          method: 'CONNECT',
          url: `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}`,
          protocol: 'HTTPS',
          host: hostname,
          path: '/',
          statusCode: 200,
          statusMessage: 'Connection Established (Tunnel)',
          requestHeaders: req.headers || {},
          responseHeaders: {},
          requestBody: null,
          responseBody: `[HTTPS Tunnel — ${requestSize} bytes ↑ / ${responseSize} bytes ↓]`,
          requestSize: requestSize,
          responseSize: responseSize,
          duration: duration,
          isTunnel: true,
          requestTimestamp: startTime,
          isPending: false
        });

        if (this.onSessionUpdate) {
          this.onSessionUpdate(session);
        }
      };

      serverSocket.on('end', createTunnelSession);
      serverSocket.on('close', createTunnelSession);
      clientSocket.on('end', createTunnelSession);
      clientSocket.on('close', createTunnelSession);
    });

    serverSocket.on('error', (err) => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      } catch (e) { /* ignore */ }

      const session = this._createSession({
        id: sessionId,
        method: 'CONNECT',
        url: `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}`,
        protocol: 'HTTPS',
        host: hostname,
        path: '/',
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        requestHeaders: req.headers || {},
        responseHeaders: {},
        requestBody: null,
        responseBody: `Error: ${err.message}`,
        requestSize: 0,
        responseSize: 0,
        duration: Date.now() - startTime,
        error: err.message,
        requestTimestamp: startTime,
        isPending: false
      });

      if (this.onSessionUpdate) {
        this.onSessionUpdate(session);
      }
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    serverSocket.setTimeout(120000, () => {
      serverSocket.destroy();
    });
  }

  _createSession(data) {
    const now = Date.now();
    return {
      id: data.id,
      method: data.method,
      url: data.url,
      protocol: data.protocol || 'HTTP',
      host: data.host,
      path: data.path,
      statusCode: data.statusCode,
      statusMessage: data.statusMessage,
      requestHeaders: data.requestHeaders || {},
      responseHeaders: data.responseHeaders || {},
      requestBody: data.requestBody,
      responseBody: data.responseBody,
      requestSize: data.requestSize || 0,
      responseSize: data.responseSize || 0,
      duration: data.duration || 0,
      error: data.error || null,
      isTunnel: data.isTunnel || false,
      contentType: this._getContentType(data.responseHeaders),
      mimeType: this._getMimeType(data.responseHeaders),
      timestamp: now,
      requestTimestamp: data.requestTimestamp || (now - (data.duration || 0)),
      responseTimestamp: now,
      remoteAddress: data.remoteAddress || null,
      remotePort: data.remotePort || null,
      isPending: data.isPending || false
    };
  }

  _getContentType(headers) {
    if (!headers) return 'other';
    const ct = headers['content-type'] || '';
    if (ct.includes('json')) return 'json';
    if (ct.includes('xml')) return 'xml';
    if (ct.includes('html')) return 'html';
    if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
    if (ct.includes('css')) return 'css';
    if (ct.includes('image')) return 'image';
    if (ct.includes('font')) return 'font';
    if (ct.includes('text')) return 'text';
    return 'other';
  }

  _getMimeType(headers) {
    if (!headers) return '';
    return (headers['content-type'] || '').split(';')[0].trim();
  }
}

module.exports = ProxyEngine;
