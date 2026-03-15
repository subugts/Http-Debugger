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
 * ProxyEngine - System-wide HTTP/HTTPS traffic sniffer
 * Configures macOS system proxy to capture ALL local traffic.
 * HTTP: Full request/response inspection (headers, body, everything)
 * HTTPS: Transparent tunnel — captures host, timing, byte counts (no SSL breakage)
 * Internet always works — no MITM, no certificate issues.
 */
class ProxyEngine {
  constructor(port = 8888) {
    this.port = port;
    this.server = null;
    this.onRequest = null;
    this.onSessionUpdate = null;
    this.isRunning = false;
    this.systemProxyEnabled = false;

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

    // State file for crash recovery (tracks if system proxy was enabled)
    this._stateFile = path.join(this._certDir, 'proxy-state.json');

    // On startup, check if previous session crashed with proxy still enabled
    this._recoverFromCrash();
  }

  /**
   * Static method to force-disable system proxy (for crash recovery from main process)
   */
  static forceDisableSystemProxy() {
    const { execSync } = require('child_process');
    const services = ['Wi-Fi', 'Ethernet', 'USB 10/100/1000 LAN'];
    for (const service of services) {
      try {
        execSync(`networksetup -setwebproxystate "${service}" off 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
        execSync(`networksetup -setsecurewebproxystate "${service}" off 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 });
      } catch (e) { /* ignore */ }
    }
    // Clean state file
    try {
      const stateFile = path.join(require('os').homedir(), '.http-debugger', 'proxy-state.json');
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch (e) { /* ignore */ }
    console.log('[ProxyEngine] Force-disabled all system proxies');
  }

