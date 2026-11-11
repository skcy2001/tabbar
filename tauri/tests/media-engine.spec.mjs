import {readFileSync} from 'node:fs'
import {test,expect} from '@playwright/test'

const engine=readFileSync(new URL('../src-tauri/src/scripts/media-engine.js',import.meta.url),'utf8')
const run=(page,method)=>page.evaluate(({engine,method})=>(0,eval)(engine)[method](),{engine,method})
async function fixture(page,url='https://www.youtube.com/watch?v=test') {
  await page.route('https://www.youtube.com/**',route=>route.fulfill({contentType:'text/html',body:`<video id="empty"></video><div class="html5-video-player"><video id="main"></video><div class="ytp-chrome-controls"><button class="ytp-next-button" disabled>Next</button></div></div><div class="carousel"><button aria-label="Next track" onclick="window.carouselClicked=true">Next</button></div>`}))
  await page.goto(url)
  await page.evaluate(()=>{
    navigator.mediaSession.metadata=new MediaMetadata({title:'Old metadata',artwork:[{src:'https://example.com/art.png',sizes:'300x300'}]})
    window.track={source:'',ready:0,duration:NaN,paused:true,ended:false,error:null,time:0}
    const el=document.querySelector('#main')
    for(const [key,value] of Object.entries({currentSrc:'source',readyState:'ready',duration:'duration',paused:'paused',ended:'ended',error:'error',currentTime:'time'}))
      Object.defineProperty(el,key,{get:()=>window.track[value],configurable:true})
    el.play=async()=>{window.playedElement='main';window.track.paused=false}
    el.pause=()=>{window.pausedElement='main';window.track.paused=true}
    document.querySelector('.ytp-next-button').onclick=()=>window.nextClicked=true
  })
}
const load=page=>page.evaluate(()=>Object.assign(window.track,{source:'https://example.com/track.mp4',ready:2,duration:120}))

test('empty, unloaded, ended and failed players do not inherit stale media metadata',async({page})=>{
  await fixture(page)
  for(const state of [{},{source:'https://example.com/track.mp4'},{ready:2,duration:120,error:{code:4}},{error:null,ended:true}]) {
    await page.evaluate(state=>Object.assign(window.track,state),state)
    const info=await run(page,'info')
    expect(info.hasMedia).toBe(false)
    expect(info.canPlayPause).toBe(false)
    expect(info.title).toBe('')
    expect(info.artworkUrl).toBeNull()
    expect((await run(page,'status')).hasMedia).toBe(false)
    expect((await run(page,'toggle')).ok).toBe(false)
  }
  expect(await page.evaluate(()=>window.playedElement)).toBeUndefined()
})

test('YouTube home does not advertise its idle player or recommendation videos',async({page})=>{
  await fixture(page,'https://www.youtube.com/')
  await load(page)
  expect((await run(page,'info')).hasMedia).toBe(false)
  await page.evaluate(()=>history.pushState({},'', '/watch?v=test'))
  expect((await run(page,'info')).hasMedia).toBe(true)
  await page.evaluate(()=>{const preview=document.createElement('ytd-video-preview');document.body.append(preview);preview.append(document.querySelector('#main'))})
  expect((await run(page,'info')).hasMedia).toBe(false)
})

test('controls target the loaded player, retain paused playback, and ignore unrelated next arrows',async({page})=>{
  await fixture(page)
  await load(page)
  expect((await run(page,'info')).hasMedia).toBe(true)
  expect((await run(page,'info')).canNextTrack).toBe(false)
  expect(await run(page,'next')).toBe(false)
  expect((await run(page,'toggle')).ok).toBe(true)
  expect((await run(page,'info')).isPlaying).toBe(true)
  expect(await page.evaluate(()=>window.playedElement)).toBe('main')
  expect((await run(page,'toggle')).ok).toBe(true)
  expect((await run(page,'info')).isPlaying).toBe(false)
  expect((await run(page,'info')).hasMedia).toBe(true)
  await page.evaluate(()=>document.querySelector('.ytp-next-button').disabled=false)
  expect((await run(page,'info')).canNextTrack).toBe(true)
  expect(await run(page,'next')).toBe(true)
  expect(await page.evaluate(()=>window.nextClicked)).toBe(true)
  expect(await page.evaluate(()=>window.carouselClicked)).toBeUndefined()
  await page.evaluate(()=>history.pushState({},'','/'))
  expect((await run(page,'status')).hasMedia).toBe(false)
})

test('rejected play promises are handled and a later valid action can recover',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await fixture(page);await load(page)
  await page.evaluate(()=>document.querySelector('#main').play=()=>Promise.reject(new DOMException('Blocked','NotAllowedError')))
  expect(await run(page,'toggle')).toEqual({ok:false,reason:'blocked'})
  expect((await run(page,'info')).isPlaying).toBe(false)
  await page.evaluate(()=>document.querySelector('#main').play=async()=>{window.track.paused=false})
  expect((await run(page,'toggle')).ok).toBe(true)
  expect(errors).toEqual([])
})
