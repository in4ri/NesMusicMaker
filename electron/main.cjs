// Electron main process: window, menu, file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const isMac = process.platform === 'darwin';
const devServer = process.env.VITE_DEV_SERVER_URL;
const distDir = path.join(__dirname, '..', 'dist');

// Serve the built app from app:// so it behaves like a normal web origin (AudioWorklet, fetch, ES modules).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
].join('; ');

let mainWindow = null;
let pendingOpenPath = null;

function send(command) {
  if (mainWindow) mainWindow.webContents.send('menu', command);
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Import MIDI File…', accelerator: 'CmdOrCtrl+I', click: () => send('import-midi') },
        { label: 'Import NSF File…', click: () => send('import-nsf') },
        { type: 'separator' },
        { label: 'Export WAV…', accelerator: 'CmdOrCtrl+E', click: () => send('export-wav') },
        { label: 'Export NSF…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('export-nsf') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('select-all') },
        { type: 'separator' },
        { label: 'Transpose Song…', click: () => send('transpose') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'NESdev APU reference', click: () => shell.openExternal('https://www.nesdev.org/wiki/APU') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function readProject(filePath) {
  return { path: filePath, text: await fs.readFile(filePath, 'utf8') };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b1d23',
    title: 'NES Music Maker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Ask before closing with unsaved changes (the renderer blocks unload when dirty).
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close anyway and lose them?',
    });
    if (choice === 0) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServer) mainWindow.loadURL(devServer);
  else mainWindow.loadURL('app://bundle/index.html');

  mainWindow.webContents.on('did-finish-load', async () => {
    if (pendingOpenPath) {
      const p = pendingOpenPath;
      pendingOpenPath = null;
      try {
        mainWindow.webContents.send('menu', { open: await readProject(p) });
      } catch (e) {
        console.error(e);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('open-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'NES Music Maker Project', extensions: ['nesmm', 'json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readProject(result.filePaths[0]);
});

ipcMain.handle('save-project', async (_e, filePath, text) => {
  let target = filePath;
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'Untitled.nesmm',
      filters: [{ name: 'NES Music Maker Project', extensions: ['nesmm'] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  await fs.writeFile(target, text, 'utf8');
  app.addRecentDocument(target);
  return target;
});

ipcMain.handle('save-binary', async (_e, defaultName, filterName, extensions, bytes) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, Buffer.from(bytes));
  return result.filePath;
});

// The preset library lives in the app's settings folder, shared by every project.
const libraryPath = () => path.join(app.getPath('userData'), 'preset-library.json');

ipcMain.handle('library-load', async () => {
  try {
    return await fs.readFile(libraryPath(), 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('library-save', async (_e, text) => {
  // Write to a temp file then rename, so a crash mid-save can't corrupt the library.
  const target = libraryPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', text, 'utf8');
  await fs.rename(target + '.tmp', target);
  return true;
});

ipcMain.on('set-title', (_e, title) => {
  if (mainWindow) mainWindow.setTitle(title);
});

// Double-clicking a .nesmm file (macOS) or passing it on the command line (Windows/Linux).
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  pendingOpenPath = filePath;
  if (mainWindow) mainWindow.webContents.reload();
});
const argFile = process.argv.slice(1).find((a) => a.endsWith('.nesmm'));
if (argFile) pendingOpenPath = argFile;

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.normalize(path.join(distDir, decodeURIComponent(pathname)));
    if (!filePath.startsWith(distDir)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
  // The app only needs MIDI devices (Web MIDI); refuse every other permission.
  // Electron reports Web MIDI requests as 'midiSysex' even when sysex isn't asked for.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'midi' || permission === 'midiSysex'));
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
