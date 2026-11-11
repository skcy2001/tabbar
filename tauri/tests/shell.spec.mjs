import { expect, test } from '@playwright/test'

const initial = {
  tabs: [{ id: 1, title: '(3) Example', url: 'https://example.com/', pinId: 'site-a', faviconDataUrl: null, canGoBack: true, canGoForward: false, unreadCount: 3 },
    { id: 2, title: 'Second', url: 'https://example.org/', pinId: null, faviconDataUrl: null, canGoBack: false, canGoForward: false }],
  active: 1, collapsed: false, fullscreen: false, playerTarget: 1,
  settings: { side: 'right', paneWidth: 364, pins: [{ id: 'site-a', title: 'Example pin', url: 'https://example.com/', faviconDataUrl: null }] },
  downloads: [{id: 7, filename: 'report.txt', url: 'https://example.com/report.txt', savePath: 'C:/Downloads/report.txt', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 1}],
}
async function mount(page, role = 'pane', options = {}) {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/src/bridge.ts', async route => {
    const response = await route.fetch()
    await route.fulfill({response, body: `
      import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
      import { emit } from '/node_modules/@tauri-apps/api/event.js';
      window.testHost = { state: ${JSON.stringify(initial)}, actions: [], queries: [], fail: false, pendingMedia: {}, ...${JSON.stringify(options)} };
      window.testHost.update = async state => { window.testHost.state = state; await emit('browser-state', state) };
      mockIPC(async (command, args) => {
        const h=window.testHost;
        if(command==='get_state') return h.state;
        if(command==='act') { h.actions.push(args.action); if(h.fail) throw new Error('Native operation failed'); return null; }
        if(command==='query') {
          h.queries.push(args);
          if(args.kind==='media' && h.deferMedia) return new Promise(resolve=>h.pendingMedia[args.id]=resolve);
          if(['playPause','nextTrack','mute'].includes(args.kind)) {
            if(h.failControls) throw new Error('The website could not perform this media action');
            if(h.deferControls) return new Promise(resolve=>h.finishControl=resolve);
            return args.kind==='playPause'?null:true;
          }
          return args.kind==='media' ? {tabId:args.id,title:args.id===1?'A song':'Second song',artist:'Artist',sourceTitle:'Example',artworkUrl:h.artworks?.[args.id]??null,hasMedia:true,canPlayPause:true,canNextTrack:true,canMute:true,isPlaying:true,isMuted:false,...h.mediaFlags} : null;
        }
        throw new Error('Unexpected native command: '+command);
      }, {shouldMockEvents:true});
    ` + await response.text()})
  })
  await page.goto('/?role=' + role)
  await expect.poll(() => page.evaluate(() => !!window.sidebarApi)).toBe(true)
  return errors
}
test('address edits survive incoming title updates and navigation uses the shared toolbar', async ({page}) => {
  const errors=await mount(page)
  await page.locator('.toolbar').hover()
  await page.locator('.url-display').click()
  const input=page.locator('.url-input')
  await input.fill('new search terms')
  await page.evaluate(() => {const s=structuredClone(window.testHost.state);s.tabs[0].title='Changed';return window.testHost.update(s)})
  await expect(input).toHaveValue('new search terms')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(() => window.testHost.actions.some(a=>a.type==='navigate'&&a.url==='new search terms'))).toBe(true)
  await expect(page.getByRole('button',{name:'Go back',exact:true})).toBeEnabled()
  await expect(page.getByRole('button',{name:'Go forward',exact:true})).toBeDisabled()
  expect(errors).toEqual([])
})
test('original ribbon shows imported pins and unread badges, with native site menus',async({page})=>{
  const errors=await mount(page,'ribbon')
  await page.setViewportSize({width:56,height:800})
  await expect(page.getByRole('button',{name:'Example pin',exact:true})).toBeVisible()
  await expect(page.locator('.tab-unread-count')).toHaveText('3')
  await page.getByRole('button',{name:'Example pin',exact:true}).click({button:'right'})
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.some(a=>a.type==='menu'&&a.siteId==='site-a'))).toBe(true)
  await page.getByRole('button',{name:'New tab',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.some(a=>a.type==='create'))).toBe(true)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(56)
  expect(errors).toEqual([])
})

