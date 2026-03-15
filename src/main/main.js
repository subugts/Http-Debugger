const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const ProxyEngine = require('./proxy-engine');
const TrafficModifier = require('./traffic-modifier');

let mainWindow;
let proxyEngine;
let trafficModifier;
let sessions = [];
let requestCounter = 0;
let isCapturing = false;
let highlightRules = [];

// Default settings
let settings = {
  proxyPort: 8888,
  theme: 'dark',
  autoScroll: true,
  maxSessions: 10000,
  highlightErrors: true,
  highlightSlowRequests: true,
  slowRequestThreshold: 3000,
  largeRequestThreshold: 1048576
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'HTTP Debugger',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Build menu
  const menuTemplate = buildMenu();
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (proxyEngine) proxyEngine.stop();
  });

  // Initialize proxy engine
  proxyEngine = new ProxyEngine(settings.proxyPort);
  trafficModifier = new TrafficModifier();

  setupIPC();
}

function buildMenu() {
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'Cmd+,',
          click: () => mainWindow.webContents.send('show-settings')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Save Session...',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveSession()
        },
        {
          label: 'Open Session...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openSession()
        },
        { type: 'separator' },
        {
          label: 'Export as JSON',
          click: () => exportData('json')
        },
        {
          label: 'Export as CSV',
          click: () => exportData('csv')
        },
        {
          label: 'Export as XML',
          click: () => exportData('xml')
        },
        {
          label: 'Export as TXT',
          click: () => exportData('txt')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Capture',
      submenu: [
        {
          label: 'Start Capturing',
          accelerator: 'F5',
          click: () => startCapturing()
        },
        {
          label: 'Stop Capturing',
          accelerator: 'F6',
          click: () => stopCapturing()
        },
        { type: 'separator' },
        {
          label: 'Clear All Sessions',
          accelerator: 'CmdOrCtrl+Delete',
          click: () => clearSessions()
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Compose Request',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('show-composer')
        },
        {
          label: 'Data Converter',
          accelerator: 'CmdOrCtrl+D',
          click: () => mainWindow.webContents.send('show-converter')
        },
        {
          label: 'Traffic Rules',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.webContents.send('show-rules')
        },
        { type: 'separator' },
        {
          label: 'Traffic Charts',
          click: () => mainWindow.webContents.send('show-charts')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Theme',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
            mainWindow.webContents.send('theme-changed', settings.theme);
          }
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];
}

