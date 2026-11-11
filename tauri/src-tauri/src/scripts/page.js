(() => {
  const update = () => {
    const css = document.createElement('style');
    css.textContent = '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}';
    document.head?.append(css);
    const icon = document.querySelector('link[rel~="icon"]')?.href || new URL('/favicon.ico', location.href).href;
    window.__sidebarFavicon = /^https?:/.test(icon) ? icon : null;
    fetch(icon).then(r => r.ok ? r.blob() : Promise.reject()).then(blob => {
      if (!blob.type.startsWith('image/') || blob.size > 256000) return;
      const reader = new FileReader(); reader.onload = () => { window.__sidebarFavicon = reader.result }; reader.readAsDataURL(blob);
    }).catch(() => {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update, {once:true}); else update();
})();
