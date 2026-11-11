import { spawn } from 'node:child_process'
import electronPath from 'electron'

const VITE_URL = 'http://127.0.0.1:5173'

const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  {
  stdio: 'inherit',
  },
)

let electron
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  electron?.kill()
  vite.kill()
  process.exit(exitCode)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

vite.on('exit', code => {
  if (!shuttingDown) shutdown(code ?? 1)
})

try {
  await waitForServer(VITE_URL)

  // Handing the URL over is also what tells the main process this is a dev run;
  // it has no other way to tell itself apart from `npm start`.
  electron = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, TABBAR_DEV_SERVER_URL: VITE_URL },
  })

  console.log(`[dev] Electron started with pid ${electron.pid}`)
  electron.on('error', error => {
    console.error('[dev] Electron failed to start', error)
    shutdown(1)
  })
  electron.on('exit', (code, signal) => {
    console.log(`[dev] Electron exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`)
    shutdown(code ?? 0)
  })
} catch (error) {
  console.error(error.message)
  shutdown(1)
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  throw new Error(`Timed out waiting for ${url}`)
}