test('ribbon, pin, and tab context menus preserve the original click position', async ({page}) => {
  await mount(page, 'ribbon')
  await page.setViewportSize({width:56,height:800})
  for (const [selector, target] of [
    ['.pinned-site-btn', {siteId:'site-a'}],
    ['.tab-item', {id:2}],
    ['.tab-strip', {}],
  ]) {
    // Moving the pointer immediately afterward must not replace the click
    // coordinates with wherever the native popup eventually opens.
    await page.locator(selector).first().evaluate(el => {
      window.testHost.actions = []
      el.dispatchEvent(new MouseEvent('contextmenu', {clientX:19,clientY:237,button:2,bubbles:true}))
    })
    await page.mouse.move(1,799)
    await expect.poll(() => page.evaluate(() => window.testHost.actions.filter(a=>a.type==='menu').at(-1))).toEqual({type:'menu',...target,x:19,y:237})
  }
})
test('downloads panel opens completed files and clears history through the native bridge',async({page})=>{
  const errors=await mount(page,'downloads')
  await expect(page.getByText('report.txt',{exact:true})).toBeVisible()
  await page.getByTitle('Open report.txt',{exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.some(a=>a.type==='openDownload'&&a.id===7))).toBe(true)
  expect(errors).toEqual([])
})
test('player uses metadata and media controls; fullscreen is available without shortcuts',async({page})=>{
  const errors=await mount(page,'player')
  await expect(page.getByText('A song',{exact:true}).first()).toBeVisible()
  await page.getByRole('button',{name:'Pause',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.testHost.queries.some(a=>a.kind==='playPause'&&a.id===1))).toBe(true)
  expect(errors).toEqual([])
})
test('native failures are visible, and pane geometry leaves room for the native page',async({page})=>{
  await mount(page)
  await page.getByRole('button',{name:'Toggle fullscreen',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.some(a=>a.type==='fullscreen'))).toBe(true)
  const bounds=await page.locator('.toolbar').boundingBox()
  expect(bounds.height).toBe(44)
  await page.evaluate(()=>window.testHost.fail=true)
  await page.locator('.toolbar').hover()
  await page.getByRole('button',{name:'Reload',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Native operation failed')
  await page.getByRole('alert').click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('player shows the correct media artwork without screenshots or a close button and dismisses on mouse-out',async({page})=>{
  const oldImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>')
  const newImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"><rect width="400" height="1600" fill="green"/></svg>')
  const errors=await mount(page,'player',{deferMedia:true,artworks:{2:newImage}})
  await page.setViewportSize({width:300,height:300})
  await expect.poll(()=>page.evaluate(()=>typeof window.testHost.pendingMedia[1])).toBe('function')
  await page.evaluate(()=>{const s=structuredClone(window.testHost.state);s.playerTarget=2;return window.testHost.update(s)})
  await expect.poll(()=>page.evaluate(()=>typeof window.testHost.pendingMedia[2])).toBe('function')
  await page.evaluate(image=>window.testHost.pendingMedia[1]({tabId:1,title:'A song',artworkUrl:image}),oldImage)
  await expect(page.getByAltText('Media artwork')).toHaveCount(0)
  await expect(page.getByText('A song',{exact:true})).toHaveCount(0)
  await page.evaluate(image=>{window.testHost.pendingMedia[2]({tabId:2,title:'Second song',artworkUrl:image,isPlaying:true});window.testHost.deferMedia=false},newImage)
  await expect(page.getByAltText('Media artwork')).toHaveAttribute('src',newImage)
  await expect(page.getByText('Second song',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Close preview',exact:true})).toHaveCount(0)
  await expect.poll(async()=>(await page.locator('.player-shell').boundingBox()).height).toBeLessThan(260)
  const frame=await page.locator('.player-thumbnail').boundingBox()
  const imageBounds=await page.getByAltText('Media artwork').boundingBox()
  expect(imageBounds.height).toBeLessThanOrEqual(frame.height)
  await page.getByRole('button',{name:'Pause',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.testHost.queries.some(q=>q.kind==='playPause'&&q.id===2))).toBe(true)
  await page.mouse.move(299,299)
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.some(a=>a.type==='hidePlayer'))).toBe(true)
  await page.evaluate(()=>{const s=structuredClone(window.testHost.state);s.playerTarget=null;return window.testHost.update(s)})
  await expect(page.getByAltText('Media artwork')).toHaveCount(0)
  const count=await page.evaluate(()=>window.testHost.queries.length)
  await page.waitForTimeout(1200)
  expect(await page.evaluate(()=>window.testHost.queries.length)).toBe(count)
  expect(await page.evaluate(()=>window.testHost.queries.some(q=>q.kind==='preview'))).toBe(false)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(300)
  expect(errors).toEqual([])
})

test('passing over a media tab does not open its preview after the pointer has left',async({page})=>{
  const errors=await mount(page,'ribbon')
  await page.setViewportSize({width:56,height:800})
  await page.evaluate(()=>{const s=structuredClone(window.testHost.state);s.collapsed=true;s.tabs[0].hasMedia=true;s.tabs[1].hasMedia=true;return window.testHost.update(s)})
  const first=page.getByRole('button',{name:'Example pin',exact:true})
  // Cross both tabs in one browser task, rather than letting Playwright's
  // actionability waits accidentally exceed the intentional 100ms dwell.
  await first.evaluate(node=>{
    const second=document.querySelector('[data-tab-id="2"]')
    node.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))
    node.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:second}))
    second.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:node}))
  })
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.filter(a=>a.type==='showPlayer').map(a=>a.id))).toEqual([2])
  await first.hover()
  await expect.poll(()=>page.evaluate(()=>window.testHost.actions.filter(a=>a.type==='showPlayer').at(-1)?.id)).toBe(1)
  expect(errors).toEqual([])
})

