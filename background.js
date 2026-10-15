/* Ryzex Story DASH core: purely local ISO-BMFF remux. No credentials, no remote libraries. */
(function(root, factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.RyzexDashCore=api;
})(typeof globalThis!=='undefined'?globalThis:this, function(){
'use strict';
const decoder=new TextDecoder('ascii');
function read32(b,p){return (b[p]*0x1000000+(b[p+1]<<16)+(b[p+2]<<8)+b[p+3])>>>0;}
function put32(b,p,n){b[p]=(n>>>24)&255;b[p+1]=(n>>>16)&255;b[p+2]=(n>>>8)&255;b[p+3]=n&255;}
function str(b,p,n=4){return decoder.decode(b.subarray(p,p+n));}
function boxes(b,from=0,to=b.length){
 const result=[];let p=from;
 while(p+8<=to){let size=read32(b,p),head=8;const type=str(b,p+4);
  if(size===1){if(p+16>to)throw Error('mp4_box_truncated');const high=read32(b,p+8),low=read32(b,p+12);size=high*0x100000000+low;head=16;}
  if(size===0)size=to-p;
  if(!Number.isSafeInteger(size)||size<head||p+size>to)throw Error('mp4_box_invalid_'+type);
  result.push({type,start:p,size,head,end:p+size,data:p+head});p+=size;
 }
 if(p!==to)throw Error('mp4_trailing_bytes');return result;
}
function box(type,data){const b=new Uint8Array(data.length+8);put32(b,0,b.length);for(let i=0;i<4;i++)b[i+4]=type.charCodeAt(i);b.set(data,8);return b;}
function concat(chunks){const n=chunks.reduce((s,c)=>s+c.length,0);if(n>180_000_000)throw Error('mp4_too_large');const out=new Uint8Array(n);let p=0;for(const c of chunks){out.set(c,p);p+=c.length;}return out;}
function find(list,type){const x=list.find(x=>x.type===type);if(!x)throw Error('mp4_missing_'+type);return x;}
function slice(b,x){return b.slice(x.start,x.end);}
function child(b,parent){return boxes(b,parent.data,parent.end);}
function decodeMeta(raw){try{const u=new URL(raw);const s=u.searchParams.get('efg');if(!s)return null;const clean=s.replace(/-/g,'+').replace(/_/g,'/');const pad=clean.padEnd(Math.ceil(clean.length/4)*4,'=');return JSON.parse(atob(pad));}catch{return null;}}
function cleanUrl(raw){let u;try{u=new URL(raw);}catch{return null;}const h=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||!(h.endsWith('.cdninstagram.com')||h.endsWith('.fbcdn.net'))||!/\.mp4$/i.test(u.pathname)||raw.length>4096)return null;u.searchParams.delete('bytestart');u.searchParams.delete('byteend');return u.href;}
function selectStreams(records,duration,context={}){
 const groups=new Map();
 for(const row of records||[]){
  if(typeof row.url!=='string')continue;
  const url=cleanUrl(row.url);if(!url)continue;
  const meta=decodeMeta(row.url);if(!meta)continue;
  const tag=String(meta.vencode_tag||meta.encode_tag||'');
  let kind=null;
  if(/_audio|heaac|aac/i.test(tag))kind='audio';
  else if(/dash_.*(?:baseline|_v\d)|dash_baseline/i.test(tag))kind='video';
  else continue;
  const asset=String(meta.xpv_asset_id||'');if(!/^\d{8,24}$/.test(asset))continue;
  const when=Number(row.start)||0;
  const g=groups.get(asset)||{asset,streams:new Map(),duration:Number(meta.duration_s)||0,last:0,events:[]};
  g.last=Math.max(g.last,when);
  g.events.push({when,kind});
  const existing=g.streams.get(kind);
  if(!existing||Number(meta.bitrate||0)>existing.bitrate||(Number(meta.bitrate||0)===existing.bitrate&&when>existing.start)){
   g.streams.set(kind,{url,bitrate:Number(meta.bitrate)||0,start:when,tag});
  }
  groups.set(asset,g);
 }
 const pairs=[...groups.values()].filter(g=>g.streams.has('video')&&g.streams.has('audio'));
 if(!pairs.length)return {ok:false,reason:'no_video_audio_pair',groupCount:groups.size};
 const expected=Number(duration);
 let candidates=pairs;
 // The HTMLMediaElement's actual duration is a much stronger signal than
 // resource order, which Instagram can change while preloading next Stories.
 if(Number.isFinite(expected)&&expected>1){
  const tolerance=Math.max(0.65,expected*0.025);
  const matched=pairs.filter(g=>g.duration>0&&Math.abs(g.duration-expected)<=tolerance);
  if(matched.length)candidates=matched;
  else return {ok:false,reason:'no_duration_match',groupCount:pairs.length};
 }
 // If duration uniquely identifies the currently playing Story, do not let a
 // newer preload override it.
 let picked=candidates.length===1?candidates[0]:null;
 // A second signal is permitted only with a known, recent player change AND
 // substantial in-window video+audio request activity. Never choose just the
 // most recent CDN URL (it often belongs to the next preloaded Story).
 if(!picked && Number.isFinite(context.activeSince)&&context.activeSince>0){
  const since=context.activeSince;
  const now=Number(context.now)||Infinity;
  const evidence=candidates.map(g=>{
   const relevant=g.events.filter(e=>e.when>=since-1500&&e.when<=now+200);
   const v=relevant.filter(e=>e.kind==='video').length;
   const a=relevant.filter(e=>e.kind==='audio').length;
   return {g,score:Math.min(v,9)+Math.min(a,5),v,a};
  }).filter(x=>x.v>=2&&x.a>=1).sort((a,b)=>b.score-a.score);
  // Require a significant gap, not an arbitrary tie-break.
  if(evidence.length && evidence[0].score>=5 &&
      (evidence.length===1||evidence[0].score>=evidence[1].score+4))picked=evidence[0].g;
 }
 if(!picked)return {ok:false,reason:'ambiguous_story',groupCount:candidates.length};
 return {ok:true,asset:picked.asset,video:picked.streams.get('video').url,audio:picked.streams.get('audio').url,duration:picked.duration,groupCount:groups.size};
}
function firstTrack(b){const moov=find(boxes(b),'moov');const trak=find(child(b,moov),'trak');const tkhd=find(child(b,trak),'tkhd');const p=tkhd.data + (b[tkhd.data]===1 ? 20:12);return {trackId:read32(b,p),trak,moov};}
function parseFrag(b){const all=boxes(b);const moov=find(all,'moov');const ftyp=find(all,'ftyp');const fragments=[];
 for(let i=0;i<all.length;i++)if(all[i].type==='moof'){
  const moof=all[i];const mdat=all[i+1];if(!mdat||mdat.type!=='mdat')throw Error('mp4_fragment_mdat_missing');
  fragments.push({moof,mdat});i++;
 }
 if(!fragments.length)throw Error('mp4_no_fragments');return {b,all,moov,ftyp,fragments,...firstTrack(b)};
}
function remux(videoBuffer,audioBuffer){
 const v=parseFrag(new Uint8Array(videoBuffer));const a=parseFrag(new Uint8Array(audioBuffer));
 const newAudioId=v.trackId===1?2:v.trackId+1;
 const audioTrak=slice(a.b,a.trak);
 const tkhd=find(child(audioTrak,{data:8,end:audioTrak.length}),'tkhd');
 put32(audioTrak,tkhd.data+(audioTrak[tkhd.data]===1?20:12),newAudioId);
 const videoChildren=child(v.b,v.moov);const audioChildren=child(a.b,a.moov);
 const audioMvex=find(audioChildren,'mvex');const audioTrex=slice(a.b,find(child(a.b,audioMvex),'trex'));
 put32(audioTrex,12,newAudioId);
 const vMvex=find(videoChildren,'mvex');
 const moovParts=[];
 for(const x of videoChildren){if(x.type==='mvex'){
    const trexes=child(v.b,x).map(c=>slice(v.b,c));trexes.push(audioTrex);
    moovParts.push(box('mvex',concat(trexes)));
  }else moovParts.push(slice(v.b,x));
 }
 const mvhd=moovParts.find(x=>str(x,4)==='mvhd');if(mvhd)put32(mvhd,mvhd.length-4,newAudioId+1);
 const at=moovParts.findIndex(x=>str(x,4)==='mvex');moovParts.splice(at>=0?at:moovParts.length,0,audioTrak);
 const mergedMoov=box('moov',concat(moovParts));
 const out=[slice(v.b,v.ftyp),mergedMoov];let seq=1;
 for(const [file,newId] of [[v,v.trackId],[a,newAudioId]]){
  for(const f of file.fragments){const mf=slice(file.b,f.moof);const nested=boxes(mf,8,mf.length);
   const mfhd=nested.find(x=>x.type==='mfhd');if(mfhd)put32(mf,mfhd.data+4,seq++);
   const trafs=nested.filter(x=>x.type==='traf');if(!trafs.length)throw Error('mp4_no_traf');
   for(const traf of trafs){const tfhd=find(boxes(mf,traf.data,traf.end),'tfhd');
    // An absolute base offset points into the *old* file. Never create corrupt outputs.
    const flags=(mf[tfhd.data+1]<<16)|(mf[tfhd.data+2]<<8)|mf[tfhd.data+3];
    if(flags&1)throw Error('mp4_absolute_base_offset_unsupported');
    if(!(flags&0x020000)){
      // With no explicit base-data-offset and one traf per moof, the implicit base is moof.
      if(trafs.length!==1)throw Error('mp4_implicit_multi_traf_unsupported');
    }
    put32(mf,tfhd.data+4,newId);
   }
   out.push(mf,slice(file.b,f.mdat));
  }
 }
 const merged=concat(out);
 // Structural checks, no claims about platform playback compatibility.
 const parsed=boxes(merged);if(parsed.filter(x=>x.type==='moov').length!==1)throw Error('mp4_output_invalid');
 return merged;
}
return {boxes,selectStreams,remux,cleanUrl,decodeMeta};
});

