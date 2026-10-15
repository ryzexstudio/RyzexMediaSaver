'use strict';
const $ = (id) => document.getElementById(id);
const I18N = RyzexI18n;
let lastStatus = '';
const DRAFT_KEY = 'popupUrlDraft';
let draftEdited = false;

function saveDraft(value) {
  // Send each input write immediately; no debounce that can be lost on close.
  return chrome.storage.local.set({[DRAFT_KEY]:value}).catch(()=>{});
}

async function restoreDraft() {
  const stored = await chrome.storage.local.get(DRAFT_KEY);
  if (!draftEdited && typeof stored[DRAFT_KEY] === 'string') $('urlList').value = stored[DRAFT_KEY];
}
$('urlList').addEventListener('input', () => {
  draftEdited = true;
  void saveDraft($('urlList').value);
});

function status(text, error = false) {
  lastStatus = text || '';
  const node = $('status');
  if (!node) return;
  node.textContent = I18N.text(lastStatus);
  node.classList.toggle('error', !!error);
}

async function send(type, args = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...args });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function loadSettings() {
  try {
    const { quotas } = await send('GATEWAY_STATUS');
    $('quotaTikTok').textContent = quotas?.tiktok?.remaining ?? '?';
    $('quotaInstagram').textContent = quotas?.instagram?.remaining ?? '?';
    $('quotaX').textContent = quotas?.x?.remaining ?? '?';
  } catch (e) {
    if ($('settingsSection')) $('settingsSection').hidden = false;
    $('settingsToggle')?.setAttribute('aria-expanded', 'true');
    status(e.message || String(e), true);
  }
}

async function enqueue(urls) {
  const data = await send('QUEUE_ADD', { urls });
  await updateQueue();
  if (data.added) status(I18N.t('queuedNotice',{count:data.added}));
  else status(I18N.t('noNew'), true);
}

async function addLinks() {
  const box = $('urlList');
  const submitted = box.value;
  void saveDraft(submitted);
  const items = RyzexLinks.parseMany(submitted, 50);
  if (!items.length) throw new Error(I18N.t('noLinks'));
  await enqueue(items.map((x) => x.url));
  // Preserve newly typed links if they changed while the request was pending.
  if (box.value === submitted) {
    box.value = '';
    void saveDraft('');
  }
}

let selectedQueueTab = 'queued';
let queueSnapshot = [];
const queueStates = {queued:['queued','processing','downloading'], started:['started'], error:['error']};

async function updateQueue() {
  const { queue } = await send('QUEUE_GET');
  queueSnapshot = Array.isArray(queue) ? queue : [];
  renderQueue();
}

function renderQueue() {
  const queue = queueSnapshot;
  $('queuedCount').textContent = queue.filter((x) => ['queued', 'processing', 'downloading'].includes(x.state)).length;
  $('startedCount').textContent = queue.filter((x) => x.state === 'started').length;
  $('failedCount').textContent = queue.filter((x) => x.state === 'error').length;

  const container = $('queueList');
  container.replaceChildren();
  const tabs = document.querySelectorAll('.queue-tab');
  for (const tab of tabs) {
    const active = tab.dataset.state === selectedQueueTab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) container.setAttribute('aria-labelledby', tab.id);
  }
  const visible = queue.filter(item => queueStates[selectedQueueTab].includes(item.state));

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = I18N.t({queued:'emptyQueued',started:'emptyCompleted',error:'emptyFailed'}[selectedQueueTab]);
    container.append(empty);
    return;
  }

  for (const item of visible.slice(-20).reverse()) {
    const row = document.createElement('div');
    row.className = 'queue-item';

    const dot = document.createElement('div');
    dot.className = 'queue-mark ' + item.state;

    const main = document.createElement('div');
    main.className = 'queue-main';

    const title = document.createElement('div');
    title.className = 'queue-name';
    title.textContent = `${item.platform} · ${item.url.split('/').pop()}`;

    const note = document.createElement('div');
    note.className = 'queue-note';
    note.title = I18N.text(item.note);
    note.textContent = I18N.text(item.note);

    main.append(title, note);

    if (['processing', 'downloading'].includes(item.state)) {
      const track = document.createElement('div');
      track.className = 'ryzex-queue-progress';
      const bar = document.createElement('div');
      bar.className = 'ryzex-queue-progress-fill';
      const percent = typeof item.percent === 'number' && Number.isFinite(item.percent)
        ? Math.max(0, Math.min(99, item.percent))
        : null;
      if (percent === null) track.classList.add('indeterminate');
      bar.style.width = percent === null ? '35%' : `${percent}%`;
      track.append(bar);
      main.append(track);
    }

    row.append(dot, main);
    container.append(row);
  }
}

