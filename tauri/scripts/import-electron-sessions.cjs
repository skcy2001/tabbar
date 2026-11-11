// Run with the repository's Electron executable while the Electron Tabbar is
// closed. Nothing sensitive is printed or written as plaintext. Windows DPAPI
// binds each one-time transfer file to the current Windows account.
const { app, session } = require('electron')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const profile = path.join(process.env.APPDATA, 'sidebar')
app.setPath('userData', profile)
app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) throw new Error('Close Electron Tabbar before importing sessions')
  const pins = JSON.parse(fs.readFileSync(path.join(profile, 'pinned-sites.json'), 'utf8'))
  const partitions = new Set(['persist:sidebar-browser', ...pins.map(p => p.partition).filter(Boolean)])
  const target = path.join(process.env.LOCALAPPDATA, 'com.samya.sidebar.tauri', 'migration')
  fs.mkdirSync(target, { recursive: true })
  let total = 0
  for (const partition of partitions) {
    const cookies = await session.fromPartition(partition).cookies.get({})
    const protectedBytes = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted))"],
      { input: JSON.stringify(cookies), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    fs.writeFileSync(path.join(target, Buffer.from(partition).toString('hex') + '.bin'), Buffer.from(protectedBytes, 'base64'))
    total += cookies.length
  }
  console.log(JSON.stringify({ profiles: partitions.size, cookiesPrepared: total, encrypted: true }))
  app.quit()
}).catch(error => { console.error(error.message); app.exit(1) })
