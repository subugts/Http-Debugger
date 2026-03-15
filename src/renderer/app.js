/**
 * HTTP Debugger - Main Application Logic
 * Handles UI, sessions, viewers, charts, filtering, and all interactive features
 */

// ============================
// State
// ============================
let allSessions = [];
let filteredSessions = [];
let selectedSession = null;
let currentFilter = 'all';
let currentMethodFilter = 'all';
let currentSearch = '';
let currentStatusFilter = 'all'; // 'all', '2xx', '3xx', '4xx', '5xx'
let currentDomainFilter = '';
let filterMinDuration = 0;
let filterMaxDuration = Infinity;
let filterMinSize = 0;
let filterMaxSize = Infinity;
let searchIsRegex = false;
let sortColumn = 'number';
let sortDirection = 'asc';
let settings = {};
let isCapturing = false;
let currentDetailTab = 'summary';
let currentChartType = 'timing';

// Performance: Virtual scrolling state
const VIRTUAL_ROW_HEIGHT = 28;
const VIRTUAL_OVERSCAN = 15;
let virtualScrollTop = 0;
let virtualVisibleCount = 0;
let virtualContainer = null;
let virtualSpacer = null;

// Performance: Batch rendering
let pendingSessions = [];
let batchRAF = null;
const BATCH_INTERVAL = 16; // ms - near-instant rendering for live feel
let lastBatchFlush = 0;
let sessionCounter = 0; // monotonically increasing for new-row detection
let lastNewSessionIds = new Set(); // track recently added session IDs for animation

// Performance: Search debounce
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 150;

// Performance: Filter cache
let filterCacheDirty = true;
let lastFilterKey = '';

// ============================
// Initialization
// ============================
document.addEventListener('DOMContentLoaded', async () => {
  settings = await window.api.getSettings();
  applyTheme(settings.theme);
  
  setupToolbar();
  setupFilters();
  setupDetailTabs();
  setupResize();
  setupModals();
  setupComposer();
  setupConverter();
  setupCharts();
  setupRules();
  setupSettings();
  setupResubmit();
  setupContextMenu();
  setupKeyboardShortcuts();
  
  // IPC listeners
  window.api.onNewSession(handleNewSession);
  window.api.onCaptureStatus(handleCaptureStatus);
  window.api.onSessionsCleared(handleSessionsCleared);
  window.api.onSessionsLoaded(handleSessionsLoaded);
  window.api.onThemeChanged(applyTheme);
  window.api.onShowComposer(() => showModal('modal-composer'));
  window.api.onShowConverter(() => showModal('modal-converter'));
  window.api.onShowRules(() => showModal('modal-rules'));
  window.api.onShowCharts(() => showModal('modal-charts'));
  window.api.onShowSettings(() => showModal('modal-settings'));

  // Load existing sessions
  const existing = await window.api.getSessions();
  if (existing && existing.length > 0) {
    allSessions = existing;
    applyFilters();
  }

  const status = await window.api.getCaptureStatus();
  handleCaptureStatus(status);
});

// ============================
// Theme
// ============================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ============================
// Toolbar
// ============================
function setupToolbar() {
  document.getElementById('btn-capture').addEventListener('click', startCapture);
  document.getElementById('btn-stop').addEventListener('click', stopCapture);
  document.getElementById('btn-clear').addEventListener('click', clearAll);
  document.getElementById('btn-compose').addEventListener('click', () => showModal('modal-composer'));
  document.getElementById('btn-resubmit').addEventListener('click', openResubmit);
  document.getElementById('btn-charts').addEventListener('click', () => {
    showModal('modal-charts');
    renderChart(currentChartType);
  });
  document.getElementById('btn-converter').addEventListener('click', () => showModal('modal-converter'));
  document.getElementById('btn-rules').addEventListener('click', () => showModal('modal-rules'));
  document.getElementById('btn-save').addEventListener('click', () => window.api.saveSession());
  document.getElementById('btn-open').addEventListener('click', () => window.api.openSession());
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Export dropdown
  const exportBtn = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('show');
  });
  
  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      window.api.exportData(item.dataset.format);
      exportMenu.classList.remove('show');
    });
  });

  document.addEventListener('click', () => {
    exportMenu.classList.remove('show');
  });

  // Search with debounce
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput.addEventListener('input', () => {
    const val = searchInput.value.trim();
    searchClear.classList.toggle('visible', val.length > 0);
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentSearch = val;
      filterCacheDirty = true;
      applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    searchClear.classList.remove('visible');
    filterCacheDirty = true;
    applyFilters();
  });

  // Regex toggle
  const regexToggle = document.getElementById('search-regex-toggle');
  if (regexToggle) {
    regexToggle.addEventListener('click', () => {
      searchIsRegex = !searchIsRegex;
      regexToggle.classList.toggle('active', searchIsRegex);
      if (currentSearch) {
        filterCacheDirty = true;
        applyFilters();
      }
    });
  }

  // Advanced filter: status code range
  document.querySelectorAll('.status-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.status-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentStatusFilter = chip.dataset.status;
      filterCacheDirty = true;
      applyFilters();
    });
  });

  // Advanced filter: duration range
  const durationMin = document.getElementById('filter-duration-min');
  const durationMax = document.getElementById('filter-duration-max');
  if (durationMin) {
    durationMin.addEventListener('change', () => {
      filterMinDuration = parseInt(durationMin.value) || 0;
      filterCacheDirty = true;
      applyFilters();
    });
  }
  if (durationMax) {
    durationMax.addEventListener('change', () => {
      filterMaxDuration = parseInt(durationMax.value) || Infinity;
      filterCacheDirty = true;
      applyFilters();
    });
  }

  // Advanced filter: size range
  const sizeMin = document.getElementById('filter-size-min');
  const sizeMax = document.getElementById('filter-size-max');
  if (sizeMin) {
    sizeMin.addEventListener('change', () => {
      filterMinSize = parseSizeInput(sizeMin.value);
      filterCacheDirty = true;
      applyFilters();
    });
  }
  if (sizeMax) {
    sizeMax.addEventListener('change', () => {
      filterMaxSize = parseSizeInput(sizeMax.value) || Infinity;
      filterCacheDirty = true;
      applyFilters();
    });
  }

  // Advanced filter: domain quick-filter
  const domainFilter = document.getElementById('filter-domain');
  if (domainFilter) {
    domainFilter.addEventListener('input', () => {
      clearTimeout(domainFilter._debounce);
      domainFilter._debounce = setTimeout(() => {
        currentDomainFilter = domainFilter.value.trim().toLowerCase();
        filterCacheDirty = true;
        applyFilters();
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  // Advanced filter panel toggle
  const advToggle = document.getElementById('btn-advanced-filter');
  if (advToggle) {
    advToggle.addEventListener('click', () => {
      const panel = document.getElementById('advanced-filter-panel');
      panel.classList.toggle('hidden');
      advToggle.classList.toggle('active');
    });
  }

  // Clear all filters button
  const clearFiltersBtn = document.getElementById('btn-clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', clearAllFilters);
  }

  // Column sorting
  document.querySelectorAll('.th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortColumn === col) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = col;
        sortDirection = 'asc';
      }
      document.querySelectorAll('.th').forEach(t => t.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
      filterCacheDirty = true;
      applyFilters();
    });
  });
}

// ============================
// Capture Control
// ============================
async function startCapture() {
  const result = await window.api.startCapture();
  if (!result.success) {
    alert(`Failed to start capture: ${result.error}`);
  }
}

async function stopCapture() {
  await window.api.stopCapture();
}

async function clearAll() {
  await window.api.clearSessions();
}

function handleCaptureStatus(status) {
  isCapturing = status.isCapturing;
  const captureBtn = document.getElementById('btn-capture');
  const stopBtn = document.getElementById('btn-stop');
  const statusEl = document.getElementById('capture-status');
  const sbStatus = document.getElementById('sb-status');
  const sbProxy = document.getElementById('sb-proxy');

  if (isCapturing) {
    captureBtn.disabled = true;
    captureBtn.classList.remove('primary');
    stopBtn.disabled = false;
    statusEl.innerHTML = '<span class="status-dot running pulse"></span><span class="status-text">🌐 Capturing ALL local traffic</span>';
    sbStatus.textContent = '⚡ Live Capturing...';
    sbStatus.classList.add('live-status');
    sbProxy.textContent = '🌐 System-wide Capture Active';
  } else {
    captureBtn.disabled = false;
    captureBtn.classList.add('primary');
    stopBtn.disabled = true;
    statusEl.innerHTML = '<span class="status-dot stopped"></span><span class="status-text">Stopped</span>';
    sbStatus.textContent = 'Ready';
    sbStatus.classList.remove('live-status');
    sbProxy.textContent = '🌐 System-wide Capture';
  }
}

// ============================
// Session Handling (Batched for Performance)
// ============================
function handleNewSession(session) {
  allSessions.push(session);
  pendingSessions.push(session);

  // Update live counter in status bar immediately
  const sbReq = document.getElementById('sb-requests');
  if (sbReq) sbReq.textContent = `Requests: ${allSessions.length}`;

  // Batch rendering with requestAnimationFrame — near-instant
  if (!batchRAF) {
    batchRAF = requestAnimationFrame(flushPendingSessions);
  }
}

