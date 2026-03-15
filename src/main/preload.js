const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Capture control
  startCapture: () => ipcRenderer.invoke('start-capture'),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  getCaptureStatus: () => ipcRenderer.invoke('get-capture-status'),
  clearSessions: () => ipcRenderer.invoke('clear-sessions'),

  // Sessions
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  getSession: (id) => ipcRenderer.invoke('get-session', id),

  // Save/Restore
  saveSession: () => ipcRenderer.invoke('save-session'),
  openSession: () => ipcRenderer.invoke('open-session'),

  // Export
  exportData: (format) => ipcRenderer.invoke('export-data', format),

  // Compose requests
  sendRequest: (data) => ipcRenderer.invoke('send-request', data),
  resubmitSession: (data) => ipcRenderer.invoke('resubmit-session', data),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),

  // Traffic modification rules
  getRules: () => ipcRenderer.invoke('get-rules'),
  addRule: (rule) => ipcRenderer.invoke('add-rule', rule),
  updateRule: (rule) => ipcRenderer.invoke('update-rule', rule),
  deleteRule: (ruleId) => ipcRenderer.invoke('delete-rule', ruleId),
  toggleRule: (ruleId) => ipcRenderer.invoke('toggle-rule', ruleId),

  // Highlight rules
  getHighlightRules: () => ipcRenderer.invoke('get-highlight-rules'),
  addHighlightRule: (rule) => ipcRenderer.invoke('add-highlight-rule', rule),
  deleteHighlightRule: (ruleId) => ipcRenderer.invoke('delete-highlight-rule', ruleId),

  // Events from main process
  onNewSession: (callback) => {
    ipcRenderer.on('new-session', (event, session) => callback(session));
  },
  onSessionUpdated: (callback) => {
    ipcRenderer.on('session-updated', (event, session) => callback(session));
  },
  onCaptureStatus: (callback) => {
    ipcRenderer.on('capture-status', (event, status) => callback(status));
  },
  onSessionsCleared: (callback) => {
    ipcRenderer.on('sessions-cleared', () => callback());
  },
  onSessionsLoaded: (callback) => {
    ipcRenderer.on('sessions-loaded', (event, sessions) => callback(sessions));
  },
  onThemeChanged: (callback) => {
    ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
  },
  onShowComposer: (callback) => {
    ipcRenderer.on('show-composer', () => callback());
  },
  onShowConverter: (callback) => {
    ipcRenderer.on('show-converter', () => callback());
  },
  onShowRules: (callback) => {
    ipcRenderer.on('show-rules', () => callback());
  },
  onShowCharts: (callback) => {
    ipcRenderer.on('show-charts', () => callback());
  },
  onShowSettings: (callback) => {
    ipcRenderer.on('show-settings', () => callback());
  }
});
