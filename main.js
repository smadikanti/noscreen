const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

let mainWindow;

function createWindow() {
  const winW = 480;
  const winH = 750;
  const { workArea } = screen.getPrimaryDisplay();

  const x = Math.round(workArea.x + (workArea.width - winW) / 2);
  const y = Math.round(workArea.y + (workArea.height - winH) / 3);

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    minWidth: 280,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    roundedCorners: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,

    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,

    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // START interactive (not click-through) so user can type in the URL input
  mainWindow._clickThrough = false;
  mainWindow.setIgnoreMouseEvents(false);

  // Invisible to screenshare
  mainWindow.setContentProtection(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.setPosition(x, y);
    mainWindow.webContents.setZoomFactor(0.8);
    mainWindow.show();

    // Apply CGS private API stealth tags to hide from display-level capture (CRD, etc.)
    if (process.platform === 'darwin') {
      applyStealthTags();
    }
  });

  mainWindow.on('moved', () => snapToScreenBounds());

  // Listen for "connected" from renderer — switch to click-through
  ipcMain.on('connected', () => {
    mainWindow._clickThrough = true;
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.webContents.send('interactive-changed', false);
  });

  registerShortcuts();
}

function snapToScreenBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const [wx, wy] = mainWindow.getPosition();
  const [ww, wh] = mainWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: wx, y: wy });
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea;

  let nx = wx;
  let ny = wy;

  if (nx < sx) nx = sx;
  if (nx + ww > sx + sw) nx = sx + sw - ww;
  if (ny < sy) ny = sy;
  if (ny + wh > sy + sh) ny = sy + sh - wh;

  if (nx !== wx || ny !== wy) {
    mainWindow.setPosition(nx, ny);
  }
}

function registerShortcuts() {
  // ⌘⇧H — Hide/Show
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      reapplyStealthIfNeeded();
    }
  });

  // ⌘⇧P — Play/Pause
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    sendToRenderer('toggle-pause');
  });

  // ⌘⇧L — Toggle interactive/click-through
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    mainWindow._clickThrough = !mainWindow._clickThrough;
    if (mainWindow._clickThrough) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
    sendToRenderer('interactive-changed', !mainWindow._clickThrough);
  });

  // ⌘⇧S — Toggle auto-scroll
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    sendToRenderer('toggle-autoscroll');
  });

  // ⌘⇧1-5 — Speed
  for (let i = 1; i <= 5; i++) {
    globalShortcut.register(`CommandOrControl+Shift+${i}`, () => {
      sendToRenderer('speed-changed', i);
    });
  }

  // ⌘⇧- / ⌘⇧= — Opacity down/up
  globalShortcut.register('CommandOrControl+Shift+-', () => {
    const current = mainWindow.getOpacity();
    mainWindow.setOpacity(Math.max(0.1, current - 0.1));
    sendToRenderer('opacity-changed', Math.round(mainWindow.getOpacity() * 100));
  });
  globalShortcut.register('CommandOrControl+Shift+=', () => {
    const current = mainWindow.getOpacity();
    mainWindow.setOpacity(Math.min(1.0, current + 0.1));
    sendToRenderer('opacity-changed', Math.round(mainWindow.getOpacity() * 100));
  });

  // ⌘⇧↑↓←→ — Move window
  const MOVE_STEP = 20;
  globalShortcut.register('CommandOrControl+Shift+Left', () => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x - MOVE_STEP, y);
    snapToScreenBounds();
  });
  globalShortcut.register('CommandOrControl+Shift+Right', () => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + MOVE_STEP, y);
    snapToScreenBounds();
  });
  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x, y - MOVE_STEP);
    snapToScreenBounds();
  });
  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x, y + MOVE_STEP);
    snapToScreenBounds();
  });
}

// Use macOS private CGS APIs to apply stealth window tags
// These operate below NSWindow level and can affect display-stream capture (CRD, etc.)
function applyStealthTags() {
  try {
    const pid = process.pid;
    const swiftCode = `
import Cocoa

@_silgen_name("CGSMainConnectionID")
func CGSMainConnectionID() -> UInt32

@_silgen_name("CGSSetWindowTags")
func CGSSetWindowTags(_ cid: UInt32, _ wid: UInt32, _ tags: UnsafeMutablePointer<Int>, _ sz: Int32) -> Int32

@_silgen_name("CGSSetWindowLevel")
func CGSSetWindowLevel(_ cid: UInt32, _ wid: UInt32, _ level: Int32) -> Int32

guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { exit(0) }

let cid = CGSMainConnectionID()
let targetPID = Int32(${pid})

for window in windowList {
    guard let ownerPID = window[kCGWindowOwnerPID as String] as? Int32,
          ownerPID == targetPID,
          let windowID = window[kCGWindowNumber as String] as? UInt32 else { continue }

    // Tag 0x2: kCGSTagTransparent — excludes from certain capture compositors
    var tag1: Int = 0x2
    CGSSetWindowTags(cid, windowID, &tag1, 64)

    // Tag 0x200: prevents window from appearing in CGDisplayStream captures
    var tag2: Int = 0x200
    CGSSetWindowTags(cid, windowID, &tag2, 64)

    // Tag 0x80000: exclude from window-list capture APIs
    var tag3: Int = 0x80000
    CGSSetWindowTags(cid, windowID, &tag3, 64)

    // Set to screensaver level (2100) via CGS — more authoritative than NSWindow API
    CGSSetWindowLevel(cid, windowID, 2100)
}
`;
    execSync(`/usr/bin/swift -e '${swiftCode.replace(/'/g, "'\\''")}'`, {
      timeout: 5000,
      stdio: 'pipe',
    });
    console.log('[noscreen] Stealth CGS tags applied');
  } catch (e) {
    console.log('[noscreen] Stealth tags failed (non-fatal):', e.message?.split('\n')[0]);
  }
}

// Re-apply stealth tags when window is moved or shown (they can reset)
function reapplyStealthIfNeeded() {
  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    applyStealthTags();
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