function flushPendingSessions() {
  batchRAF = null;
  if (pendingSessions.length === 0) return;

  const now = performance.now();
  // Throttle: adaptive interval — fast for small batches, slightly throttled for large
  const adaptiveInterval = pendingSessions.length > 100 ? 50 : BATCH_INTERVAL;
  if (now - lastBatchFlush < adaptiveInterval && pendingSessions.length < 20) {
    batchRAF = requestAnimationFrame(flushPendingSessions);
    return;
  }
  lastBatchFlush = now;

  // Track new session IDs for highlight animation
  lastNewSessionIds = new Set(pendingSessions.map(s => s.id));

  pendingSessions = [];
  filterCacheDirty = true;
  applyFilters();
  updateStats();

  // Auto-scroll with smooth behavior
  if (settings.autoScroll && virtualContainer) {
    virtualContainer.scrollTop = virtualContainer.scrollHeight;
  }

  // Clear new-row highlights after animation completes
  setTimeout(() => {
    lastNewSessionIds.clear();
  }, 800);
}

function handleSessionsCleared() {
  allSessions = [];
  filteredSessions = [];
  pendingSessions = [];
  selectedSession = null;
  filterCacheDirty = true;
  lastVirtualStart = -1;
  lastVirtualEnd = -1;
  renderRequestList();
  renderDetail();
  updateStats();
  document.getElementById('empty-state').classList.remove('hidden');
}

function handleSessionsLoaded(sessions) {
  allSessions = sessions;
  filterCacheDirty = true;
  applyFilters();
  updateStats();
}

// ============================
// Filtering & Sorting
// ============================
function setupFilters() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      filterCacheDirty = true;
      applyFilters();
    });
  });

  document.querySelectorAll('.method-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.method-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentMethodFilter = chip.dataset.method;
      filterCacheDirty = true;
      applyFilters();
    });
  });
}

/** Check if a single session matches all active filters */
function sessionMatchesFilters(session) {
  // Content type filter
  if (currentFilter !== 'all' && session.contentType !== currentFilter) {
    if (currentFilter === 'xhr') {
      if (!['json', 'xml', 'text'].includes(session.contentType)) return false;
    } else {
      return false;
    }
  }

  // Method filter
  if (currentMethodFilter !== 'all' && session.method !== currentMethodFilter) return false;

  // Status code range filter
  if (currentStatusFilter !== 'all') {
    const code = session.statusCode || 0;
    switch (currentStatusFilter) {
      case '2xx': if (code < 200 || code >= 300) return false; break;
      case '3xx': if (code < 300 || code >= 400) return false; break;
      case '4xx': if (code < 400 || code >= 500) return false; break;
      case '5xx': if (code < 500 || code >= 600) return false; break;
      case 'err': if (code < 400) return false; break;
    }
  }

  // Duration range filter
  if (filterMinDuration > 0 && (session.duration || 0) < filterMinDuration) return false;
  if (filterMaxDuration < Infinity && (session.duration || 0) > filterMaxDuration) return false;

  // Size range filter
  if (filterMinSize > 0 && (session.responseSize || 0) < filterMinSize) return false;
  if (filterMaxSize < Infinity && (session.responseSize || 0) > filterMaxSize) return false;

  // Domain filter
  if (currentDomainFilter && session.host) {
    if (!session.host.toLowerCase().includes(currentDomainFilter)) return false;
  } else if (currentDomainFilter) {
    return false;
  }

  // Search filter (text or regex)
  if (currentSearch) {
    if (searchIsRegex) {
      try {
        const re = new RegExp(currentSearch, 'i');
        const matchFields = [session.url, session.host, session.path, session.method,
          session.statusCode?.toString(), session.contentType, session.mimeType];
        if (!matchFields.some(f => f && re.test(f))) return false;
      } catch (e) {
        // Invalid regex, treat as literal
        return sessionMatchesTextSearch(session);
      }
    } else {
      if (!sessionMatchesTextSearch(session)) return false;
    }
  }

  return true;
}

function sessionMatchesTextSearch(session) {
  const searchLower = currentSearch.toLowerCase();
  const matchFields = [session.url, session.host, session.path, session.method,
    session.statusCode?.toString(), session.contentType, session.mimeType];
  return matchFields.some(f => f && f.toLowerCase().includes(searchLower));
}

function parseSizeInput(val) {
  if (!val) return 0;
  val = val.toString().trim().toLowerCase();
  if (val.endsWith('kb')) return parseFloat(val) * 1024;
  if (val.endsWith('mb')) return parseFloat(val) * 1024 * 1024;
  if (val.endsWith('gb')) return parseFloat(val) * 1024 * 1024 * 1024;
  return parseInt(val) || 0;
}

function clearAllFilters() {
  currentFilter = 'all';
  currentMethodFilter = 'all';
  currentStatusFilter = 'all';
  currentDomainFilter = '';
  currentSearch = '';
  filterMinDuration = 0;
  filterMaxDuration = Infinity;
  filterMinSize = 0;
  filterMaxSize = Infinity;
  searchIsRegex = false;

  // Reset UI
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.filter-chip[data-filter="all"]')?.classList.add('active');
  document.querySelectorAll('.method-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.method-chip[data-method="all"]')?.classList.add('active');
  document.querySelectorAll('.status-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.status-chip[data-status="all"]')?.classList.add('active');
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  document.getElementById('search-clear')?.classList.remove('visible');
  document.getElementById('search-regex-toggle')?.classList.remove('active');
  const df = document.getElementById('filter-domain');
  if (df) df.value = '';
  const dmin = document.getElementById('filter-duration-min');
  if (dmin) dmin.value = '';
  const dmax = document.getElementById('filter-duration-max');
  if (dmax) dmax.value = '';
  const smin = document.getElementById('filter-size-min');
  if (smin) smin.value = '';
  const smax = document.getElementById('filter-size-max');
  if (smax) smax.value = '';

  filterCacheDirty = true;
  applyFilters();
}

function getFilterKey() {
  return `${currentFilter}|${currentMethodFilter}|${currentStatusFilter}|${currentSearch}|${searchIsRegex}|${currentDomainFilter}|${filterMinDuration}|${filterMaxDuration}|${filterMinSize}|${filterMaxSize}|${allSessions.length}`;
}

function applyFilters() {
  const key = getFilterKey();
  // Skip redundant re-filtering
  if (!filterCacheDirty && key === lastFilterKey) {
    return;
  }
  lastFilterKey = key;
  filterCacheDirty = false;

  filteredSessions = allSessions.filter(sessionMatchesFilters);

  // Sort
  filteredSessions.sort((a, b) => {
    let aVal = a[sortColumn];
    let bVal = b[sortColumn];
    if (aVal == null) aVal = '';
    if (bVal == null) bVal = '';
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  renderRequestList();
  updateActiveFilterCount();
}

function updateActiveFilterCount() {
  let count = 0;
  if (currentFilter !== 'all') count++;
  if (currentMethodFilter !== 'all') count++;
  if (currentStatusFilter !== 'all') count++;
  if (currentDomainFilter) count++;
  if (currentSearch) count++;
  if (filterMinDuration > 0) count++;
  if (filterMaxDuration < Infinity) count++;
  if (filterMinSize > 0) count++;
  if (filterMaxSize < Infinity) count++;

  const badge = document.getElementById('active-filter-count');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
  const clearBtn = document.getElementById('btn-clear-filters');
  if (clearBtn) clearBtn.classList.toggle('hidden', count === 0);
}

// ============================
// Request List Rendering (Virtual Scrolling)
// ============================
function renderRequestList() {
  const list = document.getElementById('request-list');
  const emptyState = document.getElementById('empty-state');

  if (filteredSessions.length === 0) {
    const rows = list.querySelectorAll('.request-row');
    rows.forEach(r => r.remove());
    if (virtualSpacer) virtualSpacer.style.height = '0px';
    emptyState.classList.remove('hidden');
    updateStats();
    return;
  }

  emptyState.classList.add('hidden');

  // Initialize virtual scroll container if needed
  if (!virtualContainer) {
    virtualContainer = list;
    virtualSpacer = document.createElement('div');
    virtualSpacer.className = 'virtual-spacer';
    virtualSpacer.style.cssText = 'width:100%;pointer-events:none;flex-shrink:0;';
    list.appendChild(virtualSpacer);

    list.addEventListener('scroll', onVirtualScroll, { passive: true });
    // Recalc visible count on resize
    new ResizeObserver(() => {
      virtualVisibleCount = Math.ceil(list.clientHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
      renderVirtualRows();
    }).observe(list);
  }

  virtualVisibleCount = Math.ceil(list.clientHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
  virtualSpacer.style.height = (filteredSessions.length * VIRTUAL_ROW_HEIGHT) + 'px';
  renderVirtualRows();
  updateStats();
}

let lastVirtualStart = -1;
let lastVirtualEnd = -1;

function onVirtualScroll() {
  renderVirtualRows();
}

function renderVirtualRows() {
  if (!virtualContainer) return;

  const scrollTop = virtualContainer.scrollTop;
  const startIndex = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const endIndex = Math.min(filteredSessions.length, startIndex + virtualVisibleCount + VIRTUAL_OVERSCAN);

  // Skip if same range
  if (startIndex === lastVirtualStart && endIndex === lastVirtualEnd) return;
  lastVirtualStart = startIndex;
  lastVirtualEnd = endIndex;

  // Remove existing rows
  const existing = virtualContainer.querySelectorAll('.request-row');
  existing.forEach(r => r.remove());

  const fragment = document.createDocumentFragment();

  // Top spacer (pushes visible rows into correct position)
  const topPad = document.createElement('div');
  topPad.className = 'request-row virtual-pad';
  topPad.style.cssText = `height:${startIndex * VIRTUAL_ROW_HEIGHT}px;padding:0;border:0;pointer-events:none;display:block;`;
  fragment.appendChild(topPad);

  for (let i = startIndex; i < endIndex; i++) {
    const session = filteredSessions[i];
    if (!session) continue;
    const row = createRequestRow(session);
    row.style.height = VIRTUAL_ROW_HEIGHT + 'px';
    fragment.appendChild(row);
  }

  // Insert before the spacer
  if (virtualSpacer && virtualSpacer.parentNode === virtualContainer) {
    virtualContainer.insertBefore(fragment, virtualSpacer);
  } else {
    virtualContainer.appendChild(fragment);
  }
}

function createRequestRow(session) {
  const row = document.createElement('div');
  row.className = 'request-row';
  row.dataset.id = session.id;

  // New row animation
  if (lastNewSessionIds.has(session.id)) {
    row.classList.add('new-row');
  }

  // Highlight classes
  if (settings.highlightErrors && session.statusCode >= 400) {
    row.classList.add('error-row');
  }
  if (settings.highlightSlowRequests && session.duration > settings.slowRequestThreshold) {
    row.classList.add('slow-row');
  }
  if (session.responseSize > settings.largeRequestThreshold) {
    row.classList.add('large-row');
  }

  if (selectedSession && selectedSession.id === session.id) {
    row.classList.add('selected');
  }

  const statusClass = getStatusClass(session.statusCode);
  const methodClass = `method-${session.method}`;

  row.innerHTML = `
    <div class="td td-number">${session.number || ''}</div>
    <div class="td td-status ${statusClass}">${session.statusCode || '—'}</div>
    <div class="td td-method ${methodClass}">${session.method}</div>
    <div class="td td-protocol">${session.protocol || 'HTTP'}</div>
    <div class="td td-host" title="${escapeHtml(session.host || '')}">${escapeHtml(session.host || '')}</div>
    <div class="td td-path" title="${escapeHtml(session.path || session.url || '')}">${escapeHtml(session.path || session.url || '')}</div>
    <div class="td td-type">${session.contentType || ''}</div>
    <div class="td td-size">${formatBytes(session.responseSize)}</div>
    <div class="td td-time">${formatDuration(session.duration)}</div>
  `;

  row.addEventListener('click', () => selectSession(session, row));
  row.addEventListener('dblclick', () => openResubmitForSession(session));
  row.addEventListener('contextmenu', (e) => showContextMenu(e, session));

  return row;
}

function selectSession(session, row) {
  selectedSession = session;
  
  document.querySelectorAll('.request-row.selected').forEach(r => r.classList.remove('selected'));
  if (row) row.classList.add('selected');

  document.getElementById('btn-resubmit').disabled = false;
  renderDetail();
}

// ============================
// Detail Views
// ============================
function setupDetailTabs() {
  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentDetailTab = tab.dataset.tab;
      renderDetail();
    });
  });
}

