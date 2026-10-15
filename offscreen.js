/* Media fetched here: each redirect, response body and final filename is checked. */
'use strict';
const activeBlobs=new Map(),MAX_BYTES=650*1024*1024;
let allocatedBytes=0,busy=false;
async function fetchMedia(url,signal) {
  let current=RyzexDownloadPolicy.mediaUrl(url);
  if(!current)throw new Error('Media address is not allowed.');
  {
    let response;
    // Gateway resolved the redirects immediately before this fetch. Any later
    // redirect is rejected by Chromium before it contacts the new destination.
    try {response=await fetch(current,{signal,credentials:'omit',redirect:'error',cache:'no-store'});}
    catch(error){if(signal.aborted)throw error;throw new Error('Could not connect to the media server.');}
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel().catch(()=>{});
      throw new Error('Media redirected again; transfer stopped safely.');
    }
    if(response.type==='opaqueredirect'||response.status===0)throw new Error('Media redirect could not be verified.');
    if(response.url&&!RyzexDownloadPolicy.mediaUrl(response.url))throw new Error('Unsafe final media address.');
    return response;
  }
}
async function fetchAsBlob(url,jobId,file={}) {
  if(!RyzexDownloadPolicy.mediaUrl(url))throw new Error('Media address is not allowed.');
  if(RyzexDownloadPolicy.dangerousFile({...file,url}))throw new Error('Unsafe file type blocked.');
  if(busy)throw new Error('A media transfer is already running.');busy=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),180000);
  let received=0,retained=false,response;
  try {
    for(let attempt=0;attempt<2;attempt++) {
      response=await fetchMedia(url,controller.signal);if(response.ok)break;
      if(attempt===0&&[500,502,503,504].includes(response.status)) {
        await response.body?.cancel().catch(()=>{});await new Promise(resolve=>setTimeout(resolve,1100));continue;
      }break;
    }
    if(!response?.ok) {
      await response?.body?.cancel().catch(()=>{});
      if(response?.status===500)throw new Error('Media tunnel returned HTTP 500. Check Render server logs.');
      throw new Error('Media server returned HTTP '+(response?.status||'network')+'.');
    }
    const disposition=response.headers.get('content-disposition')||'';
    const names=[...disposition.matchAll(/filename\*?\s*=\s*(?:"([^"]*)"|([^;]+))/gi)].map(m=>(m[1]||m[2]||'').replace(/^UTF-8''/i,''));
    if(names.some(name=>RyzexDownloadPolicy.dangerousName(name)))throw new Error('Unsafe server filename blocked.');
    const mime=(response.headers.get('content-type')||'application/octet-stream').split(';',1)[0].trim().toLowerCase();
    if(!RyzexDownloadPolicy.acceptedMime(mime))throw new Error('The server returned an untrusted content type instead of media.');
    const rawSize=Number(response.headers.get('content-length'))||0;
    if(rawSize>MAX_BYTES-allocatedBytes)throw new Error('Media exceeds the total temporary memory limit (650 MB).');
    if(!response.body)throw new Error('No media stream received from the server.');
    const reader=response.body.getReader(),chunks=[];let last=0,prefix=new Uint8Array(0);
    try {
      for(;;) {
        const {done,value}=await reader.read();if(done)break;
        if(value.byteLength>MAX_BYTES-allocatedBytes)throw new Error('Media exceeded the 650 MB size limit.');
        received+=value.byteLength;allocatedBytes+=value.byteLength;chunks.push(value);
        if(prefix.length<512){const next=new Uint8Array(Math.min(512,prefix.length+value.byteLength));next.set(prefix);next.set(value.slice(0,next.length-prefix.length),prefix.length);prefix=next;}
        if(RyzexDownloadPolicy.badPrefix(prefix))throw new Error('Server returned an error page or executable content instead of media.');
        const now=Date.now();if(now-last>420){last=now;chrome.runtime.sendMessage({type:'RYZEX_OFFSCREEN_PROGRESS',jobId,percent:rawSize?Math.min(99,Math.floor(received/rawSize*100)):null}).catch(()=>{});}
      }
    } catch(error){await reader.cancel().catch(()=>{});throw error;}
    if(!received)throw new Error('Server returned an empty media file.');
    if(rawSize&&!response.headers.get('content-encoding')&&received!==rawSize)throw new Error('Media transfer was incomplete.');
    const blob=new Blob(chunks,{type:mime}),blobUrl=URL.createObjectURL(blob);
    activeBlobs.set(blobUrl,{blob,size:received});retained=true;return {ok:true,blobUrl,size:received,mime};
  } catch(error) {throw new Error(controller.signal.aborted?'Media transfer timed out.':error?.message||'Media transfer failed.');}
  finally {
    if(!retained){allocatedBytes-=received;if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
    busy=false;clearTimeout(timeout);
  }
}
// Separate Instagram post DASH handler. No screen recording; native byte transfer.
const MAX_DASH_BYTES=120*1024*1024;
async function dashFetchBytes(url,signal){
  const clean=RyzexDashCore.cleanUrl(url);
  if(!clean||!RyzexDownloadPolicy.mediaUrl(url))throw Error('Not a trusted CDN address.');
  // Redirect is intentionally forbidden, as in the existing downloader.
  const r=await fetch(url,{credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(!r.ok)throw Error('Instagram CDN HTTP '+r.status);
  const len=Number(r.headers.get('content-length'))||0;
  if(len>MAX_DASH_BYTES)throw Error('Video file is too large.');
  const b=new Uint8Array(await r.arrayBuffer());
  if(b.length>MAX_DASH_BYTES||RyzexDownloadPolicy.badPrefix(b.slice(0,512)))throw Error('Invalid media data.');
  const size=Number((r.headers.get('content-range')||'').match(/\/(\d+)$/)?.[1])||0;
  return {data:b,total:size};
}
function dashComplete(b){
  try {const box=RyzexDashCore.boxes(b);return ['ftyp','moov','moof','mdat'].every(t=>box.some(x=>x.type===t));}
  catch{return false;}
}
async function dashAsset(url,signal){
  let initial=null;
  try {initial=await dashFetchBytes(url,signal);}catch{}
  const m=RyzexDashCore.decodeMeta(url)||{};
  const estimate=(Number(m.bitrate)||0)*(Number(m.duration_s)||0)/8;
  if(initial&&dashComplete(initial.data)&&
    ((estimate>0&&initial.data.length>=estimate*.65)||
      (initial.total>0&&initial.total===initial.data.length)))return initial.data;
  const chunks=[],CHUNK=256*1024,MAX_CALLS=400;
  let cursor=0,total=0;
  for(let i=0;i<MAX_CALLS;i++){
    if(cursor>MAX_DASH_BYTES)throw Error('DASH media is too large.');
    const x=new URL(url);
    x.searchParams.set('bytestart',String(cursor));
    x.searchParams.set('byteend',String(total?Math.min(total-1,cursor+CHUNK-1):cursor+CHUNK-1));
    const v=await dashFetchBytes(x.href,signal);
    if(!v.data.length)throw Error('Empty DASH segment.');
    if(v.total&&v.total<=MAX_DASH_BYTES)total=v.total;
    if(v.data.length>CHUNK+8192)throw Error('CDN returned an unexpected segment size.');
    chunks.push(v.data);cursor+=v.data.length;
    if(total&&cursor>=total)break;
    if(!total&&v.data.length<CHUNK)break;
  }
  const len=chunks.reduce((a,c)=>a+c.length,0);
  if(len>MAX_DASH_BYTES)throw Error('DASH media is too large.');
  const b=new Uint8Array(len);let n=0;for(const c of chunks){b.set(c,n);n+=c.length;}
  if(!dashComplete(b))throw Error('Instagram CDN did not provide a complete MP4.');
  return b;
}
async function instagramDashFetch(video,audio,jobId){
  if(busy)throw Error('A media transfer is already running.');
  if(![video,audio].every(x=>typeof x==='string'&&
      RyzexDashCore.cleanUrl(x)===x&&RyzexDownloadPolicy.mediaUrl(x)===x))
    throw Error('DASH media link is unsafe.');
  busy=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
  try{
    const v=await dashAsset(video,controller.signal);
    const a=await dashAsset(audio,controller.signal);
    const merged=RyzexDashCore.remux(v,a);
    if(merged.length>MAX_DASH_BYTES)throw Error('Merged MP4 is too large.');
    const blob=new Blob([merged],{type:'video/mp4'});
    const blobUrl=URL.createObjectURL(blob);
    activeBlobs.set(blobUrl,{blob,size:blob.size});allocatedBytes+=blob.size;
    return {ok:true,blobUrl,mime:'video/mp4',size:blob.size};
  }catch(e){throw Error(controller.signal.aborted?'DASH download timed out.':e.message||'DASH download failed.');}
  finally{busy=false;clearTimeout(timer);}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.tab||sender.url!==chrome.runtime.getURL('background.js'))return false;
  if(message?.type==='RYZEX_INSTAGRAM_DASH_FETCH') {
    if(typeof message.jobId!=='string'||message.jobId.length>80){respond({ok:false,error:'Invalid DASH job.'});return false;}
    instagramDashFetch(message.video,message.audio,message.jobId).then(respond,e=>respond({ok:false,error:e.message}));return true;
  }
  if(message?.type==='RYZEX_OFFSCREEN_FETCH') {
    if(typeof message.jobId!=='string'||message.jobId.length>80){respond({ok:false,error:'Invalid media job.'});return false;}
    fetchAsBlob(message.url,message.jobId,{filename:message.filename,mime:message.mime}).then(respond,e=>respond({ok:false,error:e.message}));return true;
  }
  if(message?.type==='RYZEX_OFFSCREEN_RELEASE') {
    const entry=activeBlobs.get(message.blobUrl);
    if(entry){URL.revokeObjectURL(message.blobUrl);allocatedBytes-=entry.size;activeBlobs.delete(message.blobUrl);}respond({ok:true});return false;
  }return false;
});
