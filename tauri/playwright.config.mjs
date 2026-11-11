import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 420, height: 800 },
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: false,
  },
})