function renderDetail() {
  const content = document.getElementById('detail-content');
  
  if (!selectedSession) {
    content.innerHTML = '<div class="detail-empty"><p>Select a request to view details</p></div>';
    return;
  }

  switch (currentDetailTab) {
    case 'summary':
      content.innerHTML = renderSummary(selectedSession);
      break;
    case 'request-headers':
      content.innerHTML = renderHeaders(selectedSession.requestHeaders, 'Request');
      break;
    case 'response-headers':
      content.innerHTML = renderHeaders(selectedSession.responseHeaders, 'Response');
      break;
    case 'request-body':
      content.innerHTML = renderBody(selectedSession.requestBody, selectedSession.requestHeaders?.['content-type']);
      break;
    case 'response-body':
      content.innerHTML = renderBody(selectedSession.responseBody, selectedSession.responseHeaders?.['content-type']);
      break;
    case 'preview':
      content.innerHTML = renderPreview(selectedSession);
      setupPreviewFrame(selectedSession);
      break;
    case 'cookies':
      content.innerHTML = renderCookies(selectedSession);
      break;
    case 'params':
      content.innerHTML = renderParams(selectedSession);
      break;
    case 'timing':
      content.innerHTML = renderTiming(selectedSession);
      break;
  }
}

function renderSummary(session) {
  let html = '';

  // === General Info Section ===
  html += '<div class="summary-section">';
  html += '<div class="summary-section-title">📋 General</div>';
  html += '<div class="summary-grid">';
  html += summaryRow('URL', `<span class="summary-url">${escapeHtml(session.url)}</span>`);
  html += summaryRow('Method', `<span class="method-${session.method}">${session.method}</span>`);
  html += summaryRow('Status', `<span class="${getStatusClass(session.statusCode)} summary-value status">${session.statusCode || '—'} ${session.statusMessage || ''}</span>`);
  html += summaryRow('Protocol', session.protocol || 'HTTP');
  html += summaryRow('Host', session.host);
  html += summaryRow('Path', session.path);
  html += summaryRow('Timestamp', session.timestamp ? new Date(session.timestamp).toLocaleString() : '—');
  if (session.isTunnel) {
    html += summaryRow('Type', '<span class="badge badge-tunnel">🔒 HTTPS Tunnel</span>');
  }
  if (session.isComposed) {
    html += summaryRow('Source', '<span class="badge badge-info">✍ Composed</span>');
  }
  if (session.error) {
    html += summaryRow('Error', `<span class="text-error">⚠ ${escapeHtml(session.error)}</span>`);
  }
  html += '</div></div>';

  // === Request (Outgoing →) Section ===
  html += '<div class="summary-section">';
  html += '<div class="summary-section-title"><span class="direction-out">→ Outgoing Request</span></div>';
  html += '<div class="summary-grid">';
  html += summaryRow('Request Size', formatBytes(session.requestSize));
  
  const reqCt = session.requestHeaders?.['content-type'];
  html += summaryRow('Content-Type', reqCt ? escapeHtml(reqCt) : '<span class="text-muted">—</span>');
  
  const reqEncoding = session.requestHeaders?.['content-encoding'];
  html += summaryRow('Encoding', reqEncoding ? escapeHtml(reqEncoding) : '<span class="text-muted">none</span>');
  
  const userAgent = session.requestHeaders?.['user-agent'];
  if (userAgent) {
    html += summaryRow('User-Agent', `<span class="summary-truncate" title="${escapeHtml(userAgent)}">${escapeHtml(userAgent)}</span>`);
  }
  
  const accept = session.requestHeaders?.['accept'];
  if (accept) {
    html += summaryRow('Accept', `<span class="summary-truncate" title="${escapeHtml(accept)}">${escapeHtml(accept)}</span>`);
  }

  const referer = session.requestHeaders?.['referer'] || session.requestHeaders?.['referrer'];
  if (referer) {
    html += summaryRow('Referer', escapeHtml(referer));
  }

  const origin = session.requestHeaders?.['origin'];
  if (origin) {
    html += summaryRow('Origin', escapeHtml(origin));
  }

  const authorization = session.requestHeaders?.['authorization'];
  if (authorization) {
    const authType = authorization.split(' ')[0];
    html += summaryRow('Authorization', `<span class="badge badge-info">${escapeHtml(authType)}</span> ****`);
  }

  // Request body info
  if (session.requestBody) {
    const bodyLen = session.requestBody.length;
    const bodyPreview = session.requestBody.substring(0, 100);
    html += summaryRow('Body', `<span class="text-muted">${bodyLen} chars</span> <code class="summary-code-preview">${escapeHtml(bodyPreview)}${bodyLen > 100 ? '...' : ''}</code>`);
  }

  // Query parameters inline
  try {
    const urlObj = new URL(session.url);
    if (urlObj.searchParams.toString()) {
      let paramsHtml = '<div class="summary-params">';
      urlObj.searchParams.forEach((val, key) => {
        paramsHtml += `<span class="param-chip"><strong>${escapeHtml(key)}</strong>=${escapeHtml(val)}</span>`;
      });
      paramsHtml += '</div>';
      html += summaryRow('Query Params', paramsHtml);
    }
  } catch (e) {}

  html += '</div></div>';

  // === Response (Incoming ←) Section ===
  html += '<div class="summary-section">';
  html += '<div class="summary-section-title"><span class="direction-in">← Incoming Response</span></div>';
  html += '<div class="summary-grid">';
  html += summaryRow('Status', `<span class="${getStatusClass(session.statusCode)}">${session.statusCode || '—'} ${session.statusMessage || ''}</span>`);
  html += summaryRow('Response Size', formatBytes(session.responseSize));
  html += summaryRow('Content-Type', session.mimeType ? escapeHtml(session.mimeType) : '<span class="text-muted">—</span>');
  
  const resEncoding = session.responseHeaders?.['content-encoding'];
  if (resEncoding) {
    html += summaryRow('Encoding', `<span class="badge badge-info">${escapeHtml(resEncoding)}</span>`);
  }

  const transferEncoding = session.responseHeaders?.['transfer-encoding'];
  if (transferEncoding) {
    html += summaryRow('Transfer-Encoding', escapeHtml(transferEncoding));
  }

  const contentLength = session.responseHeaders?.['content-length'];
  if (contentLength) {
    html += summaryRow('Content-Length', `${formatBytes(parseInt(contentLength))} (${contentLength} bytes)`);
  }

  // Cache headers
  const cacheControl = session.responseHeaders?.['cache-control'];
  const expires = session.responseHeaders?.['expires'];
  const etag = session.responseHeaders?.['etag'];
  const lastModified = session.responseHeaders?.['last-modified'];
  const age = session.responseHeaders?.['age'];

  if (cacheControl || expires || etag) {
    html += '<tr><td colspan="2" class="summary-subsection">Cache Info</td></tr>';
    if (cacheControl) {
      const isNoCache = cacheControl.includes('no-cache') || cacheControl.includes('no-store');
      html += summaryRow('Cache-Control', `<span class="${isNoCache ? 'text-warning' : 'text-success'}">${escapeHtml(cacheControl)}</span>`);
    }
    if (expires) html += summaryRow('Expires', escapeHtml(expires));
    if (etag) html += summaryRow('ETag', `<code>${escapeHtml(etag)}</code>`);
    if (lastModified) html += summaryRow('Last-Modified', escapeHtml(lastModified));
    if (age) html += summaryRow('Age', `${age} seconds`);
  }

  // Security headers
  const csp = session.responseHeaders?.['content-security-policy'];
  const cors = session.responseHeaders?.['access-control-allow-origin'];
  const hsts = session.responseHeaders?.['strict-transport-security'];
  const xFrame = session.responseHeaders?.['x-frame-options'];
  const xContent = session.responseHeaders?.['x-content-type-options'];

  if (cors || hsts || xFrame || csp) {
    html += '<tr><td colspan="2" class="summary-subsection">Security</td></tr>';
    if (cors) html += summaryRow('CORS', `<span class="badge badge-info">${escapeHtml(cors)}</span>`);
    if (hsts) html += summaryRow('HSTS', '<span class="badge badge-success">Enabled</span>');
    if (xFrame) html += summaryRow('X-Frame-Options', escapeHtml(xFrame));
    if (xContent) html += summaryRow('X-Content-Type', escapeHtml(xContent));
  }

  // Server info
  const server = session.responseHeaders?.['server'];
  const poweredBy = session.responseHeaders?.['x-powered-by'];
  if (server || poweredBy) {
    if (server) html += summaryRow('Server', escapeHtml(server));
    if (poweredBy) html += summaryRow('Powered By', escapeHtml(poweredBy));
  }

  // Redirect info
  const location = session.responseHeaders?.['location'];
  if (location) {
    html += summaryRow('Redirect To', `<a class="summary-link">${escapeHtml(location)}</a>`);
  }
  if (session.isRedirected) {
    html += summaryRow('Redirected From', escapeHtml(session.originalUrl || '—'));
  }
  if (session.isBlocked) {
    html += summaryRow('Blocked', '<span class="badge badge-error">🚫 Blocked by Rule</span>');
  }

  // Set-Cookie count
  const setCookie = session.responseHeaders?.['set-cookie'];
  if (setCookie) {
    const cookieCount = Array.isArray(setCookie) ? setCookie.length : 1;
    html += summaryRow('Cookies Set', `<span class="badge badge-info">${cookieCount} cookie${cookieCount > 1 ? 's' : ''}</span>`);
  }

  html += '</div></div>';

  // === Timing Section ===
  html += '<div class="summary-section">';
  html += '<div class="summary-section-title">⏱ Timing</div>';
  html += '<div class="summary-grid">';
  html += summaryRow('Total Duration', `<strong>${formatDuration(session.duration)}</strong>`);
  if (session.requestTimestamp) {
    html += summaryRow('Request Sent', new Date(session.requestTimestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 }));
  }
  if (session.responseTimestamp) {
    html += summaryRow('Response Received', new Date(session.responseTimestamp).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 }));
  }

  // Visual duration bar
  if (session.duration) {
    const durationColor = session.duration < 200 ? 'var(--status-success)' : session.duration < 1000 ? 'var(--text-accent)' : session.duration < 3000 ? 'var(--status-warning)' : 'var(--status-error)';
    const barPct = Math.min(100, (session.duration / 5000) * 100);
    html += `<div class="summary-label">Speed:</div><div class="summary-value">
      <div class="summary-duration-bar"><div class="summary-duration-fill" style="width:${barPct}%;background:${durationColor}"></div></div>
      <span class="summary-duration-label">${session.duration < 200 ? 'Fast' : session.duration < 1000 ? 'Normal' : session.duration < 3000 ? 'Slow' : 'Very Slow'}</span>
    </div>`;
  }
  html += '</div></div>';

  return html;
}