function attach(id, action) {
  const node = $(id);
  if (!node) return;
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action();
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      node.disabled = false;
    }
  });
}

function toggleSection(buttonId, sectionId) {
  const section = $(sectionId);
  if (!section) return;
  section.hidden = !section.hidden;
  $(buttonId)?.setAttribute('aria-expanded', String(!section.hidden));
}
attach('settingsToggle', () => toggleSection('settingsToggle', 'settingsSection'));
const queueTabs = [...document.querySelectorAll('.queue-tab')];
function selectQueueTab(tab) {
  selectedQueueTab = tab.dataset.state;
  renderQueue();
}
for (const tab of queueTabs) {
  tab.addEventListener('click', () => selectQueueTab(tab));
  tab.addEventListener('keydown', event => {
    const index = queueTabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % queueTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + queueTabs.length - 1) % queueTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = queueTabs.length - 1;
    else return;
    event.preventDefault();
    selectQueueTab(queueTabs[next]);
    queueTabs[next].focus();
  });
}
attach('refreshQuota', loadSettings);
attach('addLinks', addLinks);
attach('clearDone', async () => {
  await send('QUEUE_CLEAR_DONE');
  await updateQueue();
  status(I18N.t('cleared'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.queue) void updateQueue();
});

void loadSettings().catch((e) => status(String(e), true));
void updateQueue().catch((e) => status(String(e), true));
void restoreDraft().catch(()=>{});
const languageOptions=[...$('languageMenu').querySelectorAll('[data-language]')];
let languageSaving=false;
function renderLanguage(language){
  const selected=languageOptions.find(option=>option.dataset.language===language)||languageOptions[0];
  $('languageName').textContent=selected.querySelector('span').textContent;
  $('languageName').lang=selected.lang;
  $('languageFlag').src=selected.querySelector('img').getAttribute('src');
  $('uiLanguage').dataset.language=selected.dataset.language;
  $('uiLanguage').setAttribute('aria-label',`${I18N.t('language')}: ${$('languageName').textContent}`);
  for(const option of languageOptions)option.setAttribute('aria-selected',String(option===selected));
}
function closeLanguages(restoreFocus=false){
  $('languageMenu').hidden=true;
  $('uiLanguage').setAttribute('aria-expanded','false');
  if(restoreFocus)$('uiLanguage').focus();
}
function openLanguages(index=languageOptions.findIndex(option=>option.dataset.language===I18N.language)){
  $('languageMenu').hidden=false;
  $('uiLanguage').setAttribute('aria-expanded','true');
  languageOptions[Math.max(0,index)].focus();
}
$('uiLanguage').addEventListener('click',()=>{
  if($('languageMenu').hidden)openLanguages();else closeLanguages();
});
$('uiLanguage').addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();
  openLanguages(event.key==='Home'?0:event.key==='End'?languageOptions.length-1:undefined);
});
$('languageMenu').addEventListener('keydown',event=>{
  const index=languageOptions.indexOf(document.activeElement);
  let next;
  if(event.key==='ArrowDown')next=(index+1)%languageOptions.length;
  else if(event.key==='ArrowUp')next=(index-1+languageOptions.length)%languageOptions.length;
  else if(event.key==='Home')next=0;
  else if(event.key==='End')next=languageOptions.length-1;
  else return;
  event.preventDefault();languageOptions[next].focus();
});
for(const option of languageOptions)option.addEventListener('click',async()=>{
  if(languageSaving)return;
  languageSaving=true;
  try{await I18N.choose(option.dataset.language);closeLanguages(true);}
  catch(error){status(error.message||String(error),true);}
  finally{languageSaving=false;}
});
document.addEventListener('pointerdown',event=>{if(!$('languageControl').contains(event.target))closeLanguages();});
$('languageControl').addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!$('languageMenu').hidden){event.preventDefault();event.stopPropagation();closeLanguages(true);}
});
$('languageControl').addEventListener('focusout',event=>{
  if(!$('languageControl').contains(event.relatedTarget))closeLanguages();
});
I18N.onChange(language=>{
  document.documentElement.lang=language;
  I18N.apply();
  renderLanguage(language);
  renderQueue();
  $('status').textContent=I18N.text(lastStatus);
});
I18N.apply();
renderLanguage(I18N.language);
void I18N.init();

