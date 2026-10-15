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
