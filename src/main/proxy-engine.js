const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const forge = require('node-forge');

/**
 * ProxyEngine - System-wide HTTP/HTTPS traffic sniffer with MITM decryption
 * Automatically configures macOS system proxy to capture ALL local traffic.
 * HTTPS traffic is decrypted via on-the-fly certificate generation.
 * No manual proxy configuration needed — just click Capture.
 */
class ProxyEngine {
  constructor(port = 8888) {
    this.port = port;
    this.server = null;
    this.onRequest = null;
    this.onSessionUpdate = null;
    this.isRunning = false;

    // MITM CA certificate
    this._caCert = null;
    this._caKey = null;
    this._caCertPEM = null;
    this._caKeyPEM = null;

    // Per-host certificate cache
    this._certCache = new Map();

    // Reusable RSA key pair for host certs (much faster than generating per-host)
    this._hostKeyPair = null;

    // Proxy settings backup
    this._originalProxySettings = {};
    this._networkServices = [];

    // CA cert storage directory
    this._certDir = path.join(require('os').homedir(), '.http-debugger');

    // Initialize CA
    this._initCA();
  }

  // ==========================================
  // Certificate Authority (CA) Management
  // ==========================================

  /**
   * Initialize or load the root CA certificate.
   * Persistent — created once and reused across sessions.
   */
  _initCA() {
    const caCertPath = path.join(this._certDir, 'ca-cert.pem');
    const caKeyPath = path.join(this._certDir, 'ca-key.pem');
    const caVersionPath = path.join(this._certDir, 'ca-version');
    const CURRENT_CA_VERSION = '2'; // Bump this to force CA regeneration

    try {
      if (fs.existsSync(caCertPath) && fs.existsSync(caKeyPath)) {
        // Check CA version — regenerate if outdated
        let existingVersion = '0';
        try { existingVersion = fs.readFileSync(caVersionPath, 'utf-8').trim(); } catch (e) { /* no version file */ }

        if (existingVersion !== CURRENT_CA_VERSION) {
          console.log(`[ProxyEngine] CA version mismatch (${existingVersion} vs ${CURRENT_CA_VERSION}), regenerating CA for better compatibility...`);
          // Remove old CA from keychain before regenerating
          try {
            execSync('security delete-certificate -c "HTTP Debugger CA" /Library/Keychains/System.keychain 2>/dev/null || true', { encoding: 'utf-8', timeout: 5000 });
          } catch (e) { /* ignore */ }
          try {
            execSync('security delete-certificate -c "HTTP Debugger CA" ~/Library/Keychains/login.keychain-db 2>/dev/null || true', { encoding: 'utf-8', timeout: 5000 });
          } catch (e) { /* ignore */ }
          this._generateCA();
          return;
        }

        this._caCertPEM = fs.readFileSync(caCertPath, 'utf-8');
        this._caKeyPEM = fs.readFileSync(caKeyPath, 'utf-8');
        this._caCert = forge.pki.certificateFromPem(this._caCertPEM);
        this._caKey = forge.pki.privateKeyFromPem(this._caKeyPEM);
        console.log('[ProxyEngine] Loaded existing CA certificate (v' + CURRENT_CA_VERSION + ')');
        return;
      }
    } catch (e) {
      console.warn('[ProxyEngine] Could not load existing CA, generating new one:', e.message);
    }

    this._generateCA();
  }

  /**
   * Generate a new root CA certificate for MITM
   */
  _generateCA() {
    console.log('[ProxyEngine] Generating new CA certificate for MITM decryption...');

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');

    // Backdate by 1 day to avoid clock-skew issues
    const notBefore = new Date();
    notBefore.setDate(notBefore.getDate() - 1);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(notBefore.getFullYear() + 10);

    const attrs = [
      { name: 'commonName', value: 'HTTP Debugger CA' },
      { name: 'organizationName', value: 'HTTP Debugger' },
      { name: 'countryName', value: 'US' },
      { shortName: 'ST', value: 'California' },
      { name: 'localityName', value: 'San Francisco' }
    ];

    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: true }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    this._caCert = cert;
    this._caKey = keys.privateKey;
    this._caCertPEM = forge.pki.certificateToPem(cert);
    this._caKeyPEM = forge.pki.privateKeyToPem(keys.privateKey);

    // Clear host cert cache since we have a new CA
    this._certCache.clear();
    this._hostKeyPair = null;