/* v0.6.13: generated with scripts/build.cjs; edit source modules. */
/* SOURCE: shared.js */
/* Public media post URL normalization, no page content or cookies are read. */
(function (root) {
  'use strict';
  function normalize(input) {
    if (typeof input !== 'string') return null;
    let u;
    try { u = new URL(input.trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if(u.username||u.password||(u.port&&u.port!=='443'&&!(u.protocol==='http:'&&u.port==='80')))return null;
    const host = u.hostname.toLowerCase();
    let match, canonical, platform;
    if ((host === 'tiktok.com' || host.endsWith('.tiktok.com')) && !['vm.tiktok.com','vt.tiktok.com'].includes(host)) {
      match = u.pathname.match(/^\/(?:@([^/]+)\/)?(video|photo)\/(\d+)(?:\/|$)/i);
      if (match) {
        canonical = `https://www.tiktok.com/${match[1] ? '@' + match[1] + '/' : ''}${match[2].toLowerCase()}/${match[3]}`;
      } else if (u.pathname.startsWith('/t/') && /^\/t\/[A-Za-z0-9]+\/?$/.test(u.pathname)) {
        canonical = `https://www.tiktok.com${u.pathname}`;
      } else return null;
      platform = 'TikTok';
    } else if (['vm.tiktok.com','vt.tiktok.com'].includes(host)) {
      if (!/^\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return null;
      canonical = `https://${host}${u.pathname}`;
      platform = 'TikTok';
    } else if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
      match = u.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/);
      if (!match) return null;
      canonical = `https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`;
      platform = 'Instagram';
    } else if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
      match = u.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
      if (!match) return null;
      canonical = `https://x.com/${match[1]}/status/${match[2]}`;
      platform = 'X';
    } else return null;
    return {url: canonical, platform};
  }
  function parseMany(text, max = 50) {
    const urls = (String(text || '').match(/https?:\/\/[^\s<>'"`]+/gi) || []);
    const unique = new Map();
    for (const raw of urls) {
      const value = normalize(raw.replace(/[),;.!]+$/g, ''));
      if (value) unique.set(value.url, value);
      if (unique.size >= max) break;
    }
    return [...unique.values()];
  }
  function parseEndpoint(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    const isLocal = ['localhost', '127.0.0.1'].includes(u.hostname.toLowerCase());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    // Cobalt expects POST / on the API root, so don't accept path-based endpoints.
    if (u.pathname !== '/' && u.pathname !== '') return null;
    return {api: u.origin + '/', origin: `${u.protocol}//${u.hostname}/*`};
  }
  root.RyzexLinks = Object.freeze({normalize, parseMany, parseEndpoint});
})(globalThis);


/* SOURCE: download-policy.js */
/* Shared Worker/extension policy. Bundled into the standalone Worker/background. */
(() => {
  'use strict';
  const MEDIA_DOMAINS=Object.freeze(['tiktok.com','tiktokcdn.com','tiktokcdn-us.com','tiktokcdn-eu.com',
    'byteoversea.com','ibytedtos.com','ibyteimg.com','byteimg.com','muscdn.com','musical.ly',
    'cdninstagram.com','fbcdn.net','twimg.com','tikwm.com','ahm7xmakki.com']);
  const COBALT_ORIGIN='https://ryzex-social-media-api.onrender.com';
  const FORBIDDEN_EXT=/^(?:exe|dll|msi|msp|bat|cmd|com|scr|ps1|psm1|psd1|vbs|vbe|wsf|wsh|hta|jar|js|jse|cpl|lnk|url|website|scf|reg|chm|appref-ms|html?|xhtml|mhtml?|svgz?)$/i;
  function publicHttps(raw) {
    if(typeof raw!=='string'||raw.length>8192)return null;
    try {
      const u=new URL(raw),h=u.hostname.toLowerCase();
      if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))return null;
      if(!h.includes('.')||h.endsWith('.')||h.startsWith('[')||/^\d+(?:\.\d+){3}$/.test(h)||
        ['localhost','local','internal','test','invalid','example','home.arpa','onion'].some(s=>h===s||h.endsWith('.'+s)))return null;
      return u;
    } catch {return null;}
  }
  function mediaUrl(raw) {
    const u=publicHttps(raw);if(!u)return null;
    if(u.origin===COBALT_ORIGIN) {
      // No authority to fetch the API root/admin/config endpoints.
      return /^\/tunnel(?:\/|$)/.test(u.pathname)?u.href:null;
    }
    return MEDIA_DOMAINS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;
  }
  function leafName(raw) {
    if(typeof raw!=='string'||raw.length>1024)return '';
    let name=raw;
    // Inspect encoded and double-encoded suffixes, including Windows trim rules.
    for(let i=0;i<3;i++){try{const n=decodeURIComponent(name);if(n===name)break;name=n;}catch{break;}}
    return name.replace(/\\/g,'/').split('/').pop().replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ .]+$/g,'');
  }
  function dangerousName(raw) {
    const name=leafName(raw);
    if(/[:?#]/.test(name))return true; // Windows ADS and filename/URL ambiguity.
    const ext=name.match(/\.([^.]+)$/)?.[1]||'';
    return FORBIDDEN_EXT.test(ext);
  }
  function dangerousFile(file) {
    if(!file||typeof file!=='object'||dangerousName(file.filename))return true;
    try {if(dangerousName(new URL(file.url).pathname))return true;}catch{return true;}
    const mime=String(file.mime||file.mimeType||file.contentType||'').split(';',1)[0].trim().toLowerCase();
    return /(?:javascript|ecmascript|html|svg|x-msdownload|x-dosexec|x-msdos-program)/.test(mime);
  }
  function acceptedMime(mime) {
    return /^(?:video\/|audio\/|image\/(?!svg)|application\/(?:octet-stream|ogg|mp4|mp2t|vnd\.apple\.mpegurl|x-mpegurl)$)/i.test(mime);
  }
  function badPrefix(bytes) {
    if(bytes[0]===0x4d&&bytes[1]===0x5a)return true; // PE/DOS executable.
    const text=new TextDecoder().decode(bytes.slice(0,512)).replace(/^\uFEFF/,'').trimStart();
    return /^(?:<!doctype\s+html|<html[\s>]|<script[\s>]|<\?xml|<svg[\s>]|\{\s*"(?:error|status|message)"|#!)/i.test(text);
  }
  globalThis.RyzexDownloadPolicy=Object.freeze({MEDIA_DOMAINS,COBALT_ORIGIN,publicHttps,mediaUrl,leafName,dangerousName,dangerousFile,acceptedMime,badPrefix});
})();


/* SOURCE: media-policy.js */
/* Ryzex Media Saver: no media-format allowlist; preserve the source extension. */
(() => {
  'use strict';
  const PLATFORM_LABELS = Object.freeze({TikTok:'TikTok',Instagram:'Instagram',X:'Twitter',Twitter:'Twitter'});
  const MIME_EXTENSIONS = Object.freeze({
    'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov',
    'video/x-matroska':'mkv', 'video/mp2t':'ts', 'video/mpeg':'mpeg',
    'video/x-msvideo':'avi', 'video/x-m4v':'m4v',
    'image/jpeg':'jpg', 'image/png':'png', 'image/gif':'gif',
    'image/webp':'webp', 'image/avif':'avif', 'image/bmp':'bmp',
    'image/tiff':'tiff', 'image/heic':'heic', 'image/heif':'heif',
    'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/ogg':'ogg',
    'audio/webm':'webm', 'audio/wav':'wav', 'audio/flac':'flac',
    'application/vnd.apple.mpegurl':'m3u8',
    'application/x-mpegurl':'m3u8'
  });
  function platformLabel(platform) { return PLATFORM_LABELS[platform] || null; }
  function extFromName(name) {
    if (typeof name !== 'string' || !name.trim()) return '';
    const leaf = RyzexDownloadPolicy.leafName(name);
    const match = leaf.match(/\.([a-z0-9]{1,16})$/i);
    return match ? match[1].toLowerCase() : '';
  }
  function extFromUrl(url) {
    try { return extFromName(new URL(url).pathname); } catch { return ''; }
  }
  function extFromMime(mime) {
    const type = typeof mime === 'string' ? mime.split(';',1)[0].trim().toLowerCase() : '';
    return MIME_EXTENSIONS[type] || '';
  }
  function chooseExtension(file, observedMime = '') {
    if(RyzexDownloadPolicy.dangerousFile(file) || !safeObservedMime(observedMime))
      throw new Error('Unsafe file type blocked.');
    // Cobalt's filename is the authoritative hint. Neither MKV nor TS nor
    // other file formats are blocked or mislabeled as MP4.
    const extension = extFromName(file.filename) || extFromUrl(file.url) ||
      extFromMime(file.mime || file.mimeType || file.contentType) || extFromMime(observedMime) || '';
    if(extension && RyzexDownloadPolicy.dangerousName('media.'+extension))throw new Error('Unsafe file extension blocked.');
    return extension;
  }
  function safeObservedMime(mime) {
    return !/(?:javascript|ecmascript|html|svg|x-msdownload|x-dosexec)/i.test(String(mime||''));
  }
  function randomName(platform) {
    const label = platformLabel(platform);
    if (!label) throw new Error('Unsupported media link.');
    const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const bytes=crypto.getRandomValues(new Uint8Array(14));
    const suffix=Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
    return `RyzexStudio_${label}_${suffix}`;
  }
  globalThis.RyzexMediaPolicy=Object.freeze({chooseExtension,randomName,platformLabel,extFromName});
})();


/* SOURCE: security-policy.js */
/* Protects internal extension messages. Never embeds any credentials. */
(() => {
  'use strict';
  const MAX_POPUP_LINKS=50;
  const MAX_URL_LENGTH=2048;
  const PRIVATE_IP=/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  function platformForHostname(host){
    const h=String(host||'').toLowerCase();
    if(h==='tiktok.com'||h.endsWith('.tiktok.com'))return 'TikTok';
    if(h==='instagram.com'||h.endsWith('.instagram.com'))return 'Instagram';
    if(['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(h))return 'X';
    return null;
  }
  function senderKind(sender, extensionId){
    if(!sender || sender.id!==extensionId || typeof sender.url!=='string')return null;
    let url;
    try{url=new URL(sender.url);}catch{return null;}
    if(url.protocol==='chrome-extension:' && url.hostname===extensionId && url.pathname==='/popup.html' && !sender.tab)
      return {kind:'popup'};
    if(url.protocol!=='https:' || !Number.isInteger(sender.tab?.id) || sender.tab.id<0)return null;
    if(sender.frameId!==undefined && sender.frameId!==0)return null;
    const platform=platformForHostname(url.hostname);
    if(!platform)return null;
    return {kind:'content',platform,tabId:sender.tab.id};
  }
  function normalizeQueueInput(raw,actor){
    if(!actor)throw new Error('Unauthorized message source.');
    const input=Array.isArray(raw)?raw:[raw];
    const max=actor.kind==='popup'?MAX_POPUP_LINKS:1;
    if(!input.length || input.length>max)throw new Error('Too many links in one request.');
    const values=[];
    for(const item of input){
      const url=typeof item==='string'?item:item && typeof item.url==='string'?item.url:null;
      if(typeof url!=='string' || !url.length || url.length>MAX_URL_LENGTH)throw new Error('Invalid or excessively long media link.');
      const normalized=RyzexLinks.normalize(url);
      if(!normalized)throw new Error('Unsupported media link.');
      if(actor.kind==='content' && normalized.platform!==actor.platform)throw new Error('Link does not match the page platform.');
      values.push(normalized);
    }
    return values;
  }
  function allowMediaUrl(candidate, endpoint){
    if(RyzexDownloadPolicy.mediaUrl(candidate))return true;
    let url;try{url=new URL(candidate);}catch{return false;}
    if(url.username||url.password)return false;
    // Unencrypted downloads are only acceptable for an explicitly configured local test server.
    if(url.protocol==='http:' && endpoint){
      let api;
      try{api=new URL(endpoint.api);}catch{return false;}
      return ['localhost','127.0.0.1'].includes(api.hostname) && url.origin===api.origin;
    }
    return false;
  }
  globalThis.RyzexSecurity=Object.freeze({senderKind,normalizeQueueInput,allowMediaUrl});
})();


/* SOURCE: background-core.js */
/* BACKGROUND SERVICE WORKER */


// API configuration and download history must not be exposed to website content scripts.
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
  .catch(() => { /* Older Chromium releases may not support this API. */ });

const MAX_QUEUE = 60;
const RECORD_LIMIT = 100;
// Small, persistent token bucket: isolated clicks start immediately, while
// bulk processing remains below the Gateway's 15 requests / minute budget.
// A 3-token burst with one refill every 6.5s is intentionally conservative.
const PROCESS_BURST_CAPACITY = 3;
const PROCESS_REFILL_MS = 6500;
function processPace(snapshot, now) {
  const valid=snapshot && Number.isFinite(snapshot.tokens) && Number.isFinite(snapshot.updatedAt);
  const elapsed=valid?Math.max(0,now-snapshot.updatedAt):0;
  const tokens=valid?Math.min(PROCESS_BURST_CAPACITY,Math.max(0,snapshot.tokens)+elapsed/PROCESS_REFILL_MS):PROCESS_BURST_CAPACITY;
  return {tokens,updatedAt:now};
}
let working = false;
const clientBurst = new Map();
function allowClientBurst(tabId) {
  const now=Date.now();
  const prior=clientBurst.get(tabId)||[];
  const recent=prior.filter(x=>now-x<10000);
  if(recent.length>=8){clientBurst.set(tabId,recent);return false;}
  recent.push(now);clientBurst.set(tabId,recent);
  if(clientBurst.size>150){for(const [id,times] of clientBurst)if(!times.some(t=>now-t<10000))clientBurst.delete(id);}
  return true;
}

function stringifyError(error) { return String(error?.message || error || 'Unknown error').slice(0, 280); }

// The Gateway handles Cobalt credentials. No Cobalt API key is shipped to end users.
const GATEWAY_URL='https://ryzex-social-media-gateway.ryzexstudioofficial.workers.dev';
let registrationPromise=null;
let healthCheckedAt=0;
let healthPromise=null;
let offscreenOpening=null;
const monitors=new Set();
const COBALT_HOST='ryzex-social-media-api.onrender.com';

async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) throw new Error('This browser does not support background media processing.');
  if (!offscreenOpening) offscreenOpening=(async()=>{
    const contexts=chrome.runtime.getContexts ? await chrome.runtime.getContexts({
      contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]
    }) : [];
    if(contexts.length) return;
    try {
      await chrome.offscreen.createDocument({
        url:'offscreen.html', reasons:['BLOBS'],
        justification:'Validate tunnel media, download it through a safe blob URL and report progress.'
      });
    } catch(error) {
      // A second worker task may have opened it concurrently.
      if(!String(error?.message||'').includes('single offscreen document'))throw error;
    }
  })().finally(()=>{offscreenOpening=null;});
  return offscreenOpening;
}

async function releaseBlob(blobUrl) {
  if(typeof blobUrl!=='string'||!blobUrl.startsWith('blob:chrome-extension://'))return;
  try {await chrome.runtime.sendMessage({type:'RYZEX_OFFSCREEN_RELEASE',blobUrl});}catch{}
}

async function updateJob(jobId,changes,onlyStates=null) {
  const job=await mutateQueue(queue=>{
    const index=queue.findIndex(job=>job.id===jobId);if(index<0||onlyStates&&!onlyStates.includes(queue[index].state))return null;
    queue[index]={...queue[index],...changes};return {...queue[index]};
  });
  if(job)void sendStatus(job);
  return job;
}

async function monitorJob(jobId,downloadIds,blobUrls=[]) {
  if(monitors.has(jobId))return;
  monitors.add(jobId);
  try {
    let lastPercent=-1;
    while(true) {
      const downloads=await Promise.all(downloadIds.map(id=>chrome.downloads.search({id})));
      if(downloads.some(items=>!items?.[0]))throw new Error('The download is no longer in browser history.');
      const entries=downloads.map(items=>items[0]);
      const interrupted=entries.find(e=>e.state==='interrupted');
      if(interrupted)throw new Error('Browser interrupted the download: '+(interrupted.error||'Unknown network error'));
      const allComplete=entries.every(e=>e.state==='complete');
      if(allComplete) {
        const current=(await readQueue()).find(j=>j.id===jobId);
        await updateJob(jobId,{state:current?.partialError?'error':'started',note:current?.partialError?
          `${entries.length} files downloaded; other media failed: ${current.partialError}`:`${entries.length} files downloaded successfully`,percent:100,preparedResult:null});
        break;
      }
      const total=entries.reduce((sum,e)=>sum+(Number(e.totalBytes)||0),0);
      const bytes=entries.reduce((sum,e)=>sum+(Number(e.bytesReceived)||0),0);
      const known=entries.every(e=>e.state==='complete'||Number(e.totalBytes)>0);
      const percent=known&&total>0?Math.min(99,Math.floor(bytes/total*100)):null;
      if(percent!==lastPercent) {
        lastPercent=percent;
        await updateJob(jobId,{state:'downloading',percent,
          note:percent===null?'Downloading file…':`Downloading: ${percent}%`});
      }
      await new Promise(resolve=>setTimeout(resolve,800));
    }
  } catch(error) {
    await updateJob(jobId,{state:'error',note:stringifyError(error),percent:null});
  } finally {
    monitors.delete(jobId);
    for(const blobUrl of blobUrls)await releaseBlob(blobUrl);
  }
}

async function resumeMonitors() {
  const queue=await readQueue();
  for(const job of queue) {
    if(job.state==='downloading'&&Array.isArray(job.downloadIds)&&job.downloadIds.length) {
      // Offscreen document is kept alive by its pending blob downloads.
      void monitorJob(job.id,job.downloadIds,job.blobUrls||[]);
    }
  }
}


async function gatewayRequest(path, {method='GET',token=null,body=null,timeout=35000}={}) {
  const headers={'Accept':'application/json'};
  if (token) headers.Authorization=`Bearer ${token}`;
  if (body!==null) headers['Content-Type']='application/json';
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeout);
  let response,data;
  try {
    response=await fetch(GATEWAY_URL+path,{method,headers,
      ...(body!==null?{body:JSON.stringify(body)}:{}),signal:ctrl.signal,credentials:'omit',redirect:'error',cache:'no-store'});
    if(response.body) {
      const reader=response.body.getReader();let size=0;const chunks=[];
      for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>192*1024){await reader.cancel();throw new Error('Gateway response exceeds the size limit.');}chunks.push(value);}
      const bytes=new Uint8Array(size);let n=0;for(const part of chunks){bytes.set(part,n);n+=part.length;}
      data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    } else data=await response.json();
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid Gateway response.');
  } catch(e) {
    const error=new Error(ctrl.signal.aborted?'Gateway connection timed out.':'Could not connect to Gateway or read its response.');
    // Replaying /process is safe only with the v0.4.2 idempotency ledger.
    error.retryAfter=15;error.retryable=path==='/process';throw error;
  } finally {clearTimeout(timer);}
  if(!response.ok) {
    if(response.status===401) throw new Error('Gateway identity is invalid or blocked.');
    if(response.status===429 && data?.error==='Daily quota reached')
      throw new Error(`Daily ${data?.platform||''} download limit reached (50). Try again tomorrow.`);
    const code=typeof data.code==='string'&&/^[a-zA-Z0-9_.-]{1,120}$/.test(data.code)?data.code:'';
    const error=new Error(code?`Gateway: ${code}`:`Gateway HTTP ${response.status}`);
    const retry=Number(data.retryAfter)||Number(response.headers?.get('retry-after'))||60;
    error.retryable=(response.status===429&&data.error!=='Daily quota reached')||code==='error.gateway.process_in_progress';
    error.retryAfter=Math.max(1,Math.min(3600,retry));throw error;
  }
  return data;
}