function summaryRow(label, value) {
  return `<div class="summary-label">${label}:</div><div class="summary-value">${value}</div>`;
}

function renderHeaders(headers, type) {
  if (!headers || Object.keys(headers).length === 0) {
    return `<div class="detail-empty"><p>No ${type} headers</p></div>`;
  }

  let html = '<table class="headers-table">';
  for (const [key, value] of Object.entries(headers)) {
    const displayValue = Array.isArray(value) ? value.join(', ') : value;
    html += `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(String(displayValue))}</td></tr>`;
  }
  html += '</table>';
  return html;
}

function renderBody(body, contentType) {
  if (!body) {
    return '<div class="detail-empty"><p>No body content</p></div>';
  }

  const ct = (contentType || '').toLowerCase();
  
  // JSON viewer
  if (ct.includes('json') || looksLikeJSON(body)) {
    try {
      const parsed = JSON.parse(body);
      return `<div class="code-view">${syntaxHighlightJSON(JSON.stringify(parsed, null, 2))}</div>`;
    } catch (e) {
      // Not valid JSON, show as text
    }
  }

  // XML viewer
  if (ct.includes('xml') || body.trim().startsWith('<?xml') || body.trim().startsWith('<')) {
    if (body.trim().startsWith('<')) {
      return `<div class="code-view">${syntaxHighlightXML(body)}</div>`;
    }
  }

  // HTML viewer
  if (ct.includes('html')) {
    return `<div class="code-view">${syntaxHighlightHTML(body)}</div>`;
  }

  // Default text view
  return `<div class="code-view">${escapeHtml(body)}</div>`;
}

function renderPreview(session) {
  const ct = (session.responseHeaders?.['content-type'] || session.mimeType || '').toLowerCase();
  const body = session.responseBody;

  // HTTPS tunnel — no content
  if (session.isTunnel) {
    return `<div class="detail-empty">
      <div class="preview-no-content">
        <svg viewBox="0 0 24 24" width="48" height="48" style="opacity:0.3;margin-bottom:12px;">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" fill="none" stroke-width="2"/>
        </svg>
        <p>HTTPS Tunnel — Encrypted content not available</p>
        <p class="preview-hint">HTTPS tunnel connections cannot be previewed without MITM decryption</p>
      </div>
    </div>`;
  }

  if (!body) {
    return `<div class="detail-empty"><p>No response body to preview</p></div>`;
  }

  // Image preview
  if (ct.includes('image/')) {
    const mimeType = ct.split(';')[0].trim();
    return `<div class="preview-container preview-image-container">
      <div class="preview-toolbar">
        <span class="preview-badge">🖼 Image Preview</span>
        <span class="preview-meta">${mimeType} — ${formatBytes(session.responseSize)}</span>
      </div>
      <div class="preview-image-wrapper">
        <img id="preview-image" class="preview-image" alt="Response image preview" />
      </div>
    </div>`;
  }

  // HTML preview in sandboxed iframe
  if (ct.includes('html') || (body && (body.trim().startsWith('<!DOCTYPE') || body.trim().startsWith('<html')))) {
    return `<div class="preview-container preview-html-container">
      <div class="preview-toolbar">
        <span class="preview-badge">🌐 HTML Preview</span>
        <span class="preview-meta">${formatBytes(session.responseSize)}</span>
        <div class="preview-actions">
          <button class="preview-btn" id="preview-toggle-source" title="Toggle Source">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke="currentColor" fill="none" stroke-width="2"/></svg>
            Source
          </button>
        </div>
      </div>
      <iframe id="preview-iframe" class="preview-iframe" sandbox="allow-same-origin" title="HTML Preview"></iframe>
      <div id="preview-source" class="preview-source hidden">
        <div class="code-view">${syntaxHighlightHTML(body)}</div>
      </div>
    </div>`;
  }

  // JSON preview (formatted)
  if (ct.includes('json') || looksLikeJSON(body)) {
    try {
      const parsed = JSON.parse(body);
      const pretty = JSON.stringify(parsed, null, 2);
      return `<div class="preview-container">
        <div class="preview-toolbar">
          <span class="preview-badge">📋 JSON Preview</span>
          <span class="preview-meta">${formatBytes(session.responseSize)} — ${Object.keys(parsed).length} top-level keys</span>
          <div class="preview-actions">
            <button class="preview-btn" onclick="navigator.clipboard.writeText(${escapeHtml(JSON.stringify(pretty))})">Copy</button>
          </div>
        </div>
        <div class="code-view json-preview">${syntaxHighlightJSON(pretty)}</div>
      </div>`;
    } catch (e) {
      // fall through
    }
  }

  // XML preview
  if (ct.includes('xml') || body.trim().startsWith('<?xml')) {
    return `<div class="preview-container">
      <div class="preview-toolbar">
        <span class="preview-badge">📄 XML Preview</span>
        <span class="preview-meta">${formatBytes(session.responseSize)}</span>
      </div>
      <div class="code-view xml-preview">${syntaxHighlightXML(body)}</div>
    </div>`;
  }

  // CSS preview
  if (ct.includes('css')) {
    return `<div class="preview-container">
      <div class="preview-toolbar">
        <span class="preview-badge">🎨 CSS Preview</span>
        <span class="preview-meta">${formatBytes(session.responseSize)}</span>
      </div>
      <div class="code-view">${escapeHtml(body)}</div>
    </div>`;
  }

  // JavaScript preview
  if (ct.includes('javascript') || ct.includes('ecmascript')) {
    return `<div class="preview-container">
      <div class="preview-toolbar">
        <span class="preview-badge">⚡ JavaScript Preview</span>
        <span class="preview-meta">${formatBytes(session.responseSize)}</span>
      </div>
      <div class="code-view">${escapeHtml(body)}</div>
    </div>`;
  }

  // Plain text fallback
  return `<div class="preview-container">
    <div class="preview-toolbar">
      <span class="preview-badge">📝 Text Preview</span>
      <span class="preview-meta">${formatBytes(session.responseSize)}</span>
    </div>
    <div class="code-view">${escapeHtml(body)}</div>
  </div>`;
}