// Feedback goes through the trusted background; no recipient or email secret here.
const feedbackFields=['feedbackSubject','feedbackDescription'];
const feedbackEdited=new Set();
let feedbackBusy=false,feedbackRequest=null,feedbackError='';
function saveFeedbackDraft(){
  return chrome.storage.local.set(Object.fromEntries(feedbackFields.map(id=>[id+'Draft',$(id).value]))).catch(()=>{});
}
for(const id of feedbackFields)$(id).addEventListener('input',()=>{feedbackEdited.add(id);$(id).setCustomValidity('');void saveFeedbackDraft();});
void (async()=>{
  for(const id of feedbackFields){
    const key=id+'Draft',stored=await chrome.storage.local.get(key);
    if(!feedbackEdited.has(id)&&typeof stored[key]==='string')$(id).value=stored[key].slice(0,$(id).maxLength);
  }
})().catch(()=>{});
function closeFeedback(){ $('feedbackDialog').close();$('feedbackOpen').focus(); }
$('feedbackOpen').addEventListener('click',()=>{closeLanguages();$('feedbackDialog').showModal();$('feedbackSubject').focus();});
$('feedbackClose').addEventListener('click',closeFeedback);
$('feedbackCancel').addEventListener('click',closeFeedback);
$('feedbackDialog').addEventListener('cancel',()=>{$('feedbackOpen').focus();});
$('feedbackDialog').addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const controls=[...$('feedbackDialog').querySelectorAll('button,input,textarea')].filter(node=>!node.disabled&&node.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
$('feedbackDialog').addEventListener('click',event=>{
  if(event.target!==$('feedbackDialog'))return;
  const bounds=$('feedbackDialog').getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)closeFeedback();
});
$('feedbackForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(feedbackBusy)return;
  const subject=$('feedbackSubject').value.replace(/[\x00-\x1f\x7f]+/g,' ').trim().slice(0,120);
  const description=$('feedbackDescription').value.trim().slice(0,1500);
  for(const [id,value] of [['feedbackSubject',subject],['feedbackDescription',description]]){
    $(id).setCustomValidity(value?'':I18N.t('feedbackRequired'));
    if(!$(id).reportValidity())return;
  }
  const fingerprint=JSON.stringify([subject,description]);
  feedbackBusy=true;feedbackError='';$('feedbackStatus').textContent='';
  $('feedbackSubmit').disabled=true;
  for(const id of feedbackFields)$(id).readOnly=true;
  $('feedbackSubmitLabel').textContent=I18N.t('feedbackSending');
  try{
    await saveFeedbackDraft();
    // Keep one identity across popup close/reopen and uncertain network retries.
    if(!feedbackRequest){const stored=await chrome.storage.local.get('feedbackRequestDraft');try{feedbackRequest=JSON.parse(stored.feedbackRequestDraft);}catch{}}
    if(!feedbackRequest||feedbackRequest.fingerprint!==fingerprint||Date.now()-feedbackRequest.createdAt>23*3600000)
      feedbackRequest={fingerprint,requestId:'feedback_'+crypto.randomUUID(),createdAt:Date.now()};
    await chrome.storage.local.set({feedbackRequestDraft:JSON.stringify(feedbackRequest)});
    const result=await send('FEEDBACK_SEND',{subject,description,requestId:feedbackRequest.requestId});
    if(result?.ok!==true)throw new Error('Feedback could not be sent. Your draft has been kept.');
    await chrome.storage.local.set({feedbackSubjectDraft:'',feedbackDescriptionDraft:'',feedbackRequestDraft:''}).catch(()=>{});
    for(const id of feedbackFields)$(id).value='';
    feedbackRequest=null;
    closeFeedback();status(I18N.t('feedbackContinue'));
  }catch(error){
    feedbackError=error?.message||'Feedback could not be sent. Your draft has been kept.';
    $('feedbackStatus').textContent=I18N.text(feedbackError);
  }finally{
    feedbackBusy=false;$('feedbackSubmit').disabled=false;
    for(const id of feedbackFields)$(id).readOnly=false;
    $('feedbackSubmitLabel').textContent=I18N.t('feedbackOpenEmail');
  }
});
I18N.onChange(()=>{$('feedbackStatus').textContent=I18N.text(feedbackError);$('feedbackSubmitLabel').textContent=I18N.t(feedbackBusy?'feedbackSending':'feedbackOpenEmail');});