async function gatewayToken() {
  const stored=(await chrome.storage.local.get('gatewayToken')).gatewayToken;
  if(typeof stored==='string' && /^[0-9a-f]{64}$/i.test(stored)) return stored;
  if(!registrationPromise) registrationPromise=(async()=>{
    // Dedupe registration across simultaneous tabs and queued downloads.
    const again=(await chrome.storage.local.get('gatewayToken')).gatewayToken;
    if(typeof again==='string' && /^[0-9a-f]{64}$/i.test(again)) return again;
    const result=await gatewayRequest('/register',{method:'POST',timeout:20000});
    if(typeof result?.token!=='string'|| !/^[0-9a-f]{64}$/i.test(result.token))
      throw new Error('Gateway did not return a valid installation identity.');
    await chrome.storage.local.set({gatewayToken:result.token});
    return result.token;
  })().finally(()=>{registrationPromise=null;});
  return registrationPromise;
}

async function gatewayStatus() {
  const [,token]=await Promise.all([ensureGatewayVersion(),gatewayToken()]);
  const result=await gatewayRequest('/quota',{token,timeout:12000});
  return {ok:true,quotas:result.quotas||{},day:result.day||''};
}
async function ensureGatewayVersion() {
  if(Date.now()-healthCheckedAt<300000)return;
  if(!healthPromise)healthPromise=(async()=>{
    const health=await gatewayRequest('/health',{timeout:15000});
    if(health?.idempotency!==true||health?.version!=='0.4.2')
      throw new Error('Install Gateway 0.4.2 and the additive SQL migration first.');
    healthCheckedAt=Date.now();
  })().finally(()=>{healthPromise=null;});
  return healthPromise;
}