function setupPreviewFrame(session) {
  const ct = (session.responseHeaders?.['content-type'] || session.mimeType || '').toLowerCase();
  const body = session.responseBody;

  // HTML iframe setup
  if (ct.includes('html') || (body && (body.trim().startsWith('<!DOCTYPE') || body.trim().startsWith('<html')))) {
    requestAnimationFrame(() => {
      const iframe = document.getElementById('preview-iframe');
      if (!iframe) return;

      // Create blob URL for HTML content
      const blob = new Blob([body], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      iframe.src = blobUrl;

      // Cleanup blob URL after load
      iframe.addEventListener('load', () => {
        URL.revokeObjectURL(blobUrl);
      }, { once: true });

      // Toggle source view
      const toggleBtn = document.getElementById('preview-toggle-source');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          const source = document.getElementById('preview-source');
          const frame = document.getElementById('preview-iframe');
          if (source && frame) {
            const isSourceVisible = !source.classList.contains('hidden');
            source.classList.toggle('hidden');
            frame.classList.toggle('hidden');
            toggleBtn.textContent = isSourceVisible ? '‹/› Source' : '🌐 Preview';
          }
        });
      }
    });
  }

  // Image data setup
  if (ct.includes('image/')) {
    requestAnimationFrame(() => {
      const img = document.getElementById('preview-image');
      if (!img || !body) return;

      // Try to create data URL from body
      const mimeType = ct.split(';')[0].trim();
      try {
        // If body is base64 or binary, create blob
        const encoder = new TextEncoder();
        const data = encoder.encode(body);
        const blob = new Blob([data], { type: mimeType });
        img.src = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(img.src), { once: true });
      } catch (e) {
        img.alt = 'Could not render image preview';
      }
    });
  }
}

function renderCookies(session) {
  const cookies = [];
  
  // Request cookies
  const reqCookie = session.requestHeaders?.['cookie'] || session.requestHeaders?.['Cookie'];
  if (reqCookie) {
    reqCookie.split(';').forEach(c => {
      const [name, ...valueParts] = c.trim().split('=');
      cookies.push({ name: name.trim(), value: valueParts.join('='), source: 'Request' });
    });
  }

  // Response Set-Cookie
  const setCookie = session.responseHeaders?.['set-cookie'];
  if (setCookie) {
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookieArray.forEach(c => {
      const parts = c.split(';');
      const [name, ...valueParts] = parts[0].split('=');
      const attrs = parts.slice(1).map(p => p.trim()).join('; ');
      cookies.push({
        name: name.trim(),
        value: valueParts.join('='),
        attributes: attrs,
        source: 'Response'
      });
    });
  }

  if (cookies.length === 0) {
    return '<div class="detail-empty"><p>No cookies found</p></div>';
  }

  let html = '<table class="cookies-table">';
  html += '<tr><th>Source</th><th>Name</th><th>Value</th><th>Attributes</th></tr>';
  cookies.forEach(c => {
    html += `<tr><td><span class="badge badge-info">${c.source}</span></td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.value || '')}</td><td>${escapeHtml(c.attributes || '')}</td></tr>`;
  });
  html += '</table>';
  return html;
}

function renderParams(session) {
  const params = [];
  
  try {
    const urlObj = new URL(session.url);
    urlObj.searchParams.forEach((value, key) => {
      params.push({ key, value, source: 'Query' });
    });
  } catch (e) {
    // Try to extract query params manually
    const queryString = session.url?.split('?')[1];
    if (queryString) {
      queryString.split('&').forEach(pair => {
        const [key, ...valueParts] = pair.split('=');
        params.push({ key: decodeURIComponent(key), value: decodeURIComponent(valueParts.join('=')), source: 'Query' });
      });
    }
  }

  // Form body params
  const ct = session.requestHeaders?.['content-type'] || '';
  if (ct.includes('form-urlencoded') && session.requestBody) {
    session.requestBody.split('&').forEach(pair => {
      const [key, ...valueParts] = pair.split('=');
      try {
        params.push({
          key: decodeURIComponent(key),
          value: decodeURIComponent(valueParts.join('=')),
          source: 'Body'
        });
      } catch (e) {
        params.push({ key, value: valueParts.join('='), source: 'Body' });
      }
    });
  }

  if (params.length === 0) {
    return '<div class="detail-empty"><p>No parameters found</p></div>';
  }

  let html = '<table class="params-table">';
  html += '<tr><th>Source</th><th>Parameter</th><th>Value</th></tr>';
  params.forEach(p => {
    html += `<tr><td><span class="badge badge-info">${p.source}</span></td><td>${escapeHtml(p.key)}</td><td>${escapeHtml(p.value)}</td></tr>`;
  });
  html += '</table>';
  return html;
}

function renderTiming(session) {
  if (!session.duration) {
    return '<div class="detail-empty"><p>No timing data available</p></div>';
  }

  const total = session.duration;
  // Estimate timing phases (real implementation would need actual measurements)
  const dns = Math.min(total * 0.05, 50);
  const connect = Math.min(total * 0.1, 100);
  const tlsTime = session.protocol === 'HTTPS' ? Math.min(total * 0.15, 150) : 0;
  const waiting = total * 0.5;
  const receiving = total - dns - connect - tlsTime - waiting;

  let html = '<div style="max-width: 600px;">';
  html += '<h4 style="margin-bottom: 16px; color: var(--text-accent);">Request Timing Breakdown</h4>';
  
  html += timingBar('DNS Lookup', dns, total, 'dns');
  html += timingBar('TCP Connect', connect, total, 'connect');
  if (tlsTime > 0) {
    html += timingBar('TLS Handshake', tlsTime, total, 'tls');
  }
  html += timingBar('Server Wait (TTFB)', waiting, total, 'waiting');
  html += timingBar('Content Download', receiving, total, 'receiving');
  html += timingBar('Total', total, total, 'total');

  html += '</div>';
  return html;
}

function timingBar(label, value, total, className) {
  const pct = total > 0 ? (value / total * 100) : 0;
  return `
    <div class="timing-bar-container">
      <div class="timing-bar-label">
        <span>${label}</span>
        <span>${Math.round(value)}ms</span>
      </div>
      <div class="timing-bar">
        <div class="timing-bar-fill ${className}" style="width: ${Math.max(pct, 1)}%"></div>
      </div>
    </div>
  `;
}

// ============================
// Syntax Highlighting
// ============================
function syntaxHighlightJSON(json) {
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'key';
          match = match.replace(/:$/, '') + ':';
        } else {
          cls = 'string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'boolean';
      } else if (/null/.test(match)) {
        cls = 'null';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function syntaxHighlightXML(xml) {
  let highlighted = escapeHtml(xml);
  // Tags
  highlighted = highlighted.replace(/(&lt;\/?[a-zA-Z][a-zA-Z0-9-]*)/g, '<span class="tag">$1</span>');
  // Attributes
  highlighted = highlighted.replace(/(\s[a-zA-Z-]+)(=)/g, '<span class="attr-name">$1</span>$2');
  // Attribute values
  highlighted = highlighted.replace(/(=)(&quot;[^&]*&quot;)/g, '$1<span class="attr-value">$2</span>');
  // Comments
  highlighted = highlighted.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="comment">$1</span>');
  return highlighted;
}

function syntaxHighlightHTML(html) {
  return syntaxHighlightXML(html);
}

// ============================
// Resize
// ============================
function setupResize() {
  const handle = document.getElementById('resize-handle-h');
  const panelList = document.getElementById('panel-list');
  const panelDetail = document.getElementById('panel-detail');
  let isResizing = false;
  let startY = 0;
  let startListHeight = 0;
  let startDetailHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startListHeight = panelList.offsetHeight;
    startDetailHeight = panelDetail.offsetHeight;
    handle.classList.add('active');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dy = e.clientY - startY;
    const newListHeight = Math.max(150, startListHeight + dy);
    const newDetailHeight = Math.max(100, startDetailHeight - dy);
    panelList.style.flex = 'none';
    panelList.style.height = newListHeight + 'px';
    panelDetail.style.height = newDetailHeight + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
    }
  });
}

// ============================
// Modals
// ============================
function setupModals() {
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.close;
      hideModal(modalId);
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('show');
      }
    });
  });
}

function showModal(id) {
  document.getElementById(id).classList.add('show');
}

function hideModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ============================
// Composer
// ============================
function setupComposer() {
  // Tabs
  document.querySelectorAll('.composer-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.composer-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.composer-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`ctab-${tab.dataset.ctab}`).classList.remove('hidden');
    });
  });

  // Add header row
  document.getElementById('add-header-row').addEventListener('click', () => {
    const editor = document.getElementById('composer-headers');
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `
      <input type="text" placeholder="Header name" class="kv-key">
      <input type="text" placeholder="Header value" class="kv-value">
      <button class="kv-remove" title="Remove">✕</button>
    `;
    row.querySelector('.kv-remove').addEventListener('click', () => row.remove());
    editor.appendChild(row);
  });

  // Remove header handlers
  document.querySelectorAll('.kv-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.parentElement.remove());
  });

  // Auth type change
  document.getElementById('auth-type').addEventListener('change', (e) => {
    const fields = document.getElementById('auth-fields');
    switch (e.target.value) {
      case 'bearer':
        fields.innerHTML = '<input type="text" placeholder="Bearer Token" id="auth-token">';
        break;
      case 'basic':
        fields.innerHTML = '<input type="text" placeholder="Username" id="auth-user"><input type="password" placeholder="Password" id="auth-pass">';
        break;
      case 'api-key':
        fields.innerHTML = '<input type="text" placeholder="Header Name" id="auth-key-name" value="X-API-Key"><input type="text" placeholder="API Key" id="auth-key-value">';
        break;
      default:
        fields.innerHTML = '';
    }
  });

  // Send button
  document.getElementById('composer-send').addEventListener('click', sendComposedRequest);
}

async function sendComposedRequest() {
  const method = document.getElementById('composer-method').value;
  const url = document.getElementById('composer-url').value;

  if (!url) {
    alert('Please enter a URL');
    return;
  }

  // Collect headers
  const headers = {};
  document.querySelectorAll('#composer-headers .kv-row').forEach(row => {
    const key = row.querySelector('.kv-key').value.trim();
    const value = row.querySelector('.kv-value').value.trim();
    if (key) headers[key] = value;
  });

  // Auth
  const authType = document.getElementById('auth-type').value;
  if (authType === 'bearer') {
    const token = document.getElementById('auth-token')?.value;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (authType === 'basic') {
    const user = document.getElementById('auth-user')?.value || '';
    const pass = document.getElementById('auth-pass')?.value || '';
    headers['Authorization'] = `Basic ${btoa(user + ':' + pass)}`;
  } else if (authType === 'api-key') {
    const keyName = document.getElementById('auth-key-name')?.value || 'X-API-Key';
    const keyValue = document.getElementById('auth-key-value')?.value || '';
    if (keyValue) headers[keyName] = keyValue;
  }

  // Body
  const bodyType = document.querySelector('input[name="body-type"]:checked')?.value;
  let body = null;
  if (bodyType !== 'none') {
    body = document.getElementById('composer-body').value;
  }

  const sendBtn = document.getElementById('composer-send');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';

  const result = await window.api.sendRequest({ method, url, headers, body });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';

  const responseEl = document.getElementById('composer-response');
  if (result.success) {
    const session = result.session;
    responseEl.innerHTML = `
      <h4 style="color: var(--text-accent); margin-bottom: 8px;">Response</h4>
      <div class="summary-grid" style="margin-bottom: 12px;">
        ${summaryRow('Status', `<span class="${getStatusClass(session.statusCode)}">${session.statusCode} ${session.statusMessage}</span>`)}
        ${summaryRow('Time', formatDuration(session.duration))}
        ${summaryRow('Size', formatBytes(session.responseSize))}
      </div>
      <div class="code-view" style="max-height: 300px; overflow: auto;">${
        session.responseBody ? (looksLikeJSON(session.responseBody) ? syntaxHighlightJSON(tryPrettifyJSON(session.responseBody)) : escapeHtml(session.responseBody)) : '(empty response)'
      }</div>
    `;
  } else {
    responseEl.innerHTML = `<div class="text-error" style="padding: 12px;">Error: ${escapeHtml(result.error)}</div>`;
  }
}

// ============================
// Resubmit
// ============================
function setupResubmit() {
  document.getElementById('resubmit-send').addEventListener('click', resubmitRequest);
}

function openResubmit() {
  if (!selectedSession) return;
  openResubmitForSession(selectedSession);
}

function openResubmitForSession(session) {
  document.getElementById('resubmit-method').value = session.method || 'GET';
  document.getElementById('resubmit-url').value = session.url || '';
  
  // Format headers
  const headers = Object.entries(session.requestHeaders || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  document.getElementById('resubmit-headers').value = headers;
  document.getElementById('resubmit-body').value = session.requestBody || '';
  document.getElementById('resubmit-response').innerHTML = '';
  
  showModal('modal-resubmit');
}

async function resubmitRequest() {
  const method = document.getElementById('resubmit-method').value;
  const url = document.getElementById('resubmit-url').value;
  
  const headers = {};
  document.getElementById('resubmit-headers').value.split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  });

  const body = document.getElementById('resubmit-body').value || null;

  const sendBtn = document.getElementById('resubmit-send');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';

  const result = await window.api.resubmitSession({ method, url, headers, body });

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';

  const responseEl = document.getElementById('resubmit-response');
  if (result.success) {
    const session = result.session;
    responseEl.innerHTML = `
      <h4 style="color: var(--text-accent); margin-bottom: 8px;">Response</h4>
      <div class="summary-grid" style="margin-bottom: 12px;">
        ${summaryRow('Status', `<span class="${getStatusClass(session.statusCode)}">${session.statusCode} ${session.statusMessage}</span>`)}
        ${summaryRow('Time', formatDuration(session.duration))}
        ${summaryRow('Size', formatBytes(session.responseSize))}
      </div>
      <div class="code-view" style="max-height: 300px; overflow: auto;">${
        session.responseBody ? (looksLikeJSON(session.responseBody) ? syntaxHighlightJSON(tryPrettifyJSON(session.responseBody)) : escapeHtml(session.responseBody)) : '(empty response)'
      }</div>
    `;
  } else {
    responseEl.innerHTML = `<div class="text-error" style="padding: 12px;">Error: ${escapeHtml(result.error)}</div>`;
  }
}

// ============================
// Data Converter
// ============================
function setupConverter() {
  const input = document.getElementById('converter-input');
  const output = document.getElementById('converter-output');

  document.getElementById('url-encode').addEventListener('click', () => {
    output.value = encodeURIComponent(input.value);
  });
  document.getElementById('url-decode').addEventListener('click', () => {
    try { output.value = decodeURIComponent(input.value); }
    catch (e) { output.value = 'Error: Invalid URL encoding'; }
  });
  document.getElementById('base64-encode').addEventListener('click', () => {
    try { output.value = btoa(unescape(encodeURIComponent(input.value))); }
    catch (e) { output.value = 'Error: Could not encode'; }
  });
  document.getElementById('base64-decode').addEventListener('click', () => {
    try { output.value = decodeURIComponent(escape(atob(input.value))); }
    catch (e) { output.value = 'Error: Invalid Base64'; }
  });
  document.getElementById('hex-encode').addEventListener('click', () => {
    output.value = Array.from(input.value).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  });
  document.getElementById('hex-decode').addEventListener('click', () => {
    try {
      output.value = input.value.replace(/\s/g, '').match(/.{1,2}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    } catch (e) { output.value = 'Error: Invalid Hex'; }
  });
  document.getElementById('html-encode').addEventListener('click', () => {
    output.value = input.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  });
  document.getElementById('html-decode').addEventListener('click', () => {
    const el = document.createElement('textarea');
    el.innerHTML = input.value;
    output.value = el.value;
  });
  document.getElementById('json-prettify').addEventListener('click', () => {
    try { output.value = JSON.stringify(JSON.parse(input.value), null, 2); }
    catch (e) { output.value = 'Error: Invalid JSON'; }
  });
  document.getElementById('json-minify').addEventListener('click', () => {
    try { output.value = JSON.stringify(JSON.parse(input.value)); }
    catch (e) { output.value = 'Error: Invalid JSON'; }
  });
  document.getElementById('converter-swap').addEventListener('click', () => {
    const temp = input.value;
    input.value = output.value;
    output.value = temp;
  });
}

// ============================
// Charts
// ============================
function setupCharts() {
  document.querySelectorAll('.chart-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentChartType = tab.dataset.chart;
      renderChart(currentChartType);
    });
  });
}

function renderChart(type) {
  const canvas = document.getElementById('chart-canvas');
  const legend = document.getElementById('chart-legend');
  const ctx = canvas.getContext('2d');

  // Set canvas size for high DPI
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = (rect.width - 40) * window.devicePixelRatio;
  canvas.height = 400 * window.devicePixelRatio;
  canvas.style.width = (rect.width - 40) + 'px';
  canvas.style.height = '400px';
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  legend.innerHTML = '';

  if (allSessions.length === 0) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data to display. Capture some traffic first.', (rect.width - 40) / 2, 200);
    return;
  }

  switch (type) {
    case 'timing': renderTimingChart(ctx, canvas, legend); break;
    case 'sizes': renderSizesChart(ctx, canvas, legend); break;
    case 'status': renderStatusChart(ctx, canvas, legend); break;
    case 'domains': renderDomainsChart(ctx, canvas, legend); break;
    case 'types': renderTypesChart(ctx, canvas, legend); break;
    case 'methods': renderMethodsChart(ctx, canvas, legend); break;
    case 'timeline': renderTimelineChart(ctx, canvas, legend); break;
  }
}

