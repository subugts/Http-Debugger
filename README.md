# HTTP Debugger

A powerful HTTP/HTTPS traffic debugger and analyzer with a clean, modern UI. Capture, inspect, modify, and replay HTTP traffic — all from a beautiful desktop application.

![HTTP Debugger](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue) ![Electron](https://img.shields.io/badge/Built%20with-Electron-47848f) ![License](https://img.shields.io/badge/License-MIT-green)

## ✨ Features

### 🔍 Debug HTTP API Calls
- Proxy-based HTTP/HTTPS traffic sniffer with clean UI
- Capture traffic from any browser or application configured to use the proxy
- Display HTTP(S) traffic with full request/response details
- HTTPS tunnel support (CONNECT method)

### ✏️ Edit and Resubmit HTTP Sessions
- Edit any captured request and resubmit it to the server
- Modify method, URL, headers, and body before resending
- Test security, authorization flows, and edge cases
- Right-click context menu for quick resubmit

### 🎨 Highlighting of Errors and Slow Requests
- Automatic highlighting of 4xx/5xx error responses
- Visual indicators for slow requests (configurable threshold)
- Large response highlighting
- Custom highlighting rules

### 📊 Visualize Your Traffic
- **Response Times Chart** - Find the slowest requests
- **Response Sizes Chart** - Find the largest responses
- **Status Code Distribution** - Pie chart of status codes
- **Domain Analysis** - Most requested domains
- **Content Type Distribution** - Content type breakdown
- **HTTP Methods** - Method usage distribution
- **Timeline View** - Request timeline with performance overlay

### 🔎 Built-in Viewers for Various Data Types
- **HTTP Header Viewer** - Request & response headers in table format
- **JSON Tree Viewer** - Syntax-highlighted JSON with pretty printing
- **XML Viewer** - Syntax-highlighted XML content
- **HTML/JS/CSS Viewer** - Syntax-highlighted web content
- **Cookies Viewer** - Request and response cookies parsed
- **URL Params Viewer** - Query string and form body parameters
- **Session Summary** - Complete overview of each request
- **Timing Viewer** - Request timing breakdown (DNS, connect, TLS, TTFB, download)

### ⚡ Modify HTTP Traffic On-The-Fly
- Add/remove request headers
- Add/remove response headers
- Modify request/response body content
- Redirect requests from one server to another
- Set custom status codes
- Add artificial delays
- Block matching requests
- Conditional rules (URL, host, method, status, content-type matching)

### 🔧 Compose Custom Requests
- Full HTTP request composer
- Support for GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- Key-value header editor
- Request body editor (raw, form data, URL encoded)
- Authentication support (Bearer Token, Basic Auth, API Key)
- Instant response viewing with syntax highlighting

### 🔄 Data Converter
- URL encode/decode
- Base64 encode/decode
- Hex encode/decode
- HTML entity encode/decode
- JSON prettify/minify
- Input/output swap

### ⏱️ Accurate Timings
- Precise request/response timing measurement
- Timing breakdown visualization
- Performance bottleneck identification

### 📤 Export Data
- **JSON** - Full session data in JSON format
- **CSV** - Spreadsheet-compatible CSV export
- **XML** - Structured XML export
- **TXT** - Human-readable text format

### 🔍 Advanced Filtering
- Content type filters (XHR, HTML, CSS, JS, JSON, XML, Images, Fonts)
- HTTP method filters (GET, POST, PUT, DELETE, PATCH, OPTIONS, CONNECT)
- Full-text search across URL, host, path, method, status, and content type
- Column sorting (click any column header)

### 💾 Save and Restore Sessions
- Save complete session data to `.hds` files
- Restore sessions with full fidelity
- Share session files for collaborative debugging

### 🔢 Request Numbering
- Automatic chronological numbering of all requests
- Maintains order even with filtering active

### 🎛️ Flexible UI
- Dark and light theme support (Catppuccin color scheme)
- Resizable panels (drag the divider)
- Collapsible detail views
- Responsive toolbar (auto-hides labels at narrow widths)
- Keyboard shortcuts for common actions
- Right-click context menus

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) 18+ installed
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/subugts/Http-Debugger.git
cd Http-Debugger

# Install dependencies
npm install

# Start the application
npm start
```

### Development Mode

```bash
npm run dev
```

### Build for Distribution

```bash
# Build for macOS
npm run build:mac

# Build for Windows
npm run build:win

# Build for Linux
npm run build:linux
```

## 📖 Usage

### Capturing Traffic

1. Click **Capture** (or press `F5`) to start the proxy on port 8888
2. Configure your browser/application to use `127.0.0.1:8888` as HTTP proxy
3. Browse normally - all HTTP traffic will appear in the request list
4. Click **Stop** (or press `F6`) to stop capturing

### Proxy Configuration

**Browser (Chrome/Firefox):**
- Set HTTP Proxy to: `127.0.0.1:8888`
- Or use system proxy settings

**curl:**
```bash
curl -x http://127.0.0.1:8888 https://api.example.com/data
```

**Environment Variables:**
```bash
export http_proxy=http://127.0.0.1:8888
export https_proxy=http://127.0.0.1:8888
```

### Composing Requests

1. Click **Compose** (or press `⌘+N`)
2. Select method, enter URL
3. Add headers, body, and auth as needed
4. Click **Send** to execute
5. View the response inline

### Traffic Rules

1. Click **Rules** (or press `⌘+R`)
2. Click **+ Add Rule**
3. Select rule type (add header, redirect, block, etc.)
4. Set conditions for when the rule should apply
5. Save and rules will be applied to all matching traffic

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Start Capturing |
| `F6` | Stop Capturing |
| `⌘+N` | Compose Request |
| `⌘+S` | Save Session |
| `⌘+O` | Open Session |
| `⌘+D` | Data Converter |
| `⌘+R` | Traffic Rules |
| `⌘+T` | Toggle Theme |
| `⌘+Delete` | Clear All |
| `Escape` | Close Modal |

## 🏗️ Project Structure

```
Http-Debugger/
├── package.json
├── README.md
├── src/
│   ├── main/
│   │   ├── main.js              # Electron main process
│   │   ├── preload.js           # IPC bridge
│   │   ├── proxy-engine.js      # HTTP/HTTPS proxy server
│   │   └── traffic-modifier.js  # Traffic modification rules engine
│   └── renderer/
│       ├── index.html           # Main application UI
│       ├── styles.css           # Complete styling (dark/light themes)
│       └── app.js               # Application logic, viewers, charts
└── assets/
    └── icon.png                 # App icon placeholder
```

## 🛠️ Technology Stack

- **Electron** - Cross-platform desktop framework
- **Node.js** - HTTP/HTTPS proxy server
- **Vanilla JS** - No framework dependencies for maximum performance
- **Canvas API** - Charts and visualizations
- **CSS Custom Properties** - Theme system

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Made with ❤️ for developers who need to debug HTTP traffic.