test('media buttons serialize actions and keep failures inside the player',async({page})=>{
  const errors=await mount(page,'player',{deferControls:true})
  const pause=page.getByRole('button',{name:'Pause',exact:true})
  await expect(pause).toBeEnabled()
  await pause.click()
  await pause.dispatchEvent('click')
  await expect(pause).toBeDisabled()
  await expect(page.getByRole('button',{name:'Next',exact:true})).toBeDisabled()
  await expect(page.getByRole('button',{name:'Mute',exact:true})).toBeDisabled()
  expect(await page.evaluate(()=>window.testHost.queries.filter(q=>q.kind==='playPause').length)).toBe(1)
  await page.evaluate(()=>{window.testHost.deferControls=false;window.testHost.finishControl(null)})
  await expect(pause).toBeEnabled()
  await page.evaluate(()=>window.testHost.failControls=true)
  await pause.click()
  await expect(page.getByRole('status')).toContainText('Open the tab')
  await expect(page.locator('#native-error')).toHaveCount(0)
  await expect(pause).toBeEnabled()
  await page.evaluate(()=>window.testHost.failControls=false)
  await pause.click()
  await expect(page.getByRole('status')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('unsupported media actions stay disabled and stale polling cannot undo an action',async({page})=>{
  await mount(page,'player',{mediaFlags:{canNextTrack:false}})
  const pause=page.getByRole('button',{name:'Pause',exact:true})
  await expect(pause).toBeEnabled()
  await expect(page.getByRole('button',{name:'Next',exact:true})).toBeDisabled()
  await page.evaluate(()=>window.testHost.deferMedia=true)
  await expect.poll(()=>page.evaluate(()=>typeof window.testHost.pendingMedia[1])).toBe('function')
  await page.evaluate(()=>{window.testHost.stalePoll=window.testHost.pendingMedia[1];window.testHost.deferMedia=false;window.testHost.mediaFlags.isPlaying=false})
  await pause.click()
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeEnabled()
  await page.evaluate(()=>window.testHost.stalePoll({tabId:1,title:'Stale',hasMedia:true,isPlaying:true}))
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeEnabled()
  await expect(page.getByText('Stale',{exact:true})).toHaveCount(0)
})

test('a stale audio flag cannot open a player without a playable track',async({page})=>{
  await mount(page,'ribbon')
  await page.setViewportSize({width:56,height:800})
  await page.evaluate(()=>{const s=structuredClone(window.testHost.state);s.collapsed=true;s.tabs[0].hasMedia=false;s.tabs[0].isAudioPlaying=true;return window.testHost.update(s)})
  await page.getByRole('button',{name:'Example pin',exact:true}).hover()
  await page.waitForTimeout(250)
  expect(await page.evaluate(()=>window.testHost.actions.some(a=>a.type==='showPlayer'))).toBe(false)
})
