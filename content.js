/* Ryzex Media Saver v0.6.15
 * TikTok: quick download icon only (native Copy never triggers a download prompt).
 * Instagram: download between Repost and Share. No three-dots menu entry.
 * X: native Share-adjacent action.
 */
(() => {
  'use strict';
  // Allow manual activation from the popup if TikTok blocked initial injection.
  // Do not install duplicate handlers on the same page.
  const activeVersion = '0.6.19';
  const I18N = globalThis.RyzexI18n || {bind(node,value,attribute){if(attribute)node.setAttribute(attribute,value);else node.textContent=value;}};
  if(globalThis.RyzexI18n)void I18N.init('content');
  if (window.__ryzexSaverReady &&
      (location.hostname.endsWith('tiktok.com')
        ? document.documentElement?.getAttribute('data-ryzex-tiktok-listener') === activeVersion
        : true)) return;

  const normalize = RyzexLinks.normalize;
  const parseMany = RyzexLinks.parseMany;
  const marker = 'data-ryzex-native-download';
  const hostname = location.hostname.toLowerCase();
  const platform = hostname.endsWith('tiktok.com') ? 'tiktok'
    : hostname.endsWith('instagram.com') ? 'instagram'
    : ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(hostname) ? 'x' : null;
  if (!platform) return;

  let lastMenuUrl = null;
  let scanPending = false;
  let observed = false;

  let toastHost = null;
  let toastTimer = null;
  let toastCleanupTimer = null;
  let currentProgressJob = null;

  // Ryzex notifications fade and slide in/out. No zoom/scale effects.
  function showToast(message, kind = 'info') {
    if (!message) return;
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.setAttribute('data-ryzex-toast-host', '1');
      const shadow = toastHost.attachShadow({mode:'open'});
      const style = document.createElement('style');
      style.textContent = `
        *{box-sizing:border-box}
        .wrap{position:fixed;right:18px;bottom:20px;z-index:2147483647;pointer-events:none}
        .toast{display:flex;gap:10px;align-items:flex-start;max-width:min(350px,calc(100vw - 36px));min-width:225px;
          padding:12px 14px;border-radius:13px;background:#151923;color:#f6f7fb;border:1px solid #32384c;
          box-shadow:0 10px 30px rgba(0,0,0,.27);opacity:0;transform:translateX(20px);
          transition:opacity 260ms ease,transform 260ms cubic-bezier(.22,1,.36,1);
          font:500 12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
        .toast.show{opacity:1;transform:translateX(0)}
        .accent{width:3px;min-height:34px;border-radius:5px;background:#778aff;flex:none}
        .toast.success .accent{background:#39ca9f}.toast.error .accent{background:#ff6b83}
        .body{min-width:0;flex:1}.brand{font-size:10px;font-weight:800;letter-spacing:.8px;color:#aeb8ff;margin-bottom:2px}
        .message{overflow-wrap:anywhere;color:#e8eaf2}
        .progress-track{height:7px;margin-top:10px;border-radius:999px;background:#333b51;overflow:hidden;display:none}
        .progress-fill{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#23c2f8,#9364ff);transition:width .25s ease}
        .toast.progress .progress-track{display:block}
        .toast.progress .accent{background:#8b7cff}
        .toast.progress .progress-track.unknown .progress-fill{width:35%;animation:ryzex-slide 1.3s ease-in-out infinite}
        @keyframes ryzex-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
        @media(prefers-reduced-motion:reduce){.toast{transition:none;transform:none}}
      `;
      const wrap=document.createElement('div');wrap.className='wrap';
      const toast=document.createElement('div');toast.className='toast';
      toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');
      const accent=document.createElement('div');accent.className='accent';
      const body=document.createElement('div');body.className='body';
      const brand=document.createElement('div');brand.className='brand';brand.textContent='RYZEXSTUDIO';
      const text=document.createElement('div');text.className='message';
      const track=document.createElement('div');track.className='progress-track';
      const fill=document.createElement('div');fill.className='progress-fill';track.append(fill);
      body.append(brand,text,track);toast.append(accent,body);wrap.append(toast);shadow.append(style,wrap);
      document.documentElement.append(toastHost);
    }
    clearTimeout(toastTimer);
    clearTimeout(toastCleanupTimer);
    const current=toastHost;
    const toast=current.shadowRoot.querySelector('.toast');
    toast.className=`toast ${kind}`;
    I18N.bind(current.shadowRoot.querySelector('.message'),message);
    requestAnimationFrame(()=>{ if(toastHost===current) toast.classList.add('show'); });
    // Active progress remains visible until an actual completed/interrupted event.
    if (kind==='progress') return;
    toastTimer=setTimeout(()=>{
      if(toastHost!==current) return;
      toast.classList.remove('show');
      toastCleanupTimer=setTimeout(()=>{
        if(toastHost===current && !toast.classList.contains('show')) {
          current.remove();toastHost=null;
        }
      },320);
    },4200);
  }

  function showProgressToast(jobId, note, percent) {
    if (currentProgressJob && currentProgressJob!==jobId) return;
    currentProgressJob=jobId;
    const valid=typeof percent==='number' && Number.isFinite(percent);
    const pct=valid ? Math.max(0,Math.min(99,Math.floor(percent))) : null;
    showToast(pct===null?(note||'Preparing download…'):`Downloading: ${pct}%`, 'progress');
    const track=toastHost?.shadowRoot?.querySelector('.progress-track');
    if (!track) return;
    track.classList.toggle('unknown',pct===null);
    track.querySelector('.progress-fill').style.width=pct===null?'35%':`${pct}%`;
  }

  function finishProgressToast(jobId, note, kind) {
    if (currentProgressJob && currentProgressJob!==jobId) return;
    currentProgressJob=null;
    showToast(note,kind);
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 &&
      bounds.top < window.innerHeight && bounds.left < window.innerWidth;
  }

  function postIn(container) {
    if (!container) return null;
    // A permalink around the post timestamp is usually the correct tweet.
    if (platform === 'x') {
      const timeLink = container.querySelector('time')?.closest('a[href]');
      const found = normalize(timeLink?.href);
      if (found) return found.url;
    }
    const links = container.querySelectorAll('a[href]');
    const urls = new Set();
    for (const link of links) {
      const parsed = normalize(link.href);
      if (parsed) urls.add(parsed.url);
      if (urls.size > 2) break;
    }
    // Never select an arbitrary post if several are present (e.g. quoted tweets).
    return urls.size === 1 ? [...urls][0] : null;
  }

  function copyPanelPost() {
    if (platform !== 'tiktok') return null;
    const elements = document.querySelectorAll('input, textarea, [data-e2e*="copy-link"], [data-e2e*="share-copy"], [class*="CopyLink"]');
    for (const el of elements) {
      if (!visible(el)) continue;
      const text = typeof el.value === 'string' ? el.value : el.textContent || '';
      if (text.length > 1200) continue;
      const entry = parseMany(text, 1)[0];
      if (entry?.platform === 'TikTok') return entry.url;
    }
    // TikTok's share panel often shows a read-only link next to Copy link.
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const el of buttons) {
      if (!visible(el)) continue;
      const caption = (el.textContent || el.getAttribute('aria-label') || '').trim();
      if (!/^(copy link|copy|bağlantıyı kopyala|linki kopyala|kopyala)$/i.test(caption)) continue;
      const context = el.parentElement?.textContent || '';
      if (context.length > 1200) continue;
      const entry = parseMany(context, 1)[0];
      if (entry?.platform === 'TikTok') return entry.url;
    }
    return null;
  }


  function tiktokContextContainer(element) {
    return element?.closest('[data-e2e="recommend-list-item-container"], [data-e2e="browse-video"], [data-e2e="feed-video"], [data-e2e="video-player"]')
      || element?.closest('article, section, main, div');
  }

  function tiktokUrlFromContainer(container, preferredId = '') {
    if (!container) return null;
    const directAnchors = container.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
    for (const anchor of directAnchors) {
      const parsed = normalize(anchor.href);
      if (parsed?.platform === 'TikTok') return parsed.url;
    }
    const authorLinks = container.querySelectorAll('a[href*="/@"]');
    let author = '';
    for (const anchor of authorLinks) {
      const href = anchor.getAttribute('href') || '';
      const m = href.match(/\/@([^/?#]+)/);
      if (m && !/\/(video|photo)\//i.test(href)) { author = m[1]; break; }
    }
    const anyIdMatch = (container.innerHTML || '').match(/data-more-menu-item-id="(\d{8,})"/i)
      || (container.textContent || '').match(/https:\/\/www\.tiktok\.com\/@[^\s]+\/(?:video|photo)\/(\d{8,})/i);
    const videoId = preferredId || anyIdMatch?.[1] || '';
    if (author && videoId) return `https://www.tiktok.com/@${author}/video/${videoId}`;
    return null;
  }

  function resolveTikTokUrlNear(element) {
    const preferredId = element?.dataset?.ryzexVideoId || element?.getAttribute?.('data-more-menu-item-id') || '';
    const container = tiktokContextContainer(element);
    const fromContainer = tiktokUrlFromContainer(container, preferredId);
    if (fromContainer) return fromContainer;
    if (preferredId) {
      for (const anchor of document.querySelectorAll('a[href*="/@"]')) {
        const href = anchor.getAttribute('href') || '';
        const m = href.match(/\/@([^/?#]+)/);
        if (m && !/\/(video|photo)\//i.test(href)) return `https://www.tiktok.com/@${m[1]}/video/${preferredId}`;
      }
    }
    return null;
  }

  function resolveCurrentUrl() {
    const current = normalize(location.href)?.url;
    if (current) return current;
    if (platform === 'tiktok') {
      const fromPanel = copyPanelPost();
      if (fromPanel) return fromPanel;
      // Single visible post on screen (do not select from a multi-post grid).
      const visibleLinks = new Set();
      for (const a of document.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')) {
        if (!visible(a)) continue;
        const parsed = normalize(a.href);
        if (parsed) visibleLinks.add(parsed.url);
        if (visibleLinks.size > 1) break;
      }
      if (visibleLinks.size === 1) return [...visibleLinks][0];
    }
    return lastMenuUrl;
  }

  function sourceOfTrigger(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    if (!el) return null;
    const article = el.closest('article, [data-testid="tweet"], [data-e2e="recommend-list-item-container"], [data-e2e="browse-video"]');
    return postIn(article);
  }

  function isMenuTrigger(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    if (!el) return false;
    if (platform === 'x') return !!el.closest('[data-testid="caret"], button[aria-label="More"], button[aria-label="More options"]');
    if (platform === 'instagram') return !!el.closest('button[aria-label*="More"], button[aria-label*="more"], [aria-label="Options"], [data-testid="post-options"], svg[aria-label*="More"], svg[aria-label*="more"]')
      || !!el.closest('button')?.querySelector('svg[aria-label*="More"], svg[aria-label*="more"]');
    return !!el.closest('[data-e2e*="more-icon"], [data-e2e*="more-btn"], button[aria-label="More"], button[aria-label="More options"], [aria-haspopup="menu"]');
  }

  document.addEventListener('pointerdown', event => {
    if (!isMenuTrigger(event.target)) return;
    // The next portal belongs to the post whose menu was just opened.
    lastMenuUrl = sourceOfTrigger(event.target) || normalize(location.href)?.url || null;
    scheduleScan();
  }, true);

  function downloadIcon(viewBox = '0 0 24 24') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (viewBox === '0 0 48 48') {
      path.setAttribute('d', 'M22 5a2 2 0 0 1 4 0v23.17l7.59-7.58a2 2 0 0 1 2.82 2.82l-11 11a2 2 0 0 1-2.82 0l-11-11a2 2 0 0 1 2.82-2.82L22 28.17V5ZM8 38a2 2 0 0 1 2-2h28a2 2 0 0 1 0 4H10a2 2 0 0 1-2-2Z');
    } else {
      path.setAttribute('d', 'M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 0 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM4 19a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Z');
    }
    svg.append(path);
    return svg;
  }

  function sendDownload(row, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const url = resolveCurrentUrl();
    if (!url) {
      updateLabel(row, 'Open the post first');
      return;
    }
    if (row.dataset.ryzexBusy === '1') return;
    row.dataset.ryzexBusy = '1';
    updateLabel(row, 'Adding…');
    chrome.runtime.sendMessage({type:'QUEUE_ADD', urls:[url]}, result => {
      row.dataset.ryzexBusy = '0';
      if (chrome.runtime.lastError || result?.error) {
        updateLabel(row, 'Download failed');
        showToast(result?.error || chrome.runtime.lastError?.message || 'Could not send the request.', 'error');
      } else {
        updateLabel(row, result?.added ? 'Added to downloads ✓' : 'Already in queue');
        showToast(result?.added ? 'Download request queued.' : 'This post is already in the queue.', 'info');
      }
    });
  }

  function wire(row) {
    row.setAttribute(marker, '1');
    I18N.bind(row, 'Download media with Ryzex Media Saver','aria-label');
    row.addEventListener('click', e => sendDownload(row, e), true);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') sendDownload(row, e);
    }, true);
    return row;
  }

  function updateLabel(row, text) {
    const target = row.querySelector('[data-ryzex-label]');
    if (target) I18N.bind(target,text);
  }

  // TikTok owns the Copy link action. We leave its click handler intact and
  // offer an optional download after the site's copy operation has run.
  // Reading clipboard contents is intentionally NOT required or requested.
  let lastCopyTime = 0;
  let promptHost = null;

  // The current TikTok "Copy" control is a DIV, not a BUTTON:
  // <div data-e2e="share-copy"><div tabindex="0"><svg>...</svg><p>Copy</p></div></div>
  // Inspect the event's entire composed path so clicking SVG descendants works,
  // even when TikTok uses nested components or an internal shadow root.
  function tiktokCopyElement(event) {
    if (platform !== 'tiktok') return null;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.closest('[data-ryzex-copy-prompt]')) return null;
      if (node.matches('[data-e2e="share-copy"], [data-e2e="share-copy-link"], [data-e2e="copy-link"]')) return node;
      const parent = node.closest('[data-e2e="share-copy"], [data-e2e="share-copy-link"], [data-e2e="copy-link"]');
      if (parent) return parent;
      // Fallback for older share dialogs without data-e2e markers.
      if (/^(copy|copy link|kopyala|bağlantıyı kopyala|linki kopyala)$/i.test((node.textContent || '').trim()) &&
          node.closest('[role="dialog"], [class*="share"], [class*="Share"]') &&
          node.children.length <= 4 &&
          (node.matches('button, [role="button"], [tabindex]') ||
           node.parentElement?.matches('[class*="share"], [class*="Share"]'))) return node;
    }
    return null;
  }

  function copyActionPost(target) {
    // Read ONLY the containing share UI; never use an unrelated post link.
    let ancestor = target instanceof Element ? target : target?.parentElement;
    for (let depth = 0; ancestor && depth < 7; ancestor = ancestor.parentElement, depth++) {
      const text = ancestor.textContent || '';
      if (text.length > 3500) continue;
      const entry = parseMany(text, 2).find(x => x.platform === 'TikTok');
      if (entry) return entry.url;
      for (const field of ancestor.querySelectorAll('input,textarea,[data-url]')) {
        const value = field.value || field.getAttribute('data-url') || '';
        const parsed = normalize(value.trim());
        if (parsed?.platform === 'TikTok') return parsed.url;
      }
    }
    const fromPanel = copyPanelPost();
    if (fromPanel) return fromPanel;
    const route = normalize(location.href);
    if (route?.platform === 'TikTok') return route.url;
    // A visible detail view sometimes exposes its video link in the page.
    // If more than one permalink is visible, do not guess which one was copied.
    const matches = new Set();
    for (const anchor of document.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')) {
      if (!visible(anchor)) continue;
      const parsed = normalize(anchor.href);
      if (parsed?.platform === 'TikTok') matches.add(parsed.url);
      if (matches.size > 1) break;
    }
    return matches.size === 1 ? [...matches][0] : null;
  }

  function dismissCopyPrompt() {
    if (!promptHost) return;
    promptHost.remove();
    promptHost = null;
  }

  function openCopyPrompt(url) {
    dismissCopyPrompt();
    const host = document.createElement('div');
    host.setAttribute('data-ryzex-copy-prompt', '1');
    // Shadow DOM avoids inheriting TikTok's frequently changing component CSS.
    const shadow = host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box} .backdrop{position:fixed;inset:0;z-index:2147483647;
      background:rgba(0,0,0,.64);display:flex;justify-content:center;align-items:center;
      padding:22px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#f8f8f8}
      .panel{background:#242424;border:1px solid #484848;width:min(390px,100%);
      border-radius:16px;padding:23px;box-shadow:0 15px 48px #0008}
      h2{font-size:20px;line-height:1.25;margin:0 0 10px;font-weight:750}
      p{font-size:14px;line-height:1.55;color:#d6d6d6;margin:0 0 19px}
      .row{display:flex;gap:10px;justify-content:flex-end}
      button{font:700 14px system-ui,sans-serif;padding:12px 16px;border-radius:9px;cursor:pointer}
      .cancel{background:#393939;color:white;border:1px solid #555}
      .confirm{background:#fe2c55;color:white;border:1px solid #fe2c55}
      button:focus-visible{outline:2px solid #25f4ee;outline-offset:2px}
      .hint{font-size:12px;color:#aaa;overflow-wrap:anywhere;margin:-5px 0 20px}
      .status{font-size:13px;color:#c0f5ee;margin-top:10px;min-height:0}`;
    shadow.append(style);
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-modal','true');
    const title = document.createElement('h2');
    I18N.bind(title,url ? 'Download this video?' : 'Video link not found');
    title.id = 'ryzex-dialog-title';
    panel.setAttribute('aria-labelledby',title.id);
    const p = document.createElement('p');
    I18N.bind(p,url ? 'You copied the link. Download this video with Ryzex Media Saver?' :
      'TikTok is not showing the link. Open the video in a new tab and try Copy again.');
    const controls = document.createElement('div');
    controls.className = 'row';
    const cancel = document.createElement('button');
    cancel.type='button'; cancel.className='cancel';I18N.bind(cancel,url?'No':'Close');
    cancel.addEventListener('click',dismissCopyPrompt);
    controls.append(cancel);
    if (url) {
      const hint = document.createElement('div'); hint.className = 'hint';hint.textContent = url;
      panel.append(title,p,hint);
      const confirm = document.createElement('button');
      confirm.type='button'; confirm.className='confirm'; I18N.bind(confirm,'Yes, download');
      const status = document.createElement('div');status.className='status'; status.setAttribute('role','status');
      confirm.addEventListener('click', () => {
        confirm.disabled=true;I18N.bind(confirm,'Adding to the queue…');
        chrome.runtime.sendMessage({type:'QUEUE_ADD',urls:[url]}, result => {
          if (!host.isConnected) return;
          if (chrome.runtime.lastError || result?.error) {
            I18N.bind(status,result?.error || chrome.runtime.lastError?.message || 'Operation failed.');
            confirm.disabled=false;I18N.bind(confirm,'Try again');
          } else {
            I18N.bind(status,result?.added ? 'Added to the download queue.' : 'Already in queue');
            I18N.bind(confirm,'Done');
            confirm.disabled=true;
            setTimeout(() => {if (promptHost===host) dismissCopyPrompt();},1000);
          }
        });
      });
      controls.append(confirm);panel.append(controls,status);
    } else panel.append(title,p,controls);
    backdrop.append(panel);shadow.append(backdrop);
    backdrop.addEventListener('click', e=> {if (e.target===backdrop) dismissCopyPrompt();});
    shadow.addEventListener('keydown', e=>{if (e.key==='Escape'){e.preventDefault();dismissCopyPrompt();}});
    document.documentElement.append(host);
    promptHost=host;
    document.documentElement.dataset.ryzexPrompt = 'shown';
    cancel.focus();
  }

  function handleTikTokCopy(event) {
    // Native keyboard activation may cause click as well, so deduplicate both.
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const copyButton = tiktokCopyElement(event);
    if (!copyButton) return;
    const now = Date.now();
    if (now - lastCopyTime < 750) return;
    lastCopyTime = now;
    const link = copyActionPost(copyButton);
    const root = document.documentElement;
    if (root) {
      root.dataset.ryzexLastCopy = String(now);
      root.dataset.ryzexLastLink = link ? 'found' : 'missing';
    }
    console.info('[Ryzex Media Saver] TikTok Copy event captured; link:', link ? 'detected' : 'not detected');
    // Do not preventDefault/stopPropagation: TikTok still copies the URL.
    // Run AFTER the original event, allowing TikTok's own handler to finish.
    setTimeout(() => openCopyPrompt(link), 400);
  }
  if (platform === 'tiktok') {
    // Native Copy remains untouched. Only the visible in-page download icon
    // triggers downloads; no Copy listeners or confirmation prompt.
    document.documentElement.setAttribute('data-ryzex-tiktok-listener', activeVersion);
  }

  function updateQuickButtonState(button, text) {
    if (!button) return;
    I18N.bind(button,text,'title');
    I18N.bind(button,text,'aria-label');
  }

  function sendQuickDownload(button, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const url = platform === 'tiktok'
      ? (button.dataset.ryzexTikTokBrowse === '1' ? resolveCurrentUrl() : (resolveTikTokUrlNear(button) || button.dataset.ryzexDirectUrl || resolveCurrentUrl()))
      : resolveCurrentUrl();
    if (!url) {
      updateQuickButtonState(button, 'Post link not found');
      showToast('Video link not found. Open the video or try Copy.', 'error');
      setTimeout(() => updateQuickButtonState(button, 'Download with Ryzex Media Saver'), 1800);
      return;
    }
    button.dataset.ryzexDirectUrl = url;
    if (button.dataset.ryzexBusy === '1') return;
    button.dataset.ryzexBusy = '1';
    updateQuickButtonState(button, 'Adding…');
    chrome.runtime.sendMessage({type:'QUEUE_ADD', urls:[url]}, result => {
      button.dataset.ryzexBusy = '0';
      if (chrome.runtime.lastError || result?.error) {
        updateQuickButtonState(button, 'Download failed');
        showToast(result?.error || chrome.runtime.lastError?.message || 'Could not start the download.', 'error');
      } else if (result?.added) {
        updateQuickButtonState(button, 'Added to downloads ✓');
        showToast('Download request queued.', 'info');
      } else {
        updateQuickButtonState(button, 'Already in queue');
        showToast('This post is already in the queue.', 'info');
      }
      setTimeout(() => updateQuickButtonState(button, 'Download with Ryzex Media Saver'), 1800);
    });
  }

  function wireQuickButton(button) {
    button.setAttribute(marker, '1');
    button.dataset.ryzexQuick = '1';
    updateQuickButtonState(button, 'Download with Ryzex Media Saver');
    button.addEventListener('click', e => sendQuickDownload(button, e), true);
    button.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') sendQuickDownload(button, e);
    }, true);
    return button;
  }

  function addTikTokQuickButtons() {
    const moreButtons = document.querySelectorAll('button[data-e2e="more-menu-icon"]');
    for (const button of moreButtons) {
      if (!visible(button)) continue;
      const wrapper = button.closest('[data-key-interaction="video_more_menu"]') || button.parentElement;
      const actionsRow = wrapper?.parentElement;
      if (!wrapper || !actionsRow) continue;
      const existing=actionsRow.querySelector('[data-ryzex-quick="1"]');
      if(existing) {
        existing.dataset.ryzexVideoId=button.getAttribute('data-more-menu-item-id')||'';
        const current=resolveTikTokUrlNear(button);
        if(current)existing.dataset.ryzexDirectUrl=current;else delete existing.dataset.ryzexDirectUrl;
        continue;
      }

      const cloneWrapper = wrapper.cloneNode(true);
      cloneWrapper.removeAttribute('data-key-interaction');
      const cloneButton = cloneWrapper.querySelector('button');
      if (!cloneButton) continue;
      const sourceId = button.getAttribute('data-more-menu-item-id') || '';
      for (const el of [cloneWrapper, cloneButton, ...cloneWrapper.querySelectorAll('*')]) {
        el.removeAttribute('data-e2e');
        el.removeAttribute('data-more-menu-item-id');
        el.removeAttribute('aria-expanded');
        el.removeAttribute('aria-haspopup');
      }
      if (sourceId) cloneButton.dataset.ryzexVideoId = sourceId;
      const nearbyUrl = resolveTikTokUrlNear(button);
      if (nearbyUrl) cloneButton.dataset.ryzexDirectUrl = nearbyUrl;
      cloneButton.type = 'button';
      const iconSlot = cloneWrapper.querySelector('.TUXButton-iconContainer');
      if (iconSlot) {
        iconSlot.textContent = '';
        iconSlot.append(downloadIcon('0 0 48 48'));
      }
      wireQuickButton(cloneButton);
      actionsRow.insertBefore(cloneWrapper, wrapper);
    }
  }

  // TikTok permalink pages use a DIV with data-e2e="browse-ellipsis"
  // instead of the feed's button[data-e2e="more-menu-icon"].
  // Place our native-looking action immediately before that ellipsis.
  // TikTok's permalink ellipsis is often in a stacked or absolute-positioned
  // layout. Putting another sibling in its wrapper makes two icons overlap.
  // Instead, mount an independent Shadow DOM control above the page layout,
  // position it LEFT of the ellipsis, and follow the ellipsis on scroll/resize.
  // This leaves TikTok's React-owned DOM and click handler completely intact.
  const browseControls = new Map();
  let browsePositionPending = false;

  function updateTikTokBrowsePositions() {
    const onVideo = !!normalize(resolveCurrentUrl()) &&
      /\/(?:video|photo)\/\d+/.test(location.pathname);
    for (const [more, {host}] of browseControls) {
      if (!onVideo || !more.isConnected) {
        host.remove();
        browseControls.delete(more);
        continue;
      }
      const rect = more.getBoundingClientRect();
      // Avoid controls floating over another post or outside the viewport.
      const shown = visible(more) && rect.width >= 16 && rect.height >= 16;
      const side = 34;
      const gap = 10;
      let left = Math.round(rect.left - gap - side);
      if (left < 8) left = Math.round(rect.right + gap);
      const top = Math.round(rect.top + (rect.height - side) / 2);
      const fit = left >= 4 && left + side <= window.innerWidth - 4 &&
        top >= 0 && top + side <= window.innerHeight;
      const nextDisplay = shown && fit ? 'block' : 'none';
      if (host.style.display !== nextDisplay) host.style.display = nextDisplay;
      if (nextDisplay === 'none') continue;
      const x = `${left}px`;
      const y = `${top}px`;
      if (host.style.left !== x) host.style.left = x;
      if (host.style.top !== y) host.style.top = y;
      // Match the real icon in both dark and light TikTok themes.
      const color = getComputedStyle(more).color;
      if (host.style.getPropertyValue('--ryzex-icon-color') !== color)
        host.style.setProperty('--ryzex-icon-color', color);
    }
  }

  function scheduleTikTokBrowsePositions() {
    if (browsePositionPending) return;
    browsePositionPending = true;
    requestAnimationFrame(() => {
      browsePositionPending = false;
      updateTikTokBrowsePositions();
    });
  }

  function removeLegacyTikTokBrowseButtons() {
    // Versions <= 0.6.9 inserted a clone of TikTok's .css-1ii2zgo as a
    // sibling of [data-e2e="browse-ellipsis"]. TikTok absolutely positions
    // both clones at the same coordinates. Retire these stale nodes only;
    // never touch native TikTok controls, feed download buttons, or our portal.
    for (const el of document.querySelectorAll('[data-ryzex-tik-tok-browse="1"]')) {
      if (el.closest('[data-ryzex-tiktok-browse-host]')) continue;
      el.remove();
    }
  }

  function addTikTokBrowseButtons() {
    removeLegacyTikTokBrowseButtons();
    const current = resolveCurrentUrl();
    if (!current || !normalize(current) ||
        !/\/(?:video|photo)\/\d+/.test(location.pathname)) {
      updateTikTokBrowsePositions();
      return;
    }
    for (const more of document.querySelectorAll('[data-e2e="browse-ellipsis"]')) {
      if (!visible(more) || browseControls.has(more)) continue;

      // Stale portals from a previous injected code generation do not have
      // this version's event listeners; avoid leaving dead UI layers behind.
      for (const stale of document.querySelectorAll('[data-ryzex-tiktok-browse-host]')) {
        if (stale.getAttribute('data-ryzex-owner-version') !== activeVersion) stale.remove();
      }
      const host = document.createElement('div');
      host.setAttribute('data-ryzex-owner-version',activeVersion);
      host.setAttribute('data-ryzex-tiktok-browse-host', '1');
      // The portal is deliberately outside more.parentElement to avoid the
      // absolute/stacking layout that hid the previous sibling behind '...'.
      host.style.position = 'fixed';
      host.style.zIndex = '2147483636';
      host.style.width = '34px';
      host.style.height = '34px';
      host.style.pointerEvents = 'auto';

      const shadow = host.attachShadow({mode:'open'});
      const stylesheet = document.createElement('style');
      stylesheet.textContent = `
        :host { all:initial; position:fixed; width:34px; height:34px; z-index:2147483636; }
        button { all:unset; box-sizing:border-box; display:flex; width:34px; height:34px;
          align-items:center; justify-content:center; border-radius:9px;
          color:var(--ryzex-icon-color,#fff); background:transparent;
          cursor:pointer; -webkit-tap-highlight-color:transparent; }
        button:hover { background:rgba(140,140,140,.18); }
        button:focus-visible { outline:2px solid #8b90ff; outline-offset:2px; }
        svg { display:block; width:24px; height:24px; fill:currentColor; pointer-events:none; }
      `;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.ryzexTikTokBrowse = '1';
      button.append(downloadIcon('0 0 48 48'));
      wireQuickButton(button);
      shadow.append(stylesheet, button);
      document.documentElement.append(host);
      browseControls.set(more,{host,button});
    }
    updateTikTokBrowsePositions();
  }

  function exactAction(container, options) {
    const possible = container.querySelectorAll('button, [role="menuitem"], [role="button"]');
    for (const value of options) {
      for (const item of possible) {
        if (item.hasAttribute(marker)) continue;
        if ((item.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase() === value.toLowerCase()) return item;
      }
    }
    return null;
  }

  // Copy a *native* menu item, preserving each site's menu typography,
  // spacing, focus and hover behavior. Never overlay the video player.
  function cloneNativeAction(template) {
    const clone = template.cloneNode(true);
    for (const item of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of ['id', 'data-testid', 'data-e2e', 'aria-describedby', 'aria-labelledby', 'aria-controls', 'href']) {
        item.removeAttribute(attr);
      }
      if (item !== clone) item.removeAttribute('aria-label');
    }
    const allTextNodes = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) allTextNodes.push(walker.currentNode);
    if (allTextNodes.length) {
      // Replace the label without dropping the nested site styling.
      allTextNodes[0].nodeValue = 'Download';
      for (const extra of allTextNodes.slice(1)) extra.nodeValue = '';
      allTextNodes[0].parentElement.setAttribute('data-ryzex-label','1');
    } else {
      clone.textContent = '';
      const label = document.createElement('span');
      I18N.bind(label,'Download'); label.setAttribute('data-ryzex-label', '1');
      clone.append(label);
    }
    const svg = clone.querySelector('svg');
    if (svg) {
      const fresh = downloadIcon();
      // Keep the platform's existing icon container and dimensions.
      fresh.setAttribute('class', svg.getAttribute('class') || '');
      svg.replaceWith(fresh);
    }
    if (clone instanceof HTMLButtonElement) clone.type = 'button';
    clone.tabIndex = 0;
    return wire(clone);
  }

  function instagramPostNear(node) {
    const pageLink=normalize(location.href);
    const post=instagramPostRoot(node);
    if(post) {
      const candidates=new Set();
      const anchors=[...post.querySelectorAll('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]')];
      // A post's timestamp is its own permalink, unlike recommendation links.
      const timestamp=anchors.find(anchor=>anchor.querySelector('time'));
      const timestampLink=timestamp&&normalize(timestamp.href);
      if(timestampLink?.platform==='Instagram')return timestampLink.url;
      if(pageLink?.platform==='Instagram' && /instagram\.com\/(?:p|tv|reel)\//.test(pageLink.url))return pageLink.url;
      for(const anchor of anchors) {
        const link=normalize(anchor.href);
        if(link?.platform==='Instagram')candidates.add(link.url);
        if(candidates.size>1)break;
      }
      if(candidates.size===1)return [...candidates][0];
      if(candidates.size>1)return null;
    }
    const current=normalize(location.href);
    return current?.platform==='Instagram'?current.url:null;
  }

  // Instagram's own rendered media is the source for /p/ and /tv/ posts.
  // This is deliberately separate from the Gateway/Cobalt flow for Reels.
  function instagramPostRoot(button) {
    // In modal/split layouts the action column can be a sibling of the media;
    // the closest article is not necessarily the complete post container.
    for(let root=button.parentElement;root && root!==document.body;root=root.parentElement){
      if(root.querySelectorAll('video, img').length &&
          [...root.querySelectorAll('video, img')].some(el=>el.isConnected &&
            !el.closest('header, footer, [role="navigation"]') && instagramMediaVisibleArea(el,root)>0))return root;
      if(root.matches('main,[role="main"],[role="dialog"]'))break;
    }
    return button.closest('article, [role="dialog"], [data-testid="post"]');
  }

  const instagramBusyPosts=new WeakSet();

  function instagramCarouselNav(root, direction) {
    if (!root) return null;
    const names=direction==='next' ? /^(next|next slide|next photo|next media|ileri|sonraki|sonraki gönderi|sonraki fotoğraf|siguiente|suivant|suivante|далее|вперёд|следующее|növbəti)$/i
      : /^(previous|previous slide|previous photo|previous media|go back|back|geri|önceki|önceki gönderi|önceki fotoğraf|anterior|précédent|précédente|назад|предыдущее|əvvəlki)$/i;
    for (const el of root.querySelectorAll('button[aria-label], [role="button"][aria-label], svg[aria-label]')) {
      const label=el.getAttribute('aria-label')||'';
      if(!names.test(label.trim()))continue;
      const target=el.closest('button,[role="button"]');
      if(target && !target.hasAttribute('disabled') && target.getAttribute('aria-disabled')!=='true' && visible(target))return target;
    }
    return null;
  }

  function instagramCarousel(root) {
    if(instagramCarouselNav(root,'next')||instagramCarouselNav(root,'previous'))return true;
    return !!root?.querySelector('li[aria-label*="of"], [data-testid="carousel"], [aria-roledescription="carousel"], [aria-roledescription="slide"]');
  }

  function instagramDirectMediaUrl(raw) {
    try {
      const u=new URL(raw);
      if(u.protocol!=='https:' || u.username || u.password || u.port)return null;
      const host=u.hostname.toLowerCase();
      // Range-limited MP4 URLs contain only a fragment, not a complete video.
      if(u.searchParams.has('bytestart')||u.searchParams.has('byteend'))return null;
      return ['cdninstagram.com','fbcdn.net'].some(domain=>host===domain || host.endsWith('.'+domain))?u.href:null;
    } catch {return null;}
  }

  // Instagram mounts adjacent carousel slides ahead of time. Their bounding
  // rectangles can still be inside the browser viewport even when they are
  // fully clipped by the carousel's overflow container. Score media by the
  // *actually visible* pixels, not merely by document viewport intersection.
  function instagramMediaVisibleArea(el, root) {
    const b=el.getBoundingClientRect();
    if(b.width<145||b.height<145)return 0;
    let left=Math.max(0,b.left),right=Math.min(innerWidth,b.right);
    let top=Math.max(0,b.top),bottom=Math.min(innerHeight,b.bottom);
    if(right<=left||bottom<=top)return 0;
    if(typeof getComputedStyle==='function') {
      for(let ancestor=el.parentElement;ancestor&&ancestor!==root.parentElement;ancestor=ancestor.parentElement){
        const css=getComputedStyle(ancestor);
        // overflow: auto/hidden/clip/scroll all limit the visible region.
        if(/hidden|clip|auto|scroll/.test(css.overflowX||css.overflow||'')) {
          const r=ancestor.getBoundingClientRect();
          left=Math.max(left,r.left);right=Math.min(right,r.right);
        }
        if(/hidden|clip|auto|scroll/.test(css.overflowY||css.overflow||'')) {
          const r=ancestor.getBoundingClientRect();
          top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);
        }
        if(right<=left||bottom<=top)return 0;
        if(ancestor===root)break;
      }
    }
    const area=Math.max(0,right-left)*Math.max(0,bottom-top);
    // Reject media only peeking in from a neighboring carousel slide.
    return area/(b.width*b.height)<0.52 ? 0 : area;
  }

  function instagramActiveMedia(root) {
    if(!root)return null;
    const candidates=[];
    for(const el of root.querySelectorAll('video, img')) {
      if(!el.isConnected)continue;
      if(el.closest('header, footer, [role="navigation"], [aria-hidden="true"]'))continue;
      const area=instagramMediaVisibleArea(el,root);
      if(!area)continue;
      const isVideo=el.localName==='video';
      const sources=isVideo ? [el.currentSrc,el.src,el.querySelector('source[src]')?.src,el.getAttribute('data-src')]
        : [el.currentSrc,el.src];
      if(isVideo && !instagramCarousel(root) && /instagram\.com\/(?:p|tv)\//.test(location.href))
        sources.push(document.querySelector('meta[property="og:video:secure_url"]')?.content,
          document.querySelector('meta[property="og:video"]')?.content);
      const url=sources.map(instagramDirectMediaUrl).find(Boolean)||null;
      const key=sources.find(x=>typeof x==='string'&&x.length>6)||
        (isVideo?'video:'+String(el.poster||el.getAttribute('data-id')||''):'image:unknown');
      const weight=area*(isVideo?1.1:1) + (isVideo&&!el.paused?area*.2:0);
      candidates.push({type:isVideo?'video':'image',url,key,el,weight});
    }
    // A video poster can cover more pixels than its video element while it
    // loads. Prefer an actually visible video instead of saving that JPG.
    const videos=candidates.filter(item=>item.type==='video');
    if(videos.length){videos.sort((a,b)=>b.weight-a.weight);return videos[0];}
    candidates.sort((a,b)=>b.weight-a.weight);
    return candidates[0]||null;
  }

  const instagramSlideDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function instagramSlideKey(root){
    const media=instagramActiveMedia(root);
    return media?.key || media?.url || null;
  }
  async function instagramWaitForSlide(root,beforeKey){
    // Large carousels load their 4th+ slides lazily. The old 2.88s timeout
    // could stop the whole batch despite Instagram still having a Next arrow.
    // Wait for a genuinely different *visible* media key, not a preloaded img.
    for(let i=0;i<64;i++) {
      await instagramSlideDelay(125);
      const current=instagramSlideKey(root);
      if(current && current!==beforeKey){
        // Briefly allow React/media loading to settle before reading src.
        await instagramSlideDelay(90);
        return true;
      }
    }
    return false;
  }

  // Reuse the locally bundled DASH parser. Never collect cookies/tokens.
  async function instagramPrepareMedia(item,changedAt=0){
    if(!item)return null;
    if(item.url)return {type:item.type,url:item.url};
    if(item.type!=='video')return null;
    const duration=Number(item.el?.duration)||0;
    const now=performance.now();
    const records=performance.getEntriesByType('resource').filter(r=>
      now-r.startTime<100000 && /\.mp4(?:\?|$)/i.test(r.name) &&
      /cdninstagram\.com|fbcdn\.net/i.test(r.name)).slice(-800)
      .map(r=>({url:r.name,start:r.startTime}));
    const pair=RyzexDashCore.selectStreams(records,duration,{
      activeSince:changedAt>0?changedAt:Math.max(0,now-6000),now});
    if(!pair.ok)return {type:'video',unavailable:pair.reason};
    return {type:'video',dash:true,video:pair.video,audio:pair.audio};
  }
  // Visit the native carousel buttons to load all slides. A failed slide
  // is not allowed to prevent the photos/videos already resolved from saving.
  async function instagramGatherMedia(root,all,onReady=null){
    const collected=[],missing=[];
    if(!all){
      const current=await instagramPrepareMedia(instagramActiveMedia(root));
      return {items:current&&!current.unavailable?[current]:[],missing:current?.unavailable?[current.unavailable]:[]};
    }
    const limit=20;
    let movedLeft=0,movedRight=0;
    const original=instagramSlideKey(root);
    const seen=new Set();
    const read=async(changedAt)=>{
      const item=instagramActiveMedia(root);
      if(!item){missing.push('visible_media_missing');return;}
      if(seen.has(item.key))return;
      seen.add(item.key);
      const prepared=await instagramPrepareMedia(item,changedAt);
      if(prepared&&!prepared.unavailable){
        collected.push(prepared);
        // Send each file to Edge as soon as its slide is resolved. Never wait
        // for the entire carousel to be navigated before starting downloads.
        if(onReady)await onReady(prepared,collected.length);
      }else missing.push(prepared?.unavailable||'media_url_missing');
    };
    try{
      // Download what is on screen NOW. Even when the user clicked "all" in
      // the middle of a carousel, the first download starts before navigation.
      await read(performance.now()-500);
      while(movedLeft<limit){
        const prev=instagramCarouselNav(root,'previous');if(!prev)break;
        const before=instagramSlideKey(root),changedAt=performance.now();
        prev.click();movedLeft++;
        if(!await instagramWaitForSlide(root,before)){missing.push('previous_slide_timeout');break;}
        await read(changedAt);
      }
      for(let i=0;i<limit;i++){
        await read(performance.now()-500);
        const next=instagramCarouselNav(root,'next');if(!next)break;
        const before=instagramSlideKey(root);
        next.click();movedRight++;
        if(!await instagramWaitForSlide(root,before)){
          missing.push('next_slide_timeout');break;
        }
      }
    }finally{
      // Restore the user's starting position in both directions.
      let delta=movedRight-movedLeft;
      while(delta>0){
        const prev=instagramCarouselNav(root,'previous');if(!prev)break;
        const before=instagramSlideKey(root);prev.click();
        if(!await instagramWaitForSlide(root,before))break;delta--;
      }
      while(delta<0){
        const next=instagramCarouselNav(root,'next');if(!next)break;
        const before=instagramSlideKey(root);next.click();
        if(!await instagramWaitForSlide(root,before))break;delta++;
      }
      // Safe no-op when Instagram unmounted this modal during navigation.
      void original;
    }
    return {items:collected,missing};
  }

  async function instagramDownload(button,event,all=false) {
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    if(button.dataset.ryzexBusy==='1')return;
    const postUrl=instagramPostNear(button);
    if(!postUrl){showToast('Instagram post not found. Open the post and try again.','error');return;}
    if(!/instagram\.com\/(?:p|tv)\//.test(postUrl)) {
      // The existing Reels / Cobalt flow is unchanged.
      chrome.runtime.sendMessage({type:'QUEUE_ADD',urls:[postUrl]},reply=>{
        const error=chrome.runtime.lastError?.message||reply?.error;
        showToast(error?'Could not start the download: '+error:'Reel added to the queue.',error?'error':'info');
      });return;
    }
    const root=instagramPostRoot(button);
    if(!root){showToast('Post content not found. Open the post and try again.','error');return;}
    if(instagramBusyPosts.has(root))return;
    instagramBusyPosts.add(root);
    button.dataset.ryzexBusy='1';
    try {
      if(all){
        let started=0,failed=0;
        const errors=[];
        showToast('Starting batch download… Preparing the first item.','progress');
        // Deliberately send ONE file per message. The service worker awaits
        // chrome.downloads.download before this callback proceeds to the next
        // slide; mixed photo + DASH video carousels preserve download order.
        const {items,missing}=await instagramGatherMedia(root,true,async(file,index)=>{
          showToast(`Preparing file ${index}…`,'progress');
          try{
            const reply=await chrome.runtime.sendMessage({
              type:'RYZEX_INSTAGRAM_MEDIA',postUrl,files:[file]});
            started+=Number(reply?.started)||0;
            failed+=Number(reply?.failed)||0;
            if(reply?.error){errors.push(String(reply.error));if(!reply?.failed)failed++;}
            showToast(`${started} files sent to downloads${failed?' · '+failed+' failed':''}.`,'progress');
          }catch(error){
            failed++;
            errors.push(error?.message||'Could not start the download.');
          }
        });
        if(!items.length){
          showToast('No downloadable media found in this carousel.','error');return;
        }
        const skipped=missing.length;
        if(!started)showToast(`Could not start the download. ${errors[0]||'Media link not found.'}`,'error');
        else if(failed||skipped)showToast(`${started} files started. ${failed+skipped} items skipped. ${errors[0]||''}`,'info');
        else showToast(`All ${started} files sent to downloads in order.`,'success');
      }else{
        const {items,missing}=await instagramGatherMedia(root,false);
        if(!items.length){
          showToast('Post media not found. DASH streams may not have loaded yet.','error');return;
        }
        const reply=await chrome.runtime.sendMessage({type:'RYZEX_INSTAGRAM_MEDIA',postUrl,files:items});
        const started=Number(reply?.started)||0;
        const failed=Number(reply?.failed)||0;
        if(reply?.error && !started)showToast('Download error: '+reply.error,'error');
        else if(missing.length||failed||reply?.error)
          showToast(`${started} files started. ${missing.length+failed} items skipped. ${reply?.error||''}`,'info');
        else showToast(`${started} Instagram files sent to downloads.`,'success');
      }
    } catch(error) {showToast('Download error: '+(error?.message||'Unknown error'),'error');}
    finally {button.dataset.ryzexBusy='0';instagramBusyPosts.delete(root);}
  }

  function directSlot(node,toolbar) {
    let el=node;
    while(el && el.parentElement!==toolbar)el=el.parentElement;
    return el?.parentElement===toolbar?el:null;
  }

  // Instagram may group actions in slightly different wrappers in feeds,
  // reels and modals. Locate the closest small action row instead of requiring
  // Repost and Share to be immediately adjacent siblings (the old cause of
  // buttons appearing only on some posts).
  function instagramInlineLocation(shareIcon) {
    for(let bar=shareIcon.parentElement,depth=0;bar && depth<10;bar=bar.parentElement,depth++) {
      if(bar.matches('button,[role="button"],a') || bar.children.length<2 || bar.children.length>16)continue;
      const shareSlot=directSlot(shareIcon,bar);
      if(!shareSlot)continue;
      const siblingAction=[...bar.querySelectorAll('svg[aria-label]')].find(icon=>
        !icon.closest('[data-ryzex-instagram-inline]') && directSlot(icon,bar)!==shareSlot &&
        /^(like|unlike|comment|repost|save|beğen|beğenmekten vazgeç|yorum yap|yeniden paylaş|kaydet|me gusta|comentar|j’aime|commenter|нравится|комментировать|bəyən)$/i.test(icon.getAttribute('aria-label')||''));
      if(siblingAction)return {bar,shareSlot};
    }
    return null;
  }

  function instagramMakeSlot(shareSlot,mode) {
    // Never clone React-owned Share wrappers: hover classes/positioning and
    // click targets from those wrappers can hide or move cloned controls.
    const slot=document.createElement('span');
    const clickable=document.createElement('button');
    clickable.type='button';clickable.className='ryzex-instagram-action';
    const icon=downloadIcon();
    if(mode==='all') {
      // Native-size double arrow distinguishes all-items download.
      icon.querySelector('path')?.setAttribute('d','M7 3a1 1 0 0 1 1 1v10.59l2.3-2.3a1 1 0 0 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.42L6 14.59V4a1 1 0 0 1 1-1Zm10 0a1 1 0 0 1 1 1v10.59l2.3-2.3a1 1 0 0 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1ZM3 20h18v2H3z');
    }
    icon.setAttribute('width','24');icon.setAttribute('height','24');
    clickable.append(icon);slot.append(clickable);
    slot.dataset.ryzexInstagramInline='1';
    slot.dataset.ryzexInstagramMode=mode;
    I18N.bind(clickable,mode==='all'?'Download all Instagram post media':'Download current Instagram post media','aria-label');
    I18N.bind(clickable,mode==='all'?'Download all photos and videos':'Download the visible photo or video','title');
    clickable.tabIndex=0;
    clickable.setAttribute(marker,'1');
    const activate=e=>instagramDownload(clickable,e,mode==='all');
    clickable.addEventListener('click',activate,true);
    // Native buttons produce one click for Enter/Space; no duplicate handler.
    return slot;
  }

  function addInstagramInlineButtons() {
    const shareIcons=Array.from(document.querySelectorAll('svg[aria-label]')).filter(svg=>
      /^(share|share post|send|paylaş|gönder|gönderiyi paylaş)$/i.test(svg.getAttribute('aria-label')||''));
    for(const shareIcon of shareIcons) {
      if(shareIcon.closest('[data-ryzex-instagram-inline="1"]'))continue;
      const locationInfo=instagramInlineLocation(shareIcon);
      if(!locationInfo)continue;
      const {bar,shareSlot}=locationInfo;
      const existing=Array.from(bar.children).filter(el=>el.matches('[data-ryzex-instagram-inline="1"]'));
      if(!existing.some(el=>el.dataset.ryzexInstagramMode==='current')) {
        const slot=instagramMakeSlot(shareSlot,'current');
        if(slot)bar.insertBefore(slot,shareSlot);
      }
      const reference=bar.querySelector('[data-ryzex-instagram-mode="current"]')||shareSlot;
      const root=instagramPostRoot(reference);
      // Multi-item actions are only for /p/ posts and visible native carousels.
      const post=instagramPostNear(reference);
      if(post && /instagram\.com\/(?:p|tv)\//.test(post) && instagramCarousel(root) &&
        !existing.some(el=>el.dataset.ryzexInstagramMode==='all') &&
        !bar.querySelector('[data-ryzex-instagram-mode="all"]')) {
        const slot=instagramMakeSlot(shareSlot,'all');
        if(slot)bar.insertBefore(slot,shareSlot);
      }
    }
  }

  function removeLegacyInstagramMenuActions() {
    // In-place upgrades can retain the old extension-generated menu row until
    // Instagram unmounts its dialog. Never alter Instagram's own menu items.
    for(const dialog of document.querySelectorAll('[role="dialog"], [role="menu"]')) {
      for(const item of dialog.querySelectorAll('['+marker+']')) {
        if(!item.closest('[data-ryzex-instagram-inline="1"]'))item.remove();
      }
    }
  }

  // On X, share controls are rendered for each post separately. Cloning the
  // direct group child (instead of making a floating button) keeps X spacing,
  // icon sizing, layout and RTL/wrapping behavior identical to the Share icon.
  // Resolve URL strictly from the clicked post; never pick the page's first link.
  function canonicalXPostLink(href) {
    if (!href) return null;
    let target;
    try { target = new URL(href, location.href); } catch { return null; }
    if (!['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(target.hostname.toLowerCase())) return null;
    // Links such as /user/status/123/analytics must also resolve to the post.
    const match = target.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
    if (!match) return null;
    return normalize(`https://x.com/${match[1]}/status/${match[2]}`)?.url || null;
  }

  function resolveXInlinePost(button) {
    const article = button.closest('article[data-testid="tweet"], [data-testid="tweet"], article');
    if (!article) return null;
    // Quoted tweets often contain their own status links. Keep the outer tweet.
    const isQuoted = element => Boolean(element.closest('[data-testid="quoteTweet"], [data-testid="card.wrapper"]'));
    for (const time of article.querySelectorAll('time')) {
      if (isQuoted(time)) continue;
      const link = time.closest('a[href]');
      const result = canonicalXPostLink(link?.href);
      if (result) return result;
    }
    // User-provided X markup has only an analytics link in the action bar.
    const group = button.closest('[role="group"]');
    for (const link of (group || article).querySelectorAll('a[href*="/status/"]')) {
      if (isQuoted(link)) continue;
      const result = canonicalXPostLink(link.href);
      if (result) return result;
    }
    // Feed posts sometimes omit timestamps in partially rendered cards.
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      if (isQuoted(link)) continue;
      const result = canonicalXPostLink(link.href);
      if (result) return result;
    }
    // Ambiguous context: do not accidentally download a different post.
    return null;
  }

  // X tooltips are page-rendered, unlike the browser-default `title` tooltip.
  // The cloned React button cannot inherit X's event handlers, so reproduce
  // the same compact dark tooltip without browser tooltip chrome.
  let xTipHost = null;
  let xTipShowTimer = null;
  let xTipOwner = null;

  function hideXDownloadTooltip() {
    clearTimeout(xTipShowTimer);
    xTipShowTimer = null;
    xTipOwner = null;
    if (xTipHost) {
      xTipHost.remove();
      xTipHost = null;
    }
  }

  function showXDownloadTooltip(button) {
    hideXDownloadTooltip();
    xTipOwner = button;
    xTipShowTimer = setTimeout(() => {
      xTipShowTimer = null;
      if (!button.isConnected || xTipOwner !== button) return;
      const tooltip = document.createElement('div');
      tooltip.className = 'ryzex-x-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      I18N.bind(tooltip,'Download');
      document.documentElement.append(tooltip);
      xTipHost = tooltip;
      const rect = button.getBoundingClientRect();
      // Match X's compact tooltip under the Share button, without clipping
      // it inside the post's action bar.
      const tipRect = tooltip.getBoundingClientRect();
      const center = Math.max(tipRect.width / 2 + 5,
        Math.min(window.innerWidth - tipRect.width / 2 - 5, rect.left + rect.width / 2));
      tooltip.style.left = `${center}px`;
      const below = rect.bottom + 8;
      tooltip.style.top = `${below + tipRect.height > window.innerHeight - 5 ? Math.max(5, rect.top - tipRect.height - 8) : below}px`;
      // Double requestAnimationFrame ensures the opacity transition paints.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (xTipHost === tooltip) tooltip.classList.add('shown');
      }));
    }, 450);
  }

  function wireXDownloadTooltip(button) {
    button.addEventListener('mouseenter', () => showXDownloadTooltip(button));
    button.addEventListener('mouseleave', hideXDownloadTooltip);
    button.addEventListener('focus', () => showXDownloadTooltip(button));
    button.addEventListener('blur', hideXDownloadTooltip);
    button.addEventListener('pointerdown', hideXDownloadTooltip);
  }

  function xInlineDownload(button, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (button.dataset.ryzexBusy === '1') return;
    const url = resolveXInlinePost(button);
    if (!url) {
      showToast('Post link not found. Open the post and try again.', 'error');
      return;
    }
    button.dataset.ryzexBusy = '1';
    chrome.runtime.sendMessage({type:'QUEUE_ADD',urls:[url]}, result => {
      button.dataset.ryzexBusy = '0';
      const error = chrome.runtime.lastError?.message || result?.error;
      if (error) showToast('Could not start the download: ' + error, 'error');
      else if (result?.added) showToast('X post added to the download queue.', 'info');
      else showToast('This post is already in the queue.', 'info');
    });
  }

  function addXInlineButtons() {
    // `button[aria-label="Share post"]` comes from the X action bar markup.
    for (const shareButton of document.querySelectorAll('button[aria-label="Share post"]')) {
      const group = shareButton.closest('[role="group"]');
      const article = shareButton.closest('article[data-testid="tweet"], [data-testid="tweet"], article');
      // Avoid global Share buttons or sharing in the message composer.
      if (!group || !article || !article.contains(group)) continue;
      if (group.querySelector('[data-ryzex-x-inline="1"]')) continue;
      if (!group.querySelector('button[data-testid="reply"], button[data-testid="like"]')) continue;
      let slot=shareButton;
      while (slot.parentElement && slot.parentElement!==group) slot=slot.parentElement;
      if (slot.parentElement!==group) continue;
      const cloneSlot=slot.cloneNode(true);
      const cloneButton=cloneSlot.querySelector('button');
      if (!cloneButton) continue;
      // Do not duplicate X's DOM IDs, selectors, analytics attributes or menu behavior.
      for (const el of [cloneSlot,...cloneSlot.querySelectorAll('*')]) {
        for (const attr of ['id','data-testid','aria-expanded','aria-haspopup','aria-controls','aria-describedby','data-focusable']) el.removeAttribute(attr);
      }
      // Preserve the *original* X Share button SVG (classes, viewBox,
      // native dimensions, inherited fill and hover circle). Only change
      // the arrow glyph's path. Replacing the SVG itself changes its size
      // because X styles SVGs via internal utility classes.
      const originalIcon=cloneButton.querySelector('svg');
      const glyph=originalIcon?.querySelector('path');
      if (!glyph) continue;
      glyph.setAttribute('d',
        'M11 3h2v10.59l3.3-3.3 1.41 1.42-5.7 5.7-5.7-5.7 1.41-1.42L11 13.59V3z' +
        'M21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z');
      cloneButton.type='button';
      I18N.bind(cloneButton,'Download post','aria-label');
      // No native browser tooltip; use X-style dark hover label below.
      cloneButton.removeAttribute('title');
      cloneButton.dataset.ryzexXInline='1';
      cloneButton.setAttribute(marker,'1');
      cloneSlot.dataset.ryzexXSlot='1';
      cloneButton.addEventListener('click', e => xInlineDownload(cloneButton,e), true);
      wireXDownloadTooltip(cloneButton);
      // Space/Enter naturally cause a click for native buttons. No extra
      // keydown listener, preventing double download requests.
      slot.after(cloneSlot);
    }
  }

  function removeXMenuDownloads() {
    // Retire only extension-marked actions from portals; retain X's own items
    // and the single download action alongside the post's Share button.
    for (const menu of document.querySelectorAll('[data-testid="Dropdown"], [role="menu"]')) {
      for (const item of menu.querySelectorAll(`[${marker}]`)) {
        if (!item.closest('[data-ryzex-x-slot="1"]')) item.remove();
      }
    }
  }

  function scan() {
    if (platform === 'tiktok') {
      addTikTokQuickButtons();
      addTikTokBrowseButtons();
    } else if (platform === 'instagram') {
      addInstagramInlineButtons();
      removeLegacyInstagramMenuActions();
    } else {
      addXInlineButtons();
      removeXMenuDownloads();
    }
  }

  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    // Request animation frame batches rapid React DOM updates without polling.
    requestAnimationFrame(() => {
      scanPending = false;
      scan();
    });
  }

  function visiblePosts() {
    const found = new Map();
    const current = resolveCurrentUrl();
    if (current) found.set(current, normalize(current));
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (found.size >= 50) break;
      if (!visible(anchor)) continue;
      const parsed = normalize(anchor.href);
      if (parsed) found.set(parsed.url, parsed);
    }
    return [...found.values()].filter(Boolean);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'RYZEX_QUEUE_STATUS') {
      if (msg.state === 'processing' || msg.state === 'downloading')
        showProgressToast(msg.jobId, msg.note || 'Preparing download…', msg.percent);
      else if (msg.state === 'started') finishProgressToast(msg.jobId, msg.note || 'Download completed.', 'success');
      else if (msg.state === 'error') finishProgressToast(msg.jobId, 'Download error: ' + (msg.note || 'Unknown error'), 'error');
      return;
    }
    if (msg?.type === 'COLLECT_PAGE') respond({items:visiblePosts()});
    else if (msg?.type === 'GET_CURRENT') respond({url:resolveCurrentUrl(),items:visiblePosts()});
    else if (msg?.type === 'RYZEX_DIAG') respond({
      version:activeVersion, platform, ready:window.__ryzexSaverReady===true,
      listener:document.documentElement?.getAttribute('data-ryzex-tiktok-listener')||null,
      copyControls:document.querySelectorAll('[data-e2e="share-copy"]').length,
      lastCopy:document.documentElement?.dataset.ryzexLastCopy||null,
      lastLink:document.documentElement?.dataset.ryzexLastLink||null,
      prompt:!!document.querySelector('[data-ryzex-copy-prompt]')
    });
  });

  function start() {
    if (observed || !document.documentElement) return;
    observed = true;
    new MutationObserver(scheduleScan).observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['class','style','aria-hidden','data-state','data-more-menu-item-id','href']});
    window.addEventListener('popstate', () => {lastMenuUrl = null; scheduleScan();});
    window.addEventListener('hashchange', scheduleScan);
    if (platform === 'tiktok') {
      window.addEventListener('scroll', scheduleTikTokBrowsePositions, true);
      window.addEventListener('resize', scheduleTikTokBrowsePositions);
    }
    if (platform === 'x') {
      window.addEventListener('scroll', hideXDownloadTooltip, true);
      window.addEventListener('resize', hideXDownloadTooltip);
    }
    scheduleScan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
  window.__ryzexSaverReady = true;
})();
