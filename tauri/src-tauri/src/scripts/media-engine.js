(() => {
  const previews = 'ytd-video-preview, ytd-thumbnail, ytd-rich-item-renderer, ytd-reel-item-renderer';
  const shelves = 'ytmusic-carousel-shelf-renderer, [class*="carousel"], [class*="shelf"], [role="list"], [role="listbox"], [role="tablist"]';
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const usable = el => visible(el) && !el.closest('[disabled], [aria-disabled="true"], [inert]')
    && !el.classList.contains('disabled') && !el.closest(shelves);
  const select = () => {
    const youtube = /(^|\.)youtube\.com$/.test(location.hostname) && location.hostname !== 'music.youtube.com';
    const watchPage = (location.pathname === '/watch' && new URL(location.href).searchParams.has('v'))
      || /^\/(shorts|embed|live)\//.test(location.pathname);
    const metadata = navigator.mediaSession?.metadata;
    const candidates = Array.from(document.querySelectorAll('audio,video')).filter(el => {
      if (!el.isConnected || el.error || el.ended || el.closest(previews)) return false;
      const source = el.currentSrc || el.getAttribute('src') || el.srcObject;
      if (!source || el.readyState < 1 || !(el.duration > 0 || el.srcObject)) return false;
      if (youtube && !watchPage && !visible(el.closest('ytd-miniplayer'))) return false;
      const primary = el.closest('.html5-video-player, ytmusic-player, [data-testid="player"]');
      // Decorative autoplay loops and recommendation previews are not a track.
      if (!primary && el.muted && el.loop && el.autoplay && !el.controls && !metadata?.title) return false;
      return !el.paused || el.currentTime > 0 || el.controls || !!primary || !!metadata?.title;
    });
    const score = el => (!el.paused ? 100 : 0) + (!el.muted && el.volume > 0 ? 20 : 0)
      + (el.currentTime > 0 ? 10 : 0) + (el.closest('.html5-video-player, ytmusic-player') ? 5 : 0);
    return candidates.sort((a, b) => score(b) - score(a))[0] || null;
  };
  const nextButton = active => {
    if (!active) return null;
    const known = [
      'ytmusic-player-bar .next-button', '.ytmusic-player-controls.next-button',
      '.ytp-chrome-controls .ytp-next-button', '[data-testid="control-button-skip-forward"]',
      '.playControls .skipControl__next', '[aria-label="Next track" i]', '[aria-label="Next song" i]',
    ];
    for (const selector of known) {
      const button = Array.from(document.querySelectorAll(selector)).find(usable);
      if (button) return button;
    }
    return null;
  };
  const info = () => {
    const active = select();
    const metadata = active ? navigator.mediaSession?.metadata : null;
    const artwork = Array.from(metadata?.artwork || []).flatMap(item => {
      try {
        const url = new URL(item.src, location.href);
        if (!['https:', 'http:', 'data:', 'blob:'].includes(url.protocol)) return [];
        const size = Math.max(0, ...String(item.sizes || '').split(/\s+/).map(s => {
          const match = /^(\d+)x(\d+)$/.exec(s);
          return match ? Number(match[1]) * Number(match[2]) : 0;
        }));
        return [{src:url.href,size}];
      } catch { return []; }
    }).sort((a,b) => b.size - a.size);
    return {
      pageUrl: location.href,
      hasMedia: !!active,
      canPlayPause: !!active,
      canNextTrack: !!nextButton(active),
      canMute: !!active,
      isPlaying: !!active && !active.paused && !active.ended,
      title: metadata?.title || active?.getAttribute('title') || active?.getAttribute('aria-label') || '',
      artist: metadata?.artist || '',
      album: metadata?.album || '',
      artworkUrl: artwork[0]?.src || active?.poster || null,
    };
  };
  const toggle = async () => {
    const active = select();
    if (!active) return {ok:false, reason:'unavailable'};
    if (!active.paused) { active.pause(); return {ok:true}; }
    let timeout;
    try {
      await Promise.race([
        active.play(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 4000); }),
      ]);
      return {ok:!active.paused};
    } catch (error) {
      return {ok:false, reason:error?.name === 'NotAllowedError' ? 'blocked' : 'unavailable'};
    } finally { clearTimeout(timeout); }
  };
  return {
    info,
    status: () => ({hasMedia:!!select(), pageUrl:location.href, favicon:window.__sidebarFavicon || null}),
    toggle,
    next: () => {
      const button = nextButton(select());
      if (!button) return false;
      button.click();
      return true;
    },
  };
})()
