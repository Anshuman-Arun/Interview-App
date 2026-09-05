import {
  createSecureStartupWebPreferences,
  type SecureStartupWebPreferences
} from "./window-config.js";

export const STARTUP_WINDOW_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Interview App</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #121214;
      --text: #f0f0f3;
      --text-muted: #8e8e93;
      --accent: #2563eb;
      --border: #2c2c32;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8f9fa;
        --text: #1a1a1e;
        --text-muted: #6b7280;
        --accent: #2563eb;
        --border: #e5e7eb;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      user-select: none;
      -webkit-user-select: none;
      -webkit-app-region: drag;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px;
      overflow: hidden;
    }
    .container {
      width: 100%;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .icon-badge {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 22px;
      font-weight: 700;
      box-shadow: 0 4px 16px rgba(37, 99, 235, 0.35);
    }
    h1 {
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .status {
      font-size: 13px;
      color: var(--text-muted);
      height: 20px;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
    }
    .progress-bar {
      width: 100%;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .progress-indeterminate {
      position: absolute;
      background: var(--accent);
      top: 0;
      bottom: 0;
      left: 0;
      width: 40%;
      border-radius: 2px;
      animation: indeterminate 1.5s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
    }
    @keyframes indeterminate {
      0% { left: -40%; width: 40%; }
      50% { left: 40%; width: 60%; }
      100% { left: 100%; width: 40%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon-badge">IA</div>
    <h1>Interview App</h1>
    <div class="status" id="status-text">Starting Interview App...</div>
    <div class="progress-bar">
      <div class="progress-indeterminate"></div>
    </div>
  </div>
  <script>
    window.updateStatus = function(text) {
      var el = document.getElementById("status-text");
      if (el) el.textContent = text;
    };
  </script>
</body>
</html>`;

export const STARTUP_WINDOW_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_WINDOW_HTML)}`;

export function isHeadlessCliLaunch(argv: readonly string[]): boolean {
  return argv.includes("--install-local-models")
    || argv.includes("--install-local-vision-models")
    || argv.includes("--packaged-single-instance-smoke-probe");
}

export function getStartupWindowOptions(): {
  readonly width: 440;
  readonly height: 280;
  readonly resizable: false;
  readonly minimizable: false;
  readonly maximizable: false;
  readonly closable: true;
  readonly fullscreenable: false;
  readonly frame: false;
  readonly show: false;
  readonly center: true;
  readonly alwaysOnTop: false;
  readonly title: "Interview App";
  readonly backgroundColor: "#121214";
  readonly webPreferences: SecureStartupWebPreferences;
} {
  return {
    width: 440,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    alwaysOnTop: false,
    title: "Interview App",
    backgroundColor: "#121214",
    webPreferences: createSecureStartupWebPreferences()
  };
}
