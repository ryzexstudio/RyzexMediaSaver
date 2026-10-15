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