function renderTimingChart(ctx, canvas, legend) {
  renderBarChart(ctx, canvas, legend, {
    title: 'Slowest Requests (Response Time)',
    data: allSessions
      .filter(s => s.duration > 0)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20)
      .map(s => ({ label: truncate(s.path || s.url, 15), value: s.duration, color: getTimingColor(s.duration) })),
    valueLabel: 'ms'
  });
}

function renderSizesChart(ctx, canvas, legend) {
  renderBarChart(ctx, canvas, legend, {
    title: 'Largest Responses (Size)',
    data: allSessions
      .filter(s => s.responseSize > 0)
      .sort((a, b) => b.responseSize - a.responseSize)
      .slice(0, 20)
      .map(s => ({ label: truncate(s.path || s.url, 15), value: s.responseSize, color: '#89b4fa' })),
    valueLabel: 'B',
    formatValue: formatBytes
  });
}

function renderStatusChart(ctx, canvas, legend) {
  const counts = {};
  allSessions.forEach(s => {
    const group = s.statusCode ? `${Math.floor(s.statusCode / 100)}xx` : 'Error';
    counts[group] = (counts[group] || 0) + 1;
  });

  const colors = { '1xx': '#89dceb', '2xx': '#a6e3a1', '3xx': '#89dceb', '4xx': '#f9e2af', '5xx': '#f38ba8', 'Error': '#6c7086' };
  renderPieChart(ctx, canvas, legend, {
    title: 'Status Code Distribution',
    data: Object.entries(counts).map(([key, value]) => ({ label: key, value, color: colors[key] || '#89b4fa' }))
  });
}

function renderDomainsChart(ctx, canvas, legend) {
  const counts = {};
  allSessions.forEach(s => {
    const host = s.host || 'unknown';
    counts[host] = (counts[host] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const chartColors = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#89dceb', '#94e2d5', '#fab387', '#74c7ec', '#b4befe'];
  
  renderBarChart(ctx, canvas, legend, {
    title: 'Most Requested Domains',
    data: sorted.map(([label, value], i) => ({ label: truncate(label, 20), value, color: chartColors[i % chartColors.length] })),
    valueLabel: 'requests'
  });
}

function renderTypesChart(ctx, canvas, legend) {
  const counts = {};
  allSessions.forEach(s => {
    const type = s.contentType || 'other';
    counts[type] = (counts[type] || 0) + 1;
  });

  const colors = { json: '#a6e3a1', html: '#f38ba8', javascript: '#f9e2af', css: '#89b4fa', xml: '#cba6f7', image: '#89dceb', font: '#94e2d5', text: '#fab387', other: '#6c7086' };
  renderPieChart(ctx, canvas, legend, {
    title: 'Content Type Distribution',
    data: Object.entries(counts).map(([key, value]) => ({ label: key, value, color: colors[key] || '#89b4fa' }))
  });
}

function renderMethodsChart(ctx, canvas, legend) {
  const counts = {};
  allSessions.forEach(s => {
    counts[s.method] = (counts[s.method] || 0) + 1;
  });

  const colors = { GET: '#a6e3a1', POST: '#89b4fa', PUT: '#f9e2af', DELETE: '#f38ba8', PATCH: '#cba6f7', OPTIONS: '#6c7086', CONNECT: '#94e2d5', HEAD: '#fab387' };
  renderPieChart(ctx, canvas, legend, {
    title: 'HTTP Methods Distribution',
    data: Object.entries(counts).map(([key, value]) => ({ label: key, value, color: colors[key] || '#89b4fa' }))
  });
}

function renderTimelineChart(ctx, canvas, legend) {
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  const padding = { top: 40, right: 20, bottom: 50, left: 60 };

  if (allSessions.length === 0) return;

  const sessions = allSessions.slice(-100); // Last 100
  const maxDuration = Math.max(...sessions.map(s => s.duration || 0));

  ctx.fillStyle = getCSS('--text-secondary');
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Request Timeline (last 100 requests)', width / 2, 20);

  // Y axis
  ctx.strokeStyle = getCSS('--border');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (height - padding.top - padding.bottom) * (1 - i / 5);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = getCSS('--text-muted');
    ctx.font = '10px -apple-system';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxDuration * i / 5) + 'ms', padding.left - 5, y + 3);
  }

  // Bars
  const barWidth = Math.max(2, (width - padding.left - padding.right) / sessions.length - 1);
  sessions.forEach((s, i) => {
    const x = padding.left + i * ((width - padding.left - padding.right) / sessions.length);
    const barHeight = maxDuration > 0 ? ((s.duration || 0) / maxDuration) * (height - padding.top - padding.bottom) : 0;
    const y = height - padding.bottom - barHeight;

    ctx.fillStyle = s.statusCode >= 400 ? '#f38ba8' : s.statusCode >= 300 ? '#89dceb' : '#a6e3a1';
    ctx.fillRect(x, y, barWidth, barHeight);
  });
}

// Generic bar chart renderer
function renderBarChart(ctx, canvas, legend, { title, data, valueLabel, formatValue }) {
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  const padding = { top: 40, right: 20, bottom: 80, left: 60 };

  if (data.length === 0) return;

  const maxValue = Math.max(...data.map(d => d.value));

  // Title
  ctx.fillStyle = getCSS('--text-secondary');
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 20);

  // Grid lines
  ctx.strokeStyle = getCSS('--border');
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (height - padding.top - padding.bottom) * (1 - i / 5);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    const val = maxValue * i / 5;
    ctx.fillStyle = getCSS('--text-muted');
    ctx.font = '10px -apple-system';
    ctx.textAlign = 'right';
    ctx.fillText(formatValue ? formatValue(val) : Math.round(val) + (valueLabel ? ` ${valueLabel}` : ''), padding.left - 5, y + 3);
  }

  // Bars
  const barWidth = Math.max(8, Math.min(40, (width - padding.left - padding.right) / data.length - 4));
  const totalBarsWidth = data.length * (barWidth + 4);
  const startX = padding.left + (width - padding.left - padding.right - totalBarsWidth) / 2;

  data.forEach((d, i) => {
    const x = startX + i * (barWidth + 4);
    const barHeight = maxValue > 0 ? (d.value / maxValue) * (height - padding.top - padding.bottom) : 0;
    const y = height - padding.bottom - barHeight;

    // Bar
    ctx.fillStyle = d.color || '#89b4fa';
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
    ctx.fill();

    // Value
    ctx.fillStyle = getCSS('--text-secondary');
    ctx.font = '9px -apple-system';
    ctx.textAlign = 'center';
    ctx.fillText(formatValue ? formatValue(d.value) : d.value, x + barWidth / 2, y - 4);

    // Label
    ctx.save();
    ctx.translate(x + barWidth / 2, height - padding.bottom + 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = getCSS('--text-muted');
    ctx.font = '9px -apple-system';
    ctx.textAlign = 'left';
    ctx.fillText(d.label, 0, 0);
    ctx.restore();
  });
}

// Generic pie chart renderer
function renderPieChart(ctx, canvas, legend, { title, data }) {
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  
  if (total === 0) return;

  // Title
  ctx.fillStyle = getCSS('--text-secondary');
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 20);

  const centerX = width / 2;
  const centerY = height / 2 + 10;
  const radius = Math.min(width, height) / 2 - 60;

  let startAngle = -Math.PI / 2;

  data.forEach(d => {
    const sliceAngle = (d.value / total) * Math.PI * 2;
    
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = d.color;
    ctx.fill();

    // Slice border
    ctx.strokeStyle = getCSS('--bg-secondary');
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    if (sliceAngle > 0.15) {
      const midAngle = startAngle + sliceAngle / 2;
      const labelX = centerX + Math.cos(midAngle) * (radius * 0.65);
      const labelY = centerY + Math.sin(midAngle) * (radius * 0.65);
      
      ctx.fillStyle = '#1e1e2e';
      ctx.font = 'bold 11px -apple-system';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(d.value / total * 100)}%`, labelX, labelY);
    }

    startAngle += sliceAngle;
  });

  // Legend
  data.forEach(d => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-color" style="background: ${d.color}"></div><span>${d.label}: ${d.value} (${Math.round(d.value / total * 100)}%)</span>`;
    legend.appendChild(item);
  });
}

// ============================
// Rules
// ============================
function setupRules() {
  const addBtn = document.getElementById('add-rule-btn');
  const editor = document.getElementById('rule-editor');
  const saveBtn = document.getElementById('save-rule-btn');
  const cancelBtn = document.getElementById('cancel-rule-btn');

  addBtn.addEventListener('click', () => {
    editor.classList.remove('hidden');
    document.getElementById('rule-name').value = '';
    document.getElementById('rule-type').value = 'add-request-header';
    document.getElementById('rule-condition').value = 'all';
    document.getElementById('rule-condition-value').value = '';
    updateRuleParams();
  });

  cancelBtn.addEventListener('click', () => {
    editor.classList.add('hidden');
  });

  document.getElementById('rule-type').addEventListener('change', updateRuleParams);

  saveBtn.addEventListener('click', async () => {
    const rule = {
      name: document.getElementById('rule-name').value || 'Unnamed Rule',
      type: document.getElementById('rule-type').value,
      condition: document.getElementById('rule-condition').value,
      conditionField: document.getElementById('rule-condition-field').value,
      conditionValue: document.getElementById('rule-condition-value').value
    };

    // Get type-specific params
    const params = document.getElementById('rule-params');
    params.querySelectorAll('input, select').forEach(input => {
      rule[input.id.replace('rule-param-', '')] = input.value;
    });

    await window.api.addRule(rule);
    editor.classList.add('hidden');
    loadRules();
  });

  loadRules();
}