    // Save to disk
    try {
      if (!fs.existsSync(this._certDir)) {
        fs.mkdirSync(this._certDir, { recursive: true });
      }
      fs.writeFileSync(path.join(this._certDir, 'ca-cert.pem'), this._caCertPEM);
      fs.writeFileSync(path.join(this._certDir, 'ca-key.pem'), this._caKeyPEM);
      fs.writeFileSync(path.join(this._certDir, 'ca-version'), '2');
      console.log('[ProxyEngine] CA certificate saved to', this._certDir);
    } catch (e) {
      console.warn('[ProxyEngine] Could not save CA to disk:', e.message);
    }
  }

  /**
   * Generate a TLS certificate for a specific hostname, signed by our CA
   */
  _getHostKeyPair() {
    if (!this._hostKeyPair) {
      this._hostKeyPair = forge.pki.rsa.generateKeyPair(2048);
    }
    return this._hostKeyPair;
  }

  _generateCertForHost(hostname) {
    if (this._certCache.has(hostname)) {
      return this._certCache.get(hostname);
    }

    // Reuse a single RSA key pair for all host certs (much faster)
    const keys = this._getHostKeyPair();
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = crypto.randomBytes(16).toString('hex');

    // Backdate by 1 day to avoid clock-skew issues
    const notBefore = new Date();
    notBefore.setDate(notBefore.getDate() - 1);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(notBefore.getFullYear() + 1);

    const subjectAttrs = [
      { name: 'commonName', value: hostname },
      { name: 'organizationName', value: 'HTTP Debugger' }
    ];
    cert.setSubject(subjectAttrs);
    cert.setIssuer(this._caCert.subject.attributes);

    // SAN extension — critical for modern browsers
    const altNames = [];
    if (net.isIP(hostname)) {
      altNames.push({ type: 7, ip: hostname });
    } else {
      altNames.push({ type: 2, value: hostname });
    }

    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        dataEncipherment: true,
        critical: true
      },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: altNames, critical: false },
      { name: 'subjectKeyIdentifier' },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: true,
        authorityCertIssuer: true,
        serialNumber: true
      }
    ]);

    cert.sign(this._caKey, forge.md.sha256.create());

    // IMPORTANT: Include CA cert in the chain so clients can verify the full chain
    const result = {
      cert: forge.pki.certificateToPem(cert) + this._caCertPEM,
      key: forge.pki.privateKeyToPem(keys.privateKey)
    };

    this._certCache.set(hostname, result);
    return result;
  }

  /** Get the CA certificate PEM for export/installation */
  getCACertPEM() {
    return this._caCertPEM;
  }

  /** Get the CA cert file path */
  getCACertPath() {
    return path.join(this._certDir, 'ca-cert.pem');
  }

  /**
   * Install CA cert into macOS Keychain
   */
  installCACert() {
    const certPath = this.getCACertPath();
    if (!fs.existsSync(certPath)) {
      return { success: false, error: 'CA certificate not found' };
    }

    // Method 1: Use osascript to get admin privileges with a nice dialog
    try {
      execSync(
        `osascript -e 'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \\"${certPath}\\"" with administrator privileges'`,
        { encoding: 'utf-8', timeout: 60000 }
      );
      console.log('[ProxyEngine] CA certificate installed in macOS System Keychain (via osascript)');
      return { success: true };
    } catch (e) {
      console.warn('[ProxyEngine] osascript system keychain failed:', e.message);
    }

    // Method 2: Direct security command (may fail without root)
    try {
      execSync(
        `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      console.log('[ProxyEngine] CA certificate installed in macOS System Keychain');
      return { success: true };
    } catch (e) {
      console.warn('[ProxyEngine] System keychain install failed:', e.message);
    }

    // Method 3: Install to user login keychain
    try {
      execSync(
        `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      console.log('[ProxyEngine] CA certificate installed in user Keychain');
      return { success: true };
    } catch (e2) {
      console.warn('[ProxyEngine] User keychain install failed:', e2.message);
    }

    // Method 4: Trust settings import (another approach)
    try {
      // Create a trust settings plist for the cert
      execSync(
        `security add-certificates -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      console.log('[ProxyEngine] CA certificate added to user Keychain (manual trust may be needed)');
      return { success: true, needsManualTrust: true };
    } catch (e3) {
      return { success: false, error: 'Could not install CA certificate. Please install manually: ' + certPath };
    }
  }

  /** Check if our CA cert is actually trusted for SSL */
  isCATrusted() {
    const certPath = this.getCACertPath();
    if (!fs.existsSync(certPath)) return false;

    // Method 1: Use security verify-cert to actually test trust (most reliable)
    try {
      execSync(
        `security verify-cert -c "${certPath}" -p ssl 2>&1`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return true;
    } catch (e) {
      // verify-cert returns non-zero if not trusted
    }

    // Method 2: Check if cert exists in any keychain
    try {
      const output = execSync(
        `security find-certificate -c "HTTP Debugger CA" -p /Library/Keychains/System.keychain 2>/dev/null || security find-certificate -c "HTTP Debugger CA" -p ~/Library/Keychains/login.keychain-db 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return output.includes('BEGIN CERTIFICATE');
    } catch (e) {
      return false;
    }
  }

  // ==========================================
  // macOS System Proxy Management
  // ==========================================

  _detectNetworkServices() {
    try {
      const output = execSync('networksetup -listallnetworkservices', { encoding: 'utf-8' });
      const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('An asterisk'));
      this._networkServices = lines;
      console.log('[ProxyEngine] Detected network services:', lines.join(', '));
      return lines;
    } catch (e) {
      this._networkServices = ['Wi-Fi', 'Ethernet'];
      return this._networkServices;
    }
  }

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
      } catch (e) { /* skip */ }
    }
  }

  _parseProxyOutput(output) {
    const result = { enabled: false, server: '', port: 0 };
    for (const line of output.split('\n')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim().toLowerCase() === 'enabled') result.enabled = value.toLowerCase() === 'yes';
      else if (key.trim().toLowerCase() === 'server') result.server = value;
      else if (key.trim().toLowerCase() === 'port') result.port = parseInt(value) || 0;
    }
    return result;
  }

  _enableSystemProxy() {
    const errors = [];
    for (const service of this._networkServices) {
      try {
        execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setwebproxystate "${service}" on`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxystate "${service}" on`, { encoding: 'utf-8' });
        console.log(`[ProxyEngine] System proxy set on: ${service}`);
      } catch (e) {
        errors.push(`${service}: ${e.message}`);
      }
    }
    if (errors.length > 0) console.warn('[ProxyEngine] Could not set proxy on some services:', errors);
  }

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
        console.log(`[ProxyEngine] System proxy restored on: ${service}`);
      } catch (e) {
        try {
          execSync(`networksetup -setwebproxystate "${service}" off`, { encoding: 'utf-8' });
          execSync(`networksetup -setsecurewebproxystate "${service}" off`, { encoding: 'utf-8' });
        } catch (e2) {
          console.error(`[ProxyEngine] Failed to restore proxy on ${service}:`, e2.message);
        }
      }
    }
  }

  // ==========================================
  // Proxy Server Start / Stop
  // ==========================================

  async start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) { resolve(); return; }

      this._detectNetworkServices();
      this._saveOriginalProxySettings();

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

      this.server.listen(this.port, '0.0.0.0', () => {
        this.isRunning = true;

        try {
          this._enableSystemProxy();
          console.log(`[ProxyEngine] Listening on 0.0.0.0:${this.port} — System proxy ACTIVE — MITM decryption enabled`);
        } catch (e) {
          console.warn(`[ProxyEngine] Could not auto-set system proxy: ${e.message}`);
        }

        // Auto-install CA cert if not trusted
        if (!this.isCATrusted()) {
          console.log('[ProxyEngine] CA not trusted yet. Attempting auto-install...');
          const result = this.installCACert();
          if (result.success) {
            console.log('[ProxyEngine] CA certificate auto-installed and trusted');
          } else {
            console.warn('[ProxyEngine] Could not auto-install CA:', result.error);
            console.log('[ProxyEngine] Install manually from:', this.getCACertPath());
          }
        } else {
          console.log('[ProxyEngine] CA certificate already trusted');
        }

        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      try {
        this._restoreSystemProxy();
        console.log('[ProxyEngine] System proxy restored.');
      } catch (e) {
        console.error('[ProxyEngine] Error restoring system proxy:', e.message);
      }

      if (!this.isRunning || !this.server) { this.isRunning = false; resolve(); return; }

      this.server.close(() => {
        this.isRunning = false;
        console.log('[ProxyEngine] Proxy server stopped.');
        resolve();
      });

      setTimeout(() => { this.isRunning = false; resolve(); }, 3000);
    });
  }

  // ==========================================
  // HTTP Request Handling (plain HTTP + decrypted HTTPS)
  // ==========================================

  _handleHttpRequest(clientReq, clientRes, isDecryptedHttps = false, targetHost = null, targetPort = null) {
    const startTime = Date.now();
    const sessionId = uuidv4();

    let targetUrl = clientReq.url;
    let parsedUrl;

    try {
      if (isDecryptedHttps) {
        const host = targetHost || clientReq.headers.host || 'localhost';
        const port = targetPort || 443;
        const portSuffix = port === 443 ? '' : `:${port}`;
        targetUrl = `https://${host}${portSuffix}${clientReq.url}`;
        parsedUrl = new URL(targetUrl);
      } else if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
        parsedUrl = new URL(targetUrl);
      } else {
        const host = clientReq.headers.host || 'localhost';
        parsedUrl = new URL(`http://${host}${targetUrl}`);
        targetUrl = parsedUrl.href;
      }
    } catch (e) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: Invalid URL');
      return;
    }

    const resolvedHost = parsedUrl.hostname;
    const resolvedPort = parseInt(parsedUrl.port) || (isDecryptedHttps ? 443 : 80);
    const targetPath = parsedUrl.pathname + parsedUrl.search;
    const protocol = isDecryptedHttps ? 'HTTPS' : 'HTTP';

    if (!resolvedHost) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
      clientRes.end('Bad Request: No host');
      return;
    }

    // Skip self-requests
    if ((resolvedHost === '127.0.0.1' || resolvedHost === 'localhost') && resolvedPort === this.port) {
      clientRes.writeHead(200, { 'Content-Type': 'text/plain' });
      clientRes.end('HTTP Debugger Proxy Active');
      return;
    }

    // === Streaming: emit pending session immediately ===
    const pendingSession = this._createSession({
      id: sessionId,
      method: clientReq.method,
      url: targetUrl,
      protocol: protocol,
      host: resolvedHost,
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
      isPending: true,
      isDecrypted: isDecryptedHttps
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
        hostname: resolvedHost,
        port: resolvedPort,
        path: targetPath,
        method: clientReq.method,
        headers: proxyHeaders,
        rejectUnauthorized: false
      };

      const lib = isDecryptedHttps ? https : http;

      const proxyReq = lib.request(proxyOptions, (proxyRes) => {
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
            protocol: protocol,
            host: resolvedHost,
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
            isPending: false,
            isDecrypted: isDecryptedHttps
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
          protocol: protocol,
          host: resolvedHost,
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
          isPending: false,
          isDecrypted: isDecryptedHttps
        });

        if (this.onSessionUpdate) {
          this.onSessionUpdate(session);
        }
      });

      proxyReq.setTimeout(60000, () => { proxyReq.destroy(); });

      if (requestBody.length > 0) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  }

  // ==========================================
  // HTTPS CONNECT — MITM Decryption
  // ==========================================

  _handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;

    // Tell client the tunnel is established
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-Agent: HTTP-Debugger-MITM\r\n' +
      '\r\n'
    );

    // Generate a TLS certificate for this hostname
    let hostCert;
    try {
      hostCert = this._generateCertForHost(hostname);
    } catch (err) {
      console.error(`[ProxyEngine] Failed to generate cert for ${hostname}:`, err.message);
      this._handleConnectFallback(req, clientSocket, head, hostname, targetPort);
      return;
    }

    // Create TLS options with our fake cert + CA chain
    const tlsOptions = {
      key: hostCert.key,
      cert: hostCert.cert,
      ca: this._caCertPEM,
      isServer: true,
      SNICallback: (servername, cb) => {
        try {
          const sniCert = this._generateCertForHost(servername);
          const ctx = tls.createSecureContext({
            key: sniCert.key,
            cert: sniCert.cert,
            ca: this._caCertPEM
          });
          cb(null, ctx);
        } catch (e) {
          cb(e);
        }
      }
    };

    // Upgrade client socket to TLS (we pretend to be the target server)
    const tlsSocket = new tls.TLSSocket(clientSocket, tlsOptions);

    tlsSocket.on('error', (err) => {
      // TLS handshake failed — client doesn't trust our CA or cert pinning
      const errStr = (err.code || '') + ' ' + (err.message || '');
      if (errStr.includes('alert') || errStr.includes('SSL') || errStr.includes('TLS') ||
          errStr.includes('ECONNRESET') || errStr.includes('EPIPE') ||
          errStr.includes('CERTIFICATE') || errStr.includes('handshake')) {
        // Expected when client has cert pinning or doesn't trust our CA
        // Don't spam the console for known cert-pinning apps
      } else {
        console.warn(`[ProxyEngine] MITM error for ${hostname}:`, err.message);
      }
      try { tlsSocket.destroy(); } catch (e) { /* already destroyed */ }
    });

    // Once TLS handshake succeeds, parse HTTP inside the tunnel
    this._createMitmHttpServer(tlsSocket, hostname, targetPort);
  }

  /**
   * Create a virtual HTTP server on the decrypted TLS socket
   */
  _createMitmHttpServer(tlsSocket, hostname, targetPort) {
    const internalServer = http.createServer((req, res) => {
      this._handleHttpRequest(req, res, true, hostname, targetPort);
    });
    internalServer.emit('connection', tlsSocket);
  }

  /**
   * Fallback: opaque CONNECT tunnel when MITM fails
   */
  _handleConnectFallback(req, clientSocket, head, hostname, targetPort) {
    const startTime = Date.now();
    const sessionId = uuidv4();

    const pendingTunnel = this._createSession({
      id: sessionId,
      method: 'CONNECT',
      url: `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}`,
      protocol: 'HTTPS',
      host: hostname,
      path: '/',
      statusCode: 0,
      statusMessage: 'Tunnel (no decryption)...',
      requestHeaders: req.headers || {},
      responseHeaders: {},
      isTunnel: true,
      isPending: true,
      isDecrypted: false,
      requestTimestamp: startTime
    });
    if (this.onRequest) { this.onRequest(pendingTunnel); }

    const serverSocket = net.connect(targetPort, hostname, () => {
      let requestSize = 0;
      let responseSize = 0;
      let sessionCreated = false;

      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      clientSocket.on('data', (chunk) => { requestSize += chunk.length; });
      serverSocket.on('data', (chunk) => { responseSize += chunk.length; });

      const createTunnelSession = () => {
        if (sessionCreated) return;
        sessionCreated = true;
        const session = this._createSession({
          id: sessionId,
          method: 'CONNECT',
          url: `https://${hostname}${targetPort !== 443 ? ':' + targetPort : ''}`,
          protocol: 'HTTPS',
          host: hostname,
          path: '/',
          statusCode: 200,
          statusMessage: 'Tunnel (opaque)',
          requestHeaders: req.headers || {},
          responseHeaders: {},
          responseBody: `[HTTPS Tunnel — ${requestSize} bytes up / ${responseSize} bytes down — not decrypted]`,
          requestSize, responseSize,
          duration: Date.now() - startTime,
          isTunnel: true,
          isDecrypted: false,
          requestTimestamp: startTime,
          isPending: false
        });
        if (this.onSessionUpdate) { this.onSessionUpdate(session); }
      };

      serverSocket.on('end', createTunnelSession);
      serverSocket.on('close', createTunnelSession);
      clientSocket.on('end', createTunnelSession);
      clientSocket.on('close', createTunnelSession);
    });

    serverSocket.on('error', (err) => {
      try { clientSocket.end(); } catch (e) { /* ignore */ }
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
        responseBody: `Error: ${err.message}`,
        error: err.message,
        duration: Date.now() - startTime,
        requestTimestamp: startTime,
        isPending: false,
        isDecrypted: false
      });
      if (this.onSessionUpdate) { this.onSessionUpdate(session); }
    });

    clientSocket.on('error', () => { serverSocket.destroy(); });
    serverSocket.setTimeout(120000, () => { serverSocket.destroy(); });
  }

  // ==========================================
  // Session Creation
  // ==========================================

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
      requestBody: data.requestBody || null,
      responseBody: data.responseBody || null,
      requestSize: data.requestSize || 0,
      responseSize: data.responseSize || 0,
      duration: data.duration || 0,
      error: data.error || null,
      isTunnel: data.isTunnel || false,
      isDecrypted: data.isDecrypted || false,
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
