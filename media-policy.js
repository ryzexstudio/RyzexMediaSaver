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