// Preserve ordinary media formats; reject executable and active document types.

async function sendStatus(item) {
  if (!Number.isInteger(item.originTabId)) return;
  try {
    await chrome.tabs.sendMessage(item.originTabId, {
      type:'RYZEX_QUEUE_STATUS', state:item.state, note:item.note, jobId:item.id, percent:item.percent??null
    });
  } catch { /* Popup closed or tab navigated away. Queue still works. */ }
}

async function callCobalt(item) {
  // Re-validate persisted jobs before any server request (defense in depth).
  const safeLink=RyzexLinks.normalize(item?.url);
  if (!safeLink || safeLink.url!==item.url || safeLink.platform!==item.platform)
    throw new Error('Queued media link failed security validation.');
  let token;
  if(!item.preparedResult){[,token]=await Promise.all([ensureGatewayVersion(),gatewayToken()]);}
  const gatewayResult=item.preparedResult?{result:item.preparedResult}:
    await gatewayRequest('/process', {method:'POST',token,body:{url:item.url,requestId:item.id}});
  // Unlike the Cobalt API, /process nests its Cobalt payload in "result".
  const data=gatewayResult?.result;
  if (!data || typeof data !== 'object') throw new Error('Empty API response.');
  if (data.status === 'error') throw new Error(`Cobalt: ${data.error?.code || 'Processing failed'}`);
  if (data.status === 'local-processing') throw new Error('Cobalt requires local processing for this media; no ready download URL was returned.');
  let files = [];
  if (['redirect', 'tunnel'].includes(data.status) && data.url) {
    files = [{url:data.url, filename:data.filename || '', kind:'', mime:data.mime || data.contentType || ''}];
  } else if (data.status === 'picker' && Array.isArray(data.picker)) {
    files = data.picker.slice(0, 20).map((entry) => ({url:entry.url, filename:entry.filename || '', kind:entry.type || '', mime:entry.mime || entry.contentType || ''}));
    if (!files.length) throw new Error('The media picker returned no files.');
  } else throw new Error(`Unsupported API response: ${data.status || '?'}`);
  if(item.platform==='Instagram' && /\/reel\//.test(item.url)) {
    // Reels can contain real photos, including mixed/multi-photo posts. Only
    // explicit preview entries are excluded; a JPG is not inherently a poster.
    // Cobalt's separate `thumb` field is never added to the download list.
    files=files.filter(file=>!/^(?:thumbnail|poster|preview)$/i.test(file.kind));
    files=files.map(file=>{
      const declared=RyzexMediaPolicy.chooseExtension(file);
      let sourceExtension='';
      try{sourceExtension=RyzexMediaPolicy.extFromName(new URL(file.url).pathname);}catch{}
      const image=/^(?:jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff)$/i;
      const video=/^(?:mp4|webm|mov|m4v|mkv|ts)$/i;
      // Conflicting provider filenames must not turn a JPG into a fake MP4
      // or a real video into a .jpg. Original dangerous-name checks ran above.
      if((image.test(sourceExtension)&&video.test(declared))||
          (video.test(sourceExtension)&&image.test(declared)))
        return {...file,filename:`media.${sourceExtension}`};
      return file;
    });
    if(!files.length)throw new Error('The API returned no downloadable files.');
  }
  await updateJob(item.id,{preparedResult:data,preparedAt:item.preparedAt||Date.now()});

  let started = 0;
  const downloadIds=[...(item.downloadIds||[])];
  const blobUrls=[...(item.blobUrls||[])];
  if(item.dispatchingName) {
    const escaped=item.dispatchingName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\//g,'[\\\\/]');
    const recovered=await chrome.downloads.search({filenameRegex:escaped+'$'});
    if(recovered.length!==1)throw new Error('Previous download start could not be verified; automatic retry blocked.');
    if(!downloadIds.includes(recovered[0].id))downloadIds.push(recovered[0].id);
    item.completedFiles=Number(item.dispatchingIndex)+1;
    await updateJob(item.id,{downloadIds:[...downloadIds],completedFiles:item.completedFiles,dispatchingName:null});
  }
  let skipped = 0;
  const rejectionReasons = [];
  for (const [fileIndex,file] of files.entries()) {
    if(fileIndex<(item.completedFiles||0))continue;
    if(item.preparedResult && Date.now()-Number(item.preparedAt)>300000)
      throw new Error('Prepared media link expired. Create a new download request.');
    await ensureGatewayVersion();token=token||await gatewayToken();
    let u;
    try { u = new URL(file.url); } catch { skipped++; rejectionReasons.push('Invalid media link'); continue; }
    if (!RyzexSecurity.allowMediaUrl(u.href, {api:GATEWAY_URL+"/"})) {
      skipped++; rejectionReasons.push('Unsafe media link'); continue;
    }
    // Fast path: Gateway already accepts only trusted media-host URLs.
    // For redirect and picker results, let Edge fetch bytes directly. This
    // avoids Gateway HEAD/Range probes (which can return 503 for valid media)
    // and the old double-download (offscreen blob + Edge save) delay.
    // TikTok and Cobalt tunnels still use the strict, fully checked offscreen
    // path because a tunnel's response can differ from a normal media URL.
    const directDownload = data.status !== 'tunnel';
    let extension=RyzexMediaPolicy.chooseExtension(file) || 'bin';
    let options;
    if (directDownload) {
      if (!RyzexDownloadPolicy.mediaUrl(u.href) ||
          RyzexDownloadPolicy.dangerousFile({...file,url:u.href}))
        throw new Error('Untrusted direct download address blocked.');
      options={url:u.href,conflictAction:'uniquify',saveAs:false,
        filename:`RyzexMediaSaver/${RyzexMediaPolicy.randomName(item.platform)}.${extension}`};
      await updateJob(item.id,{state:'processing',note:'Starting browser download…',percent:null});
    } else {
      await ensureGatewayVersion();token=token||await gatewayToken();
      const resolved=await gatewayRequest('/resolve',{method:'POST',token,body:{url:u.href},timeout:15000});
      if(!RyzexDownloadPolicy.mediaUrl(resolved.url))throw new Error('Unsafe final media address.');
      const validatedFile={...file,url:resolved.url};
      await ensureOffscreen();
      await updateJob(item.id,{state:'processing',note:'Fetching media securely…',percent:null});
      const reply=await chrome.runtime.sendMessage({type:'RYZEX_OFFSCREEN_FETCH',url:resolved.url,jobId:item.id,filename:file.filename||'',mime:file.mime||''});
      if(!reply?.ok||typeof reply.blobUrl!=='string'||!reply.blobUrl.startsWith('blob:'+chrome.runtime.getURL('')))
        throw new Error(reply?.error||'Media transfer failed.');
      extension=RyzexMediaPolicy.chooseExtension(validatedFile,reply.mime)||'bin';
      options={url:reply.blobUrl,conflictAction:'uniquify',saveAs:false,
        filename:`RyzexMediaSaver/${RyzexMediaPolicy.randomName(item.platform)}.${extension}`};
      blobUrls.push(reply.blobUrl);
    }
    // Persist intent before the external side effect. A crash can be reconciled
    // using the exact safe filename without issuing another provider preparation.
    await updateJob(item.id,{dispatchingName:options.filename,dispatchingIndex:fileIndex,blobUrls:[...blobUrls]});
    let dispatched=false;
    try {
      const id=await chrome.downloads.download(options);
      if(!Number.isInteger(id))throw new Error('Browser did not return a download ID.');
      dispatched=true;downloadIds.push(id);started++;
      await updateJob(item.id,{downloadIds:[...downloadIds],blobUrls:[...blobUrls],completedFiles:fileIndex+1,dispatchingName:null});
    } catch(error) {
      if(!dispatched){await releaseBlob(options.url);await updateJob(item.id,{dispatchingName:null});}
      throw error;
    }
  }
  if (!downloadIds.length) throw new Error(`No files could be downloaded. ${rejectionReasons[0] || 'The API returned no downloadable files.'}`);
  return {started:downloadIds.length, skipped, reasons: rejectionReasons,downloadIds,blobUrls};
}

