const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
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
    hasShadow: true,
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
    else mainWindow.show();
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
