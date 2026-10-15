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
