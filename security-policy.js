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