const HISTORY_TTL_MS=14*24*60*60*1000;
async function readQueue() {
  const {queue=[]}=await chrome.storage.local.get('queue');
  return Array.isArray(queue) ? queue.filter(job => job && typeof job === 'object') : [];
}
async function writeQueue(queue) { await chrome.storage.local.set({queue:queue.slice(-RECORD_LIMIT)}); }
let queueMutation=Promise.resolve();
function mutateQueue(change) {
  const run=queueMutation.then(async()=>{const queue=await readQueue();const result=await change(queue);await writeQueue(queue);return result;});
  queueMutation=run.catch(()=>{});return run;
}
async function cleanupOldHistory() {
  await mutateQueue(queue=>{
  const recent=queue.filter(job => ['queued','processing','downloading'].includes(job.state) ||
    (Number.isFinite(job.time) && Date.now()-job.time < HISTORY_TTL_MS));
  queue.splice(0,queue.length,...recent);
  });
}

async function pump() {
  if (working) return;
  working = true;
  try {
    await cleanupOldHistory();
    await mutateQueue(queue=>{
    // Interrupted requests are retried after service worker restart.
    for (const job of queue) if (job.state === 'processing') {
      job.state = 'queued'; job.note = 'The request will be retried.';
    }
    });
    void resumeMonitors();
    for (let step=0; step<MAX_QUEUE;) {
      const now=Date.now();
      // nextProcessAt is reserved for genuine provider 429/Retry-After cooldowns.
      // In older versions it also added an unconditional 6.5 second delay to
      // consecutive single clicks; the local token bucket now handles pacing.
      const state=await chrome.storage.local.get(['nextProcessAt','processPace']);
      const cooldown=Math.max(0,Number(state.nextProcessAt)||0);
      const pace=processPace(state.processPace,now);
      const readyAt=pace.tokens>=1?now:now+Math.ceil((1-pace.tokens)*PROCESS_REFILL_MS);
      const item=await mutateQueue(queue=>{
        if(cooldown>now||readyAt>now)return null;
        const idx=queue.findIndex(j=>j.state==='queued'&&(Number(j.nextAttemptAt)||0)<=now);
        if(idx<0)return null;
        queue[idx]={...queue[idx],state:'processing',note:'Ryzex Gateway is preparing the media…'};
        return {...queue[idx]};
      });
      if(!item) {
        const future=(await readQueue()).filter(j=>j.state==='queued').map(j=>
          Math.max(Number(j.nextAttemptAt)||0,cooldown,readyAt));
        if(future.length) {
          const wakeAt=Math.min(...future),delay=Math.max(1,wakeAt-Date.now());
          // Alarms are a restart fallback, not a precise sub-minute timer.
          await chrome.alarms.create('ryzex-next',{when:Math.max(Date.now()+500,wakeAt)});
          if(delay<=PROCESS_REFILL_MS) {
            await new Promise(resolve=>setTimeout(resolve,delay));
            continue;
          }
        }
        break;
      }
      step++;
      // Reserve before the outgoing request; on retry we preserve the same
      // requestId and let Gateway idempotency prevent double quota charging.
      await chrome.storage.local.set({processPace:{tokens:pace.tokens-1,updatedAt:now}});
      void sendStatus(item);
      try {
        const result = await callCobalt(item);
        await updateJob(item.id,{state:'downloading',note:`Downloading ${result.started} files…`,percent:null,
          downloadIds:result.downloadIds,blobUrls:result.blobUrls,nextAttemptAt:0});
      } catch(e) {
        const current=(await readQueue()).find(j=>j.id===item.id);
        const retries=Number(current?.retries)||0;
        if(current?.downloadIds?.length) {
          await updateJob(item.id,{state:'downloading',note:'Finishing started files; some media could not be fetched.',partialError:stringifyError(e)});
        } else if(e.retryable && retries<5) {
          const nextAttemptAt=Date.now()+Math.max(1000,(Number(e.retryAfter)||15)*1000);
          await chrome.storage.local.set({nextProcessAt:nextAttemptAt});
          await updateJob(item.id,{state:'queued',note:'Waiting for the service rate limit or connection…',nextAttemptAt,retries:retries+1,percent:null});
        } else await updateJob(item.id,{state:'error',note:stringifyError(e),percent:null});
      }
      const current=(await readQueue()).find(j=>j.id===item.id);
      if(current?.state==='downloading')void monitorJob(current.id,current.downloadIds,current.blobUrls);
      // Yield to avoid spamming the Cobalt instance.
    }
  } finally { working = false; }
}