function setupIPC() {
  // Proxy control
  ipcMain.handle('start-capture', async () => {
    return startCapturing();
  });

  ipcMain.handle('stop-capture', async () => {
    return stopCapturing();
  });

  ipcMain.handle('get-capture-status', async () => {
    return {
      isCapturing,
      port: settings.proxyPort,
      mode: 'system-wide',
      mitmEnabled: true,
      caTrusted: proxyEngine ? proxyEngine.isCATrusted() : false
    };
  });

  ipcMain.handle('clear-sessions', async () => {
    return clearSessions();
  });

  // Sessions
  ipcMain.handle('get-sessions', async () => {
    return sessions;
  });

  ipcMain.handle('get-session', async (event, id) => {
    return sessions.find(s => s.id === id) || null;
  });

  // Save/Restore
  ipcMain.handle('save-session', async () => {
    return saveSession();
  });

  ipcMain.handle('open-session', async () => {
    return openSession();
  });

  // Export
  ipcMain.handle('export-data', async (event, format) => {
    return exportData(format);
  });

  // Compose and send request
  ipcMain.handle('send-request', async (event, requestData) => {
    return sendComposedRequest(requestData);
  });

  // Resubmit session
  ipcMain.handle('resubmit-session', async (event, sessionData) => {
    return sendComposedRequest(sessionData);
  });

  // Settings
  ipcMain.handle('get-settings', async () => {
    return settings;
  });

  ipcMain.handle('update-settings', async (event, newSettings) => {
    Object.assign(settings, newSettings);
    if (proxyEngine && proxyEngine.port !== settings.proxyPort) {
      if (isCapturing) {
        await proxyEngine.stop();
        proxyEngine = new ProxyEngine(settings.proxyPort);
        await proxyEngine.start();
      }
    }
    return settings;
  });

  // Traffic modification rules
  ipcMain.handle('get-rules', async () => {
    return trafficModifier.getRules();
  });

  ipcMain.handle('add-rule', async (event, rule) => {
    return trafficModifier.addRule(rule);
  });

  ipcMain.handle('update-rule', async (event, rule) => {
    return trafficModifier.updateRule(rule);
  });

  ipcMain.handle('delete-rule', async (event, ruleId) => {
    return trafficModifier.deleteRule(ruleId);
  });

  ipcMain.handle('toggle-rule', async (event, ruleId) => {
    return trafficModifier.toggleRule(ruleId);
  });

  // Highlight rules
  ipcMain.handle('get-highlight-rules', async () => {
    return highlightRules;
  });

  ipcMain.handle('add-highlight-rule', async (event, rule) => {
    rule.id = Date.now().toString();
    highlightRules.push(rule);
    return highlightRules;
  });

  ipcMain.handle('delete-highlight-rule', async (event, ruleId) => {
    highlightRules = highlightRules.filter(r => r.id !== ruleId);
    return highlightRules;
  });

  // CA Certificate management (MITM)
  ipcMain.handle('get-ca-status', async () => {
    if (!proxyEngine) return { hasCert: false, trusted: false, path: '' };
    return {
      hasCert: !!proxyEngine.getCACertPEM(),
      trusted: proxyEngine.isCATrusted(),
      path: proxyEngine.getCACertPath()
    };
  });

  ipcMain.handle('install-ca-cert', async () => {
    if (!proxyEngine) return { success: false, error: 'Proxy not initialized' };
    return proxyEngine.installCACert();
  });

  ipcMain.handle('export-ca-cert', async () => {
    if (!proxyEngine) return { success: false, error: 'Proxy not initialized' };
    const certPEM = proxyEngine.getCACertPEM();
    if (!certPEM) return { success: false, error: 'No CA certificate' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CA Certificate',
      defaultPath: 'HTTP-Debugger-CA.pem',
      filters: [
        { name: 'PEM Certificate', extensions: ['pem'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePath) {
      require('fs').writeFileSync(result.filePath, certPEM);
      return { success: true, path: result.filePath };
    }
    return { success: false };
  });

  ipcMain.handle('reveal-ca-cert', async () => {
    if (!proxyEngine) return { success: false };
    shell.showItemInFolder(proxyEngine.getCACertPath());
    return { success: true };
  });
}

async function startCapturing() {
  if (isCapturing) return { success: true, port: settings.proxyPort, mode: 'system-wide' };

  try {
    proxyEngine.onRequest = (session) => {
      // Apply traffic modification rules
      const modifiedSession = trafficModifier.applyRules(session);
      
      requestCounter++;
      modifiedSession.number = requestCounter;
      modifiedSession.timestamp = new Date().toISOString();
      
      sessions.push(modifiedSession);
      
      // Limit sessions
      if (sessions.length > settings.maxSessions) {
        sessions = sessions.slice(-settings.maxSessions);
      }
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-session', modifiedSession);
      }
    };

    // Streaming: update pending sessions when response arrives
    proxyEngine.onSessionUpdate = (updatedSession) => {
      const modifiedSession = trafficModifier.applyRules(updatedSession);
      
      // Find and replace pending session in array
      const idx = sessions.findIndex(s => s.id === modifiedSession.id);
      if (idx !== -1) {
        modifiedSession.number = sessions[idx].number;
        modifiedSession.timestamp = sessions[idx].timestamp;
        sessions[idx] = modifiedSession;
      } else {
        // Fallback: add as new
        requestCounter++;
        modifiedSession.number = requestCounter;
        modifiedSession.timestamp = new Date().toISOString();
        sessions.push(modifiedSession);
      }
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-updated', modifiedSession);
      }
    };

    await proxyEngine.start();
    isCapturing = true;
    
    if (mainWindow) {
      mainWindow.webContents.send('capture-status', { isCapturing: true, port: settings.proxyPort, mode: 'system-wide' });
    }
    
    return { success: true, port: settings.proxyPort, mode: 'system-wide' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function stopCapturing() {
  if (!isCapturing) return { success: true };
  
  try {
    await proxyEngine.stop();
    isCapturing = false;
    
    if (mainWindow) {
      mainWindow.webContents.send('capture-status', { isCapturing: false });
    }
    
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function clearSessions() {
  sessions = [];
  requestCounter = 0;
  if (mainWindow) {
    mainWindow.webContents.send('sessions-cleared');
  }
  return { success: true };
}

async function saveSession() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Session',
    defaultPath: `http-debug-session-${new Date().toISOString().slice(0, 10)}.hds`,
    filters: [
      { name: 'HTTP Debugger Session', extensions: ['hds'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });

  if (!result.canceled && result.filePath) {
    const sessionData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      sessionCount: sessions.length,
      settings: settings,
      highlightRules: highlightRules,
      sessions: sessions
    };
    
    fs.writeFileSync(result.filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
    return { success: true, path: result.filePath };
  }
  return { success: false };
}

async function openSession() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Session',
    filters: [
      { name: 'HTTP Debugger Session', extensions: ['hds', 'json'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const data = fs.readFileSync(result.filePaths[0], 'utf-8');
      const sessionData = JSON.parse(data);
      
      sessions = sessionData.sessions || [];
      requestCounter = sessions.length;
      
      if (sessionData.highlightRules) {
        highlightRules = sessionData.highlightRules;
      }
      
      if (mainWindow) {
        mainWindow.webContents.send('sessions-loaded', sessions);
      }
      
      return { success: true, count: sessions.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false };
}

async function exportData(format) {
  const extensions = { json: 'json', csv: 'csv', xml: 'xml', txt: 'txt' };
  
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export as ${format.toUpperCase()}`,
    defaultPath: `http-sessions-${new Date().toISOString().slice(0, 10)}.${extensions[format]}`,
    filters: [
      { name: format.toUpperCase(), extensions: [extensions[format]] }
    ]
  });

  if (!result.canceled && result.filePath) {
    let content = '';
    
    switch (format) {
      case 'json':
        content = JSON.stringify(sessions, null, 2);
        break;
      case 'csv':
        content = exportCSV();
        break;
      case 'xml':
        content = exportXML();
        break;
      case 'txt':
        content = exportTXT();
        break;
    }
    
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  }
  return { success: false };
}

function exportCSV() {
  const headers = ['#', 'Method', 'URL', 'Status', 'Content-Type', 'Size', 'Time (ms)', 'Timestamp'];
  const rows = sessions.map(s => [
    s.number,
    s.method,
    `"${s.url}"`,
    s.statusCode || '',
    s.responseHeaders?.['content-type'] || '',
    s.responseSize || 0,
    s.duration || 0,
    s.timestamp
  ]);
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

function exportXML() {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<sessions>\n';
  sessions.forEach(s => {
    xml += `  <session>\n`;
    xml += `    <number>${s.number}</number>\n`;
    xml += `    <method>${s.method}</method>\n`;
    xml += `    <url><![CDATA[${s.url}]]></url>\n`;
    xml += `    <statusCode>${s.statusCode || ''}</statusCode>\n`;
    xml += `    <contentType>${s.responseHeaders?.['content-type'] || ''}</contentType>\n`;
    xml += `    <size>${s.responseSize || 0}</size>\n`;
    xml += `    <duration>${s.duration || 0}</duration>\n`;
    xml += `    <timestamp>${s.timestamp}</timestamp>\n`;
    xml += `  </session>\n`;
  });
  xml += '</sessions>';
  return xml;
}

function exportTXT() {
  return sessions.map(s => {
    return [
      `--- Request #${s.number} ---`,
      `${s.method} ${s.url}`,
      `Status: ${s.statusCode || 'Pending'}`,
      `Time: ${s.duration || 0}ms`,
      `Size: ${s.responseSize || 0} bytes`,
      `Date: ${s.timestamp}`,
      '',
      'Request Headers:',
      ...Object.entries(s.requestHeaders || {}).map(([k, v]) => `  ${k}: ${v}`),
      '',
      'Response Headers:',
      ...Object.entries(s.responseHeaders || {}).map(([k, v]) => `  ${k}: ${v}`),
      '',
      '---',
      ''
    ].join('\n');
  }).join('\n');
}

async function sendComposedRequest(requestData) {
  const http = require('http');
  const https = require('https');
  const url = require('url');
  
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(requestData.url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: requestData.method || 'GET',
        headers: requestData.headers || {},
        rejectUnauthorized: false
      };

      const startTime = Date.now();
      
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const duration = Date.now() - startTime;
          
          const session = {
            id: `composed-${Date.now()}`,
            number: ++requestCounter,
            method: options.method,
            url: requestData.url,
            protocol: isHttps ? 'HTTPS' : 'HTTP',
            host: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            requestHeaders: options.headers,
            responseHeaders: res.headers,
            requestBody: requestData.body || null,
            responseBody: body.toString('utf-8'),
            responseSize: body.length,
            duration: duration,
            timestamp: new Date().toISOString(),
            isComposed: true
          };
          
          sessions.push(session);
          if (mainWindow) {
            mainWindow.webContents.send('new-session', session);
          }
          
          resolve({ success: true, session });
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ success: false, error: 'Request timeout (30s)' });
      });

      if (requestData.body) {
        req.write(requestData.body);
      }
      req.end();
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (proxyEngine) proxyEngine.stop();
  if (process.platform !== 'darwin') app.quit();
});

// Critical: restore system proxy on any exit path
app.on('before-quit', () => {
  if (proxyEngine && proxyEngine.isRunning) {
    proxyEngine.stop();
  }
});

process.on('SIGINT', () => {
  try { ProxyEngine.forceDisableSystemProxy(); } catch (e) { /* ignore */ }
  if (proxyEngine && proxyEngine.isRunning) {
    proxyEngine.stop();
  }
  process.exit();
});

process.on('SIGTERM', () => {
  try { ProxyEngine.forceDisableSystemProxy(); } catch (e) { /* ignore */ }
  if (proxyEngine && proxyEngine.isRunning) {
    proxyEngine.stop();
  }
  process.exit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // CRITICAL: Always force-restore system proxy on crash
  try {
    ProxyEngine.forceDisableSystemProxy();
  } catch (e) { /* ignore */ }
  if (proxyEngine && proxyEngine.isRunning) {
    proxyEngine.stop();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
