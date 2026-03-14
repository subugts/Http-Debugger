const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * ProxyEngine - HTTP/HTTPS proxy-based traffic sniffer
 * Captures all HTTP(S) traffic passing through the proxy
 */
class ProxyEngine {
  constructor(port = 8888) {
    this.port = port;
    this.server = null;
    this.onRequest = null;
    this.isRunning = false;
    this._ca = null;
    this._certs = new Map();
    this._generateCA();
  }

  _generateCA() {
    // Generate a self-signed CA for SSL interception
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
      });
      this._caKey = privateKey;
      this._caPublicKey = publicKey;
    } catch (e) {
      // Fallback - we'll handle SSL connections without decryption
      this._caKey = null;
    }
  }

  _createFakeCert(hostname) {
    if (this._certs.has(hostname)) {
      return this._certs.get(hostname);
    }

    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
      });

      // Self-signed cert for the hostname
      const cert = {
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        cert: this._createSelfSignedCert(privateKey, hostname)
      };

      this._certs.set(hostname, cert);
      return cert;
    } catch (e) {
      return null;
    }
  }

  _createSelfSignedCert(privateKey, hostname) {
    // Use a basic self-signed approach
    // In production, you'd use a proper CA chain
    try {
      const forge = null; // Would use node-forge in production
      // For now, return null - HTTPS will be handled via CONNECT tunneling
      return null;
    } catch (e) {
      return null;
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve();
        return;
      }

      this.server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res);
      });

      // Handle CONNECT method for HTTPS
      this.server.on('connect', (req, clientSocket, head) => {
        this._handleConnect(req, clientSocket, head);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use. Please choose a different port.`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isRunning = true;
        console.log(`HTTP Debugger proxy listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (!this.isRunning || !this.server) {
        this.isRunning = false;
        resolve();
        return;
      }

      this.server.close(() => {
        this.isRunning = false;
        console.log('HTTP Debugger proxy stopped');
        resolve();
      });

      // Force close after 3 seconds
      setTimeout(() => {
        this.isRunning = false;
        resolve();
      }, 3000);
    });
  }

  _handleHttpRequest(clientReq, clientRes) {
    const startTime = Date.now();
    const sessionId = uuidv4();

    const parsedUrl = url.parse(clientReq.url);
    const targetHost = parsedUrl.hostname || clientReq.headers.host?.split(':')[0];
    const targetPort = parsedUrl.port || 80;
    const targetPath = parsedUrl.path;

    if (!targetHost) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request');
      return;
    }

    // Collect request body
    const requestBodyChunks = [];
    clientReq.on('data', (chunk) => requestBodyChunks.push(chunk));
    clientReq.on('end', () => {
      const requestBody = Buffer.concat(requestBodyChunks);

      const proxyOptions = {
        hostname: targetHost,
        port: targetPort,
        path: targetPath,
        method: clientReq.method,
        headers: { ...clientReq.headers }
      };

      // Remove proxy-specific headers
      delete proxyOptions.headers['proxy-connection'];

      const proxyReq = http.request(proxyOptions, (proxyRes) => {
        const responseChunks = [];
        proxyRes.on('data', (chunk) => responseChunks.push(chunk));
        proxyRes.on('end', () => {
          const responseBody = Buffer.concat(responseChunks);
          const duration = Date.now() - startTime;

          // Forward response to client
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          clientRes.end(responseBody);

          // Create session object
          const session = this._createSession({
            id: sessionId,
            method: clientReq.method,
            url: clientReq.url,
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
            duration: duration
          });

          if (this.onRequest) {
            this.onRequest(session);
          }
        });
      });

      proxyReq.on('error', (err) => {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end(`Proxy Error: ${err.message}`);

        const session = this._createSession({
          id: sessionId,
          method: clientReq.method,
          url: clientReq.url,
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
          error: err.message
        });

        if (this.onRequest) {
          this.onRequest(session);
        }
      });

      if (requestBody.length > 0) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  }

  _handleConnect(req, clientSocket, head) {
    const startTime = Date.now();
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;
    const sessionId = uuidv4();

    // Create tunnel to target server
    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: HTTP-Debugger\r\n' +
        '\r\n'
      );

      // Track data for the session
      let requestSize = 0;
      let responseSize = 0;

      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      // Track sizes
      clientSocket.on('data', (chunk) => {
        requestSize += chunk.length;
      });

      serverSocket.on('data', (chunk) => {
        responseSize += chunk.length;
      });

      const createTunnelSession = () => {
        const duration = Date.now() - startTime;
        const session = this._createSession({
          id: sessionId,
          method: 'CONNECT',
          url: `https://${req.url}`,
          protocol: 'HTTPS',
          host: hostname,
          path: '/',
          statusCode: 200,
          statusMessage: 'Connection Established (Tunnel)',
          requestHeaders: req.headers || {},
          responseHeaders: {},
          requestBody: null,
          responseBody: `[HTTPS Tunnel - ${requestSize} bytes sent, ${responseSize} bytes received]`,
          requestSize: requestSize,
          responseSize: responseSize,
          duration: duration,
          isTunnel: true
        });

        if (this.onRequest) {
          this.onRequest(session);
        }
      };

      serverSocket.on('end', createTunnelSession);
      clientSocket.on('end', createTunnelSession);
    });

    serverSocket.on('error', (err) => {
      clientSocket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
        '\r\n'
      );
      clientSocket.end();

      const session = this._createSession({
        id: sessionId,
        method: 'CONNECT',
        url: `https://${req.url}`,
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
        error: err.message
      });

      if (this.onRequest) {
        this.onRequest(session);
      }
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });
  }

  _createSession(data) {
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
      mimeType: this._getMimeType(data.responseHeaders)
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