async function addToQueue(raw, actor) {
  const values = RyzexSecurity.normalizeQueueInput(raw, actor);
  if (actor.kind === 'content' && !allowClientBurst(actor.tabId)) {
    return {added:0, error:'Too many download requests. Wait a few seconds.'};
  }
  const added=await mutateQueue(queue=>{
  const existing = new Set(queue.filter(x => ['queued','processing','downloading'].includes(x.state)).map(x => x.url));
  const pending = queue.filter(x => ['queued','processing','downloading'].includes(x.state)).length;
  let added = 0;
  for (const link of values) {
    if (existing.has(link.url) || pending + added >= MAX_QUEUE) continue;
    queue.push({id:crypto.randomUUID(), url:link.url, platform:link.platform, state:'queued', note:'Queued', time:Date.now(), originTabId:actor.kind === 'content' ? actor.tabId : null});
    existing.add(link.url); added++;
  }
  return added;
  });
  void pump();
  return {added, total:values.length};
}

// Local Instagram CDN downloads: only accepted from an Instagram content script,
// never from websites or other platforms. These do not consume Gateway bandwidth
// or its server-side quota; no Cobalt key, cookies or page data are sent to us.
const instagramDashBlobs=new Map();
function releaseInstagramDash(id){
  const url=instagramDashBlobs.get(id);if(!url)return;
  instagramDashBlobs.delete(id);
  chrome.runtime.sendMessage({type:'RYZEX_OFFSCREEN_RELEASE',blobUrl:url}).catch(()=>{});
}
chrome.downloads.onChanged?.addListener(change=>{
  if(change?.state?.current==='complete'||change?.state?.current==='interrupted')
    releaseInstagramDash(change.id);
});
async function downloadInstagramNative(message,actor) {
  if(actor?.kind!=='content'||actor.platform!=='Instagram')
    throw new Error('Unauthorized Instagram download request.');
  const post=RyzexLinks.normalize(message?.postUrl);
  if(!post||post.platform!=='Instagram'||!/instagram\.com\/(?:p|tv)\//.test(post.url))
    throw new Error('Invalid post address.');
  const files=message?.files;
  if(!Array.isArray(files)||!files.length||files.length>20)
    throw new Error('Invalid number of post files.');
  const planned=[];
  for(const item of files){
    if(!item||!['image','video'].includes(item.type))
      throw new Error('Invalid media format.');
    if(item.type==='video'&&item.dash===true){
      const urls=[item.video,item.audio];
      if(!urls.every(x=>typeof x==='string'&&x.length<=4096&&
        RyzexDownloadPolicy.mediaUrl(x)===x&&RyzexDashCore.cleanUrl(x)===x))
        throw new Error('DASH media addresses are unsafe.');
      planned.push({dash:true,video:item.video,audio:item.audio});continue;
    }
    if(typeof item.url!=='string')throw new Error('Invalid media address.');
    const url=RyzexDownloadPolicy.mediaUrl(item.url);
    if(!url)throw new Error('No safe media address found.');
    const host=new URL(url).hostname.toLowerCase();
    if(!['cdninstagram.com','fbcdn.net'].some(h=>host===h||host.endsWith('.'+h)))
      throw new Error('Non-Instagram media blocked.');
    if(RyzexDownloadPolicy.dangerousFile({url}))throw new Error('Unsafe file type blocked.');
    const extension=(RyzexMediaPolicy.chooseExtension({url})||(item.type==='image'?'jpg':'mp4'));
    if(item.type==='image'&&!['jpg','jpeg','png','webp','avif','heic'].includes(extension))
      throw new Error('Unsupported photo type.');
    if(item.type==='video'&&!['mp4','webm','mov','m4v'].includes(extension))
      throw new Error('Unsupported video type.');
    planned.push({url,extension});
  }
  let started=0,failed=0,firstError='';
  for(const item of planned){
    let blobUrl=null;
    try {
      let options;
      if(item.dash){
        await ensureOffscreen();
        const jobId=crypto.randomUUID();
        const reply=await chrome.runtime.sendMessage({type:'RYZEX_INSTAGRAM_DASH_FETCH',
          jobId,video:item.video,audio:item.audio});
        if(!reply?.ok||typeof reply.blobUrl!=='string'||
          !reply.blobUrl.startsWith('blob:'+chrome.runtime.getURL('')))
          throw new Error(reply?.error||'Could not download DASH audio/video.');
        blobUrl=reply.blobUrl;
        options={url:blobUrl,filename:`RyzexMediaSaver/${RyzexMediaPolicy.randomName('Instagram')}.mp4`,
          conflictAction:'uniquify',saveAs:false};
      }else{
        options={url:item.url,filename:`RyzexMediaSaver/${RyzexMediaPolicy.randomName('Instagram')}.${item.extension}`,
          conflictAction:'uniquify',saveAs:false};
      }
      const id=await chrome.downloads.download(options);
      if(!Number.isInteger(id))throw new Error('Browser rejected the download.');
      if(blobUrl){
        instagramDashBlobs.set(id,blobUrl);
        // Edge may not fire a completion event after worker sleep; bound memory.
        const cleanupTimer=setTimeout(async()=>{
          if(!instagramDashBlobs.has(id))return;
          try{const items=await chrome.downloads.search({id});
            if(items?.[0]&&items[0].state==='in_progress')return;
          }catch{}
          releaseInstagramDash(id);
        },10*60*1000);
        cleanupTimer?.unref?.();
      }
      started++;
    }catch(e){
      if(blobUrl)await releaseBlob(blobUrl);
      failed++;if(!firstError)firstError=stringifyError(e);
    }
  }
  return {started,failed,error:firstError||null};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Service worker receives its own outgoing messages; leave those for the
  // offscreen document only, otherwise a competing error response may win.
  if(['RYZEX_OFFSCREEN_FETCH','RYZEX_OFFSCREEN_RELEASE','RYZEX_INSTAGRAM_DASH_FETCH'].includes(message?.type))return false;
  if(message?.type==='RYZEX_OFFSCREEN_PROGRESS') {
    if(sender?.id===chrome.runtime.id && sender.url===chrome.runtime.getURL('offscreen.html')
      && typeof message.jobId==='string' && message.jobId.length<120) {
      const n=Number(message.percent);
      const percent=message.percent===null || !Number.isFinite(n)?null:Math.min(99,Math.max(0,Math.floor(n)));
      void updateJob(message.jobId,{state:'processing',percent,
        note:percent===null?'Transferring media…':`Transferring media: ${percent}%`},['processing']);
    }
    return false;
  }
  (async () => {
    const actor = RyzexSecurity.senderKind(sender, chrome.runtime.id);
    if (!actor) return {error:'Unauthorized extension message blocked.'};
    if (actor.kind !== 'popup' && !['QUEUE_ADD','RYZEX_INSTAGRAM_MEDIA','I18N_GET'].includes(message?.type))
      return {error:'This action is available only in the extension popup.'};
    switch (message?.type) {
      case 'I18N_GET': return {language:normalizeLanguage((await chrome.storage.local.get('uiLanguage')).uiLanguage)};
      case 'QUEUE_ADD': return addToQueue(message.urls || [], actor);
      case 'RYZEX_INSTAGRAM_MEDIA': return downloadInstagramNative(message,actor);
      case 'QUEUE_GET': return {queue:await readQueue()};
      case 'QUEUE_CLEAR_DONE': {
        await mutateQueue(q=>{const active=q.filter(j=>['queued','processing','downloading'].includes(j.state));q.splice(0,q.length,...active);});
        return {ok:true};
      }
      case 'QUEUE_REMOVE_PENDING': {
        await mutateQueue(q=>{const active=q.filter(j=>j.state!=='queued');q.splice(0,q.length,...active);});
        return {ok:true};
      }
      case 'GATEWAY_STATUS': return gatewayStatus();
      case 'FEEDBACK_SEND': return sendFeedback(message);
      default: return {error:'Unknown action.'};
    }
  })().then(sendResponse).catch(e => sendResponse({error:stringifyError(e)}));
  return true;
});

