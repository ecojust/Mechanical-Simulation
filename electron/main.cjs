const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');

// A local, secure origin lets GLTFLoader and fetch read bundled models without
// disabling web security or running an HTTP service on the user's computer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow;
const localOrigin = 'app://studio';
const externalHosts = new Set(['github.com', 'creativecommons.org', 'sketchfab.com']);
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'studio';
  } catch {
    return false;
  }
}

function openDocumentation(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && externalHosts.has(url.hostname) && !url.username && !url.password) {
      void shell.openExternal(url.href);
    }
  } catch {
    // Invalid and non-documentation URLs are not opened outside the application.
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Mechanical Studio · 机械仿真工作台',
    width: 1540,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#101b29',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openDocumentation(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault();
      openDocumentation(url);
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void mainWindow.loadURL(`${localOrigin}/index.html`);
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [
      { label: '工程保存与导入请使用工作台工具栏', enabled: false },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销文本编辑' },
      { role: 'redo', label: '重做文本编辑' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ] },
    { label: '视图', submenu: [
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大界面' },
      { role: 'zoomOut', label: '缩小界面' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
    ] },
    { label: '帮助', submenu: [
      { label: '项目说明', click: () => openDocumentation('https://github.com/ecojust/Mechanical-Simulation') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '..', 'dist');
    protocol.handle('app', async (request) => {
      try {
        const url = new URL(request.url);
        if (!isLocalUrl(url.href) || request.method !== 'GET') {
          return new Response('Forbidden', { status: 403 });
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(root + path.sep)) {
          return new Response('Forbidden', { status: 403 });
        }
        const stat = await fs.stat(target);
        if (!stat.isFile()) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(target).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['app://*/*'] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy] } });
    });
    session.defaultSession.on('will-download', (_event, item) => {
      // Files exported by the workbench use the OS save dialog; no arbitrary
      // filesystem access is exposed to renderer code.
      const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'assembly.json';
      item.setSaveDialogOptions({
        title: '保存工作台文件',
        defaultPath: path.join(app.getPath('documents'), filename),
        buttonLabel: '保存',
      });
    });
    installMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('Mechanical Studio could not start:', error);
    app.quit();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
