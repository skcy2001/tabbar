/**
 * Turns a launch request — a command-line argument, or a `tabbar://` link
 * handed over by Windows — into a web URL to open.
 *
 * Kept free of any `electron` import so it can be exercised outside the
 * Electron runtime.
 */

export const LAUNCH_PROTOCOLS = ['tabbar', 'sidebar'] as const

/**
 * Normalises one raw launch argument.
 *
 * Accepts `https://example.com`, `tabbar://example.com`, and
 * `tabbar://https://example.com`. Returns null for anything that is not http(s)
 * once normalised: these arguments arrive from outside the app, so schemes like
 * `file:` or `javascript:` must never reach a tab.
 *
 * A bare host with no scheme is rejected rather than guessed at — on a command
 * line that is far more likely to be a file path than a URL.
 */
export function normalizeLaunchUrl(raw?: string | null): string | null {
  if (!raw) return null
  let value = raw.trim()
  if (!value) return null

  const prefix = LAUNCH_PROTOCOLS.map(scheme => `${scheme}://`).find(prefix => value.toLowerCase().startsWith(prefix))
  if (prefix) {
    value = value.slice(prefix.length)
    if (!value) return null
    // `tabbar://example.com` means https; `tabbar://http://x` keeps its scheme.
    if (!/^https?:\/\//i.test(value)) {
      if (value.includes('://')) return null
      value = `https://${value}`
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.toString()
}

/**
 * True when two URLs address the same site, ignoring a leading `www.`.
 *
 * Used to route an incoming link into the pinned site that already owns its
 * host rather than opening a second tab for it.
 */
export function isSameHost(a: string, b: string): boolean {
  const host = (value: string) => {
    try {
      return new URL(value).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return null
    }
  }
  const hostA = host(a)
  return hostA !== null && hostA === host(b)
}

/**
 * Picks the URL out of an argv list.
 *
 * Windows appends protocol launches as a trailing argument, so scan from the
 * end. Index 0 is the executable, switches are skipped, and in development the
 * `.` Electron is pointed at simply fails to normalise.
 */
export function urlFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    const url = normalizeLaunchUrl(arg)
    if (url) return url
  }
  return null
}