let feedbackSending=null;
async function sendFeedback(payload){
  if(feedbackSending)throw new Error('Feedback is already being sent.');
  if(!payload||typeof payload.subject!=='string'||typeof payload.description!=='string'||
      !payload.subject.trim()||payload.subject.length>120||/[\x00-\x1f\x7f]/.test(payload.subject)||
      !payload.description.trim()||payload.description.length>1500||
      typeof payload.requestId!=='string'||!/^feedback_[a-f0-9-]{36}$/.test(payload.requestId))
    throw new Error('Please fill in the feedback fields.');
  feedbackSending=(async()=>{
    try{
      const token=await gatewayToken();
      const result=await gatewayRequest('/feedback',{method:'POST',token,timeout:20000,
        body:{subject:payload.subject,description:payload.description,requestId:payload.requestId}});
      if(result?.ok!==true)throw new Error('Invalid feedback response');
      return {ok:true};
    }catch(error){
      const message=String(error?.message||'');
      if(message.includes('rate_limited')||message.includes('HTTP 429'))throw new Error('Too many feedback requests. Try again later.');
      if(message.includes('not_configured')||message.includes('HTTP 404'))throw new Error('Feedback is temporarily unavailable. Please try again later.');
      throw new Error('Feedback could not be sent. Your draft has been kept.');
    }
  })().finally(()=>{feedbackSending=null;});
  return feedbackSending;
}
function normalizeLanguage(value){return ['en','tr','es','az','fr','ru'].includes(value)?value:'en';}
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area!=='local'||!changes.uiLanguage)return;
  const language=normalizeLanguage(changes.uiLanguage.newValue);
  void (async()=>{const tabs=await chrome.tabs.query({});await Promise.allSettled(tabs.filter(tab=>Number.isInteger(tab.id)).map(tab=>chrome.tabs.sendMessage(tab.id,{type:'RYZEX_LANGUAGE_CHANGED',language})));})().catch(()=>{});
});
chrome.alarms.create('ryzex-resume', {periodInMinutes:1}).catch(()=>{});
chrome.alarms.onAlarm.addListener(a => {if(['ryzex-resume','ryzex-next'].includes(a.name)) void pump();});
chrome.runtime.onStartup.addListener(() => {void gatewayToken().catch(()=>{});void pump();void resumeMonitors();});
chrome.runtime.onInstalled.addListener(() => {void gatewayToken().catch(()=>{});void pump();void resumeMonitors();});
