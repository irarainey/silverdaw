import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

let backendProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

function startBackend(): void {
  // In dev: JUCE's juce_add_console_app outputs to
  //   <repo>/backend/build/JackdawBackend_artefacts/<Config>/JackdawBackend.exe
  // In a packaged build this path will need to be re-resolved.
  const exeName = process.platform === 'win32' ? 'JackdawBackend.exe' : 'JackdawBackend'
  const buildConfig = process.env['JACKDAW_BACKEND_CONFIG'] ?? 'Debug'
  const exePath = join(
    __dirname,
    '..',
    '..',
    '..',
    'backend',
    'build',
    'JackdawBackend_artefacts',
    buildConfig,
    exeName
  )

  backendProcess = spawn(exePath, [], { stdio: 'inherit' })

  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`)
    backendProcess = null
  })

  backendProcess.on('error', (err) => {
    console.error('[backend] failed to start:', err)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#111827',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

app.whenReady().then(() => {
  startBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
})