  /**
   * Check if previous session crashed with proxy enabled and clean up
   */
  _recoverFromCrash() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const state = JSON.parse(fs.readFileSync(this._stateFile, 'utf-8'));
        if (state.systemProxyEnabled) {
          console.warn('[ProxyEngine] Detected previous crash with system proxy enabled. Cleaning up...');
          ProxyEngine.forceDisableSystemProxy();
        }
      }
    } catch (e) {
      // State file corrupted, just clean up
      try { fs.unlinkSync(this._stateFile); } catch (e2) { /* ignore */ }
    }
  }

  /**
   * Save current proxy state to disk for crash recovery
   */
  _saveState() {
    try {
      if (!fs.existsSync(this._certDir)) {
        fs.mkdirSync(this._certDir, { recursive: true });
      }
      fs.writeFileSync(this._stateFile, JSON.stringify({
        systemProxyEnabled: this.systemProxyEnabled,
        port: this.port,
        timestamp: Date.now()
      }));
    } catch (e) { /* ignore */ }
  }

  /**
   * Clear proxy state file
   */
  _clearState() {
    try {
      if (fs.existsSync(this._stateFile)) fs.unlinkSync(this._stateFile);
    } catch (e) { /* ignore */ }
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

    // Try to add to user login keychain (doesn't need admin)
    try {
      execSync(
        `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      console.log('[ProxyEngine] CA certificate installed in user Keychain');
      return { success: true };
    } catch (e) {
      console.warn('[ProxyEngine] User keychain install failed:', e.message);
    }

    // Fallback: just add cert to keychain (user may need to manually trust)
    try {
      execSync(
        `security add-certificates -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      console.log('[ProxyEngine] CA certificate added to user Keychain (may need manual trust)');
      return { success: true, needsManualTrust: true };
    } catch (e2) {
      return { success: false, error: 'Install CA manually: open ' + certPath + ' and trust in Keychain Access' };
    }
  }

  /** Check if our CA cert is in keychain */
  isCATrusted() {
    try {
      const output = execSync(
        `security find-certificate -c "HTTP Debugger CA" -p ~/Library/Keychains/login.keychain-db 2>/dev/null || security find-certificate -c "HTTP Debugger CA" -p /Library/Keychains/System.keychain 2>/dev/null`,
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
    // Set bypass domains so local dev tools, IDE extensions etc. aren't affected
    const bypassDomains = '*.local, localhost, 127.0.0.1, ::1, 169.254/16, *.localhost';
    
    for (const service of this._networkServices) {
      try {
        execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setwebproxystate "${service}" on`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${this.port}`, { encoding: 'utf-8' });
        execSync(`networksetup -setsecurewebproxystate "${service}" on`, { encoding: 'utf-8' });
        // Set proxy bypass domains
        try {
          execSync(`networksetup -setproxybypassdomains "${service}" ${bypassDomains}`, { encoding: 'utf-8' });
        } catch (e) { /* bypass domains are optional */ }
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
        // If restoring original settings fails, FORCE turn off proxy
        try {
          execSync(`networksetup -setwebproxystate "${service}" off 2>/dev/null || true`, { encoding: 'utf-8' });
          execSync(`networksetup -setsecurewebproxystate "${service}" off 2>/dev/null || true`, { encoding: 'utf-8' });
          console.log(`[ProxyEngine] Force-disabled proxy on: ${service}`);
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

      // Increase max listeners for MITM http servers
      this.server.setMaxListeners(0);

      this.server.listen(this.port, '0.0.0.0', () => {
        this.isRunning = true;
        console.log(`[ProxyEngine] Proxy listening on 0.0.0.0:${this.port} — MITM decryption ready`);
        console.log(`[ProxyEngine] Configure apps to use HTTP/HTTPS proxy: 127.0.0.1:${this.port}`);

        // Enable system proxy so all traffic goes through us
        try {
          this._detectNetworkServices();
          this._saveOriginalProxySettings();
          this._enableSystemProxy();
          this.systemProxyEnabled = true;
          this._saveState();
          console.log(`[ProxyEngine] System proxy ENABLED — all traffic routed through proxy`);
        } catch (e) {
          console.warn(`[ProxyEngine] Could not set system proxy: ${e.message}`);
          console.log('[ProxyEngine] Running in manual proxy mode — configure apps to use 127.0.0.1:' + this.port);
        }

        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      // CRITICAL: Always restore system proxy FIRST, before anything else
      if (this.systemProxyEnabled) {
        try {
          this._restoreSystemProxy();
          this.systemProxyEnabled = false;
          console.log('[ProxyEngine] System proxy restored.');
        } catch (e) {
          console.error('[ProxyEngine] Error restoring system proxy:', e.message);
          // Emergency fallback: force disable all proxies
          try { ProxyEngine.forceDisableSystemProxy(); } catch (e2) { /* ignore */ }
        }
      }

      // Clear crash recovery state
      this._clearState();

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
  // HTTPS CONNECT — Transparent Tunnel (no MITM = no SSL breakage)
  // ==========================================

  /**
   * Handle CONNECT requests with a transparent tunnel.
   * This forwards encrypted bytes as-is, so HTTPS works perfectly.
   * We capture: hostname, port, timing, bytes transferred.
   * The actual TLS content stays encrypted — internet never breaks.
   */
  _handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;
    const startTime = Date.now();
    const sessionId = uuidv4();

    // Emit pending session immediately so UI shows connection
    const pendingSession = this._createSession({
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
      isTunnel: true,
      isPending: true,
      isDecrypted: false,
      requestTimestamp: startTime
    });
    if (this.onRequest) { this.onRequest(pendingSession); }

    // Connect to the real target server
    const serverSocket = net.connect(targetPort, hostname, () => {
      // Tell the client the tunnel is open
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: HTTP-Debugger\r\n' +
        '\r\n'
      );

      // If there was any buffered data (head), send it
      if (head && head.length > 0) {
        serverSocket.write(head);
      }

      // Pipe data both ways — completely transparent, TLS stays intact
      let requestSize = 0;
      let responseSize = 0;
      let sessionCreated = false;

      clientSocket.on('data', (chunk) => {
        requestSize += chunk.length;
        try { serverSocket.write(chunk); } catch (e) { /* ignore */ }
      });

      serverSocket.on('data', (chunk) => {
        responseSize += chunk.length;
        try { clientSocket.write(chunk); } catch (e) { /* ignore */ }
      });

      const finishSession = () => {
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
          statusMessage: 'OK (tunnel)',
          requestHeaders: req.headers || {},
          responseHeaders: {},
          responseBody: `[HTTPS Tunnel — ${requestSize} bytes sent / ${responseSize} bytes received]`,
          requestSize,
          responseSize,
          duration: Date.now() - startTime,
          isTunnel: true,
          isDecrypted: false,
          requestTimestamp: startTime,
          isPending: false
        });
        if (this.onSessionUpdate) { this.onSessionUpdate(session); }
      };

      serverSocket.on('end', () => { finishSession(); try { clientSocket.end(); } catch (e) {} });
      serverSocket.on('close', finishSession);
      clientSocket.on('end', () => { finishSession(); try { serverSocket.end(); } catch (e) {} });
      clientSocket.on('close', finishSession);

      clientSocket.on('error', () => { finishSession(); serverSocket.destroy(); });
      serverSocket.on('error', () => { finishSession(); clientSocket.destroy(); });

      // Timeout for idle tunnels
      serverSocket.setTimeout(120000, () => { finishSession(); serverSocket.destroy(); clientSocket.destroy(); });
      clientSocket.setTimeout(120000, () => { finishSession(); clientSocket.destroy(); serverSocket.destroy(); });
    });

    serverSocket.on('error', (err) => {
      // Could not connect to target — send error to client
      try {
        clientSocket.write(
          'HTTP/1.1 502 Bad Gateway\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          `Could not connect to ${hostname}:${targetPort}: ${err.message}`
        );
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
        responseBody: `Error: ${err.message}`,
        error: err.message,
        duration: Date.now() - startTime,
        requestTimestamp: startTime,
        isPending: false,
        isDecrypted: false
      });
      if (this.onSessionUpdate) { this.onSessionUpdate(session); }
    });

    clientSocket.on('error', () => {
      try { serverSocket.destroy(); } catch (e) { /* ignore */ }
    });
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