function updateRuleParams() {
  const type = document.getElementById('rule-type').value;
  const params = document.getElementById('rule-params');

  switch (type) {
    case 'add-request-header':
    case 'add-response-header':
      params.innerHTML = `
        <label>Header Name:</label>
        <input type="text" id="rule-param-headerName" placeholder="X-Custom-Header">
        <label>Header Value:</label>
        <input type="text" id="rule-param-headerValue" placeholder="value">
      `;
      break;
    case 'remove-request-header':
    case 'remove-response-header':
      params.innerHTML = `
        <label>Header Name:</label>
        <input type="text" id="rule-param-headerName" placeholder="X-Unwanted-Header">
      `;
      break;
    case 'modify-request-body':
    case 'modify-response-body':
      params.innerHTML = `
        <label>Search Text (regex):</label>
        <input type="text" id="rule-param-searchText" placeholder="search pattern">
        <label>Replace With:</label>
        <input type="text" id="rule-param-replaceText" placeholder="replacement">
      `;
      break;
    case 'redirect':
      params.innerHTML = `
        <label>Match URL Pattern:</label>
        <input type="text" id="rule-param-matchUrl" placeholder="https://old-server.com">
        <label>Redirect To:</label>
        <input type="text" id="rule-param-redirectUrl" placeholder="https://new-server.com">
      `;
      break;
    case 'set-status-code':
      params.innerHTML = `
        <label>Status Code:</label>
        <input type="number" id="rule-param-statusCode" placeholder="200" min="100" max="599">
      `;
      break;
    case 'delay':
      params.innerHTML = `
        <label>Delay (ms):</label>
        <input type="number" id="rule-param-delayMs" placeholder="1000" min="0">
      `;
      break;
    case 'block':
      params.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">Matching requests will be blocked with a 403 response.</p>';
      break;
  }
}

async function loadRules() {
  const rules = await window.api.getRules();
  const list = document.getElementById('rules-list');

  if (rules.length === 0) {
    list.innerHTML = '<div class="rules-empty">No traffic rules defined. Add a rule to modify HTTP traffic on-the-fly.</div>';
    return;
  }

  list.innerHTML = rules.map(rule => `
    <div class="rule-item ${rule.enabled ? '' : 'disabled'}" data-id="${rule.id}">
      <input type="checkbox" class="rule-toggle" ${rule.enabled ? 'checked' : ''}>
      <div class="rule-info">
        <div class="rule-name">${escapeHtml(rule.name)}</div>
        <div class="rule-desc">${escapeHtml(rule.type)} ${rule.condition !== 'all' ? `when ${rule.conditionField} ${rule.condition} "${rule.conditionValue}"` : '(always)'}</div>
      </div>
      <div class="rule-actions">
        <button class="btn btn-small btn-danger rule-delete" title="Delete">✕</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.rule-toggle').forEach(toggle => {
    toggle.addEventListener('change', async () => {
      const id = toggle.closest('.rule-item').dataset.id;
      await window.api.toggleRule(id);
      loadRules();
    });
  });

  list.querySelectorAll('.rule-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.rule-item').dataset.id;
      await window.api.deleteRule(id);
      loadRules();
    });
  });
}

// ============================
// Settings
// ============================
function setupSettings() {
  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const newSettings = {
      proxyPort: parseInt(document.getElementById('setting-port').value) || 8888,
      theme: document.getElementById('setting-theme').value,
      autoScroll: document.getElementById('setting-autoscroll').checked,
      maxSessions: parseInt(document.getElementById('setting-max-sessions').value) || 10000,
      highlightErrors: document.getElementById('setting-highlight-errors').checked,
      highlightSlowRequests: document.getElementById('setting-highlight-slow').checked,
      slowRequestThreshold: parseInt(document.getElementById('setting-slow-threshold').value) || 3000,
      largeRequestThreshold: parseInt(document.getElementById('setting-large-threshold').value) || 1048576
    };

    settings = await window.api.updateSettings(newSettings);
    applyTheme(settings.theme);
    applyFilters(); // Re-render with new highlight settings
    hideModal('modal-settings');
  });
}

// ============================
// Context Menu
// ============================
function setupContextMenu() {
  const menu = document.createElement('div');
  menu.className = 'context-menu hidden';
  menu.id = 'context-menu';
  document.body.appendChild(menu);

  document.addEventListener('click', () => {
    menu.classList.add('hidden');
  });
}

function showContextMenu(e, session) {
  e.preventDefault();
  const menu = document.getElementById('context-menu');
  
  menu.innerHTML = `
    <button class="context-menu-item" id="ctx-copy-url">Copy URL</button>
    <button class="context-menu-item" id="ctx-copy-curl">Copy as cURL</button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" id="ctx-resubmit">Edit & Resubmit</button>
    <button class="context-menu-item" id="ctx-replay">Replay Request</button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" id="ctx-copy-headers">Copy Response Headers</button>
    <button class="context-menu-item" id="ctx-copy-body">Copy Response Body</button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item" id="ctx-highlight">Add Highlight Rule</button>
  `;

  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.remove('hidden');

  // Ensure menu stays in viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = (e.clientX - rect.width) + 'px';
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = (e.clientY - rect.height) + 'px';
  }

  document.getElementById('ctx-copy-url').addEventListener('click', () => {
    navigator.clipboard.writeText(session.url);
  });

  document.getElementById('ctx-copy-curl').addEventListener('click', () => {
    let curl = `curl -X ${session.method} '${session.url}'`;
    Object.entries(session.requestHeaders || {}).forEach(([k, v]) => {
      curl += ` \\\n  -H '${k}: ${v}'`;
    });
    if (session.requestBody) {
      curl += ` \\\n  -d '${session.requestBody}'`;
    }
    navigator.clipboard.writeText(curl);
  });

  document.getElementById('ctx-resubmit').addEventListener('click', () => {
    openResubmitForSession(session);
  });

  document.getElementById('ctx-replay').addEventListener('click', async () => {
    const headers = {};
    Object.entries(session.requestHeaders || {}).forEach(([k, v]) => {
      if (!['host', 'content-length', 'connection'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    });
    await window.api.sendRequest({
      method: session.method,
      url: session.url,
      headers,
      body: session.requestBody
    });
  });

  document.getElementById('ctx-copy-headers').addEventListener('click', () => {
    const text = Object.entries(session.responseHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    navigator.clipboard.writeText(text);
  });

  document.getElementById('ctx-copy-body').addEventListener('click', () => {
    navigator.clipboard.writeText(session.responseBody || '');
  });

  document.getElementById('ctx-highlight').addEventListener('click', async () => {
    await window.api.addHighlightRule({
      name: `Highlight ${session.host}`,
      conditionField: 'host',
      condition: 'equals',
      conditionValue: session.host,
      color: '#f38ba8'
    });
  });
}

// ============================
// Keyboard Shortcuts
// ============================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // F5 - Start capture
    if (e.key === 'F5') {
      e.preventDefault();
      startCapture();
    }
    // F6 - Stop capture
    if (e.key === 'F6') {
      e.preventDefault();
      stopCapture();
    }
    // Escape - Close modals
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
      document.getElementById('context-menu')?.classList.add('hidden');
    }
    // Delete - Clear (with Cmd)
    if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
      e.preventDefault();
      clearAll();
    }
  });
}

// ============================
// Theme Toggle
// ============================
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  window.api.updateSettings({ theme: next });
}

// ============================
// Stats
// ============================
function updateStats() {
  const total = filteredSessions.length;
  const totalSize = filteredSessions.reduce((sum, s) => sum + (s.responseSize || 0), 0);
  const totalTime = filteredSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const errors = filteredSessions.filter(s => s.statusCode >= 400).length;

  document.getElementById('stat-total').textContent = `${total} request${total !== 1 ? 's' : ''}`;
  document.getElementById('stat-size').textContent = formatBytes(totalSize);
  document.getElementById('stat-time').textContent = formatDuration(totalTime);
  document.getElementById('sb-requests').textContent = `Requests: ${allSessions.length}`;
  document.getElementById('sb-errors').textContent = `Errors: ${errors}`;
  document.getElementById('sb-size').textContent = `Total: ${formatBytes(totalSize)}`;
}

// ============================
// Helpers
// ============================
function getStatusClass(code) {
  if (!code) return 'status-0';
  if (code >= 500) return 'status-5xx';
  if (code >= 400) return 'status-4xx';
  if (code >= 300) return 'status-3xx';
  if (code >= 200) return 'status-2xx';
  return '';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(ms) {
  if (!ms || ms === 0) return '0 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' min';
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function looksLikeJSON(str) {
  if (!str) return false;
  const trimmed = str.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function tryPrettifyJSON(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch (e) {
    return str;
  }
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function getTimingColor(ms) {
  if (ms < 200) return '#a6e3a1';
  if (ms < 500) return '#89dceb';
  if (ms < 1000) return '#f9e2af';
  if (ms < 3000) return '#fab387';
  return '#f38ba8';
}

function getCSS(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}
