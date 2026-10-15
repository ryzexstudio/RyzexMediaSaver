/* Explicit user preference. English is the initial language on every browser. */
(() => {
 'use strict';
 const locales=globalThis.RyzexLocales||{},supported=Object.freeze(['en','tr','es','az','fr','ru']);
 const base=locales.en||{};let language='en',bindCount=0;const listeners=new Set(),bindings=new Map();
 const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 function pattern(template){
  const names=[];let expression='^',offset=0;
  for(const match of template.matchAll(/\{(\w+)\}/g)){expression+=escape(template.slice(offset,match.index))+'([\\s\\S]*?)';names.push(match[1]);offset=match.index+match[0].length;}
  expression+=escape(template.slice(offset))+'$';return names.length?{regex:new RegExp(expression),names}:null;
 }
 const sources=[];
 for(const [locale,messages] of Object.entries(locales))for(const [key,value] of Object.entries(messages)){
  if(typeof value==='string')sources.push({key,value,pattern:pattern(value)});
 }
 const legacy=globalThis.RyzexLegacyMessages||{};
 for(const [value,key] of Object.entries(legacy))sources.push({key,value,pattern:pattern(value)});
 sources.sort((a,b)=>b.value.length-a.value.length);
 function t(key,args={}){
  const template=locales[language]?.[key]??base[key]??key;
  return template.replace(/\{(\w+)\}/g,(match,name)=>Object.hasOwn(args,name)?String(args[name]):match);
 }
 function text(raw,depth=0){
  const input=String(raw??'');if(!input||depth>3)return input;
  const exact=sources.find(source=>source.value===input);if(exact)return t(exact.key);
  for(const source of sources){if(!source.pattern)continue;const match=input.match(source.pattern.regex);if(!match)continue;
   const args={};source.pattern.names.forEach((name,index)=>{args[name]=text(match[index+1],depth+1);});return t(source.key,args);
  }return input;
 }
 function bind(node,value,attribute=null){
  // Long social feeds replace many controls; release detached DOM references.
  if(++bindCount%100===0)for(const target of bindings.keys())if(!target.isConnected)bindings.delete(target);
  if(!node)return;let fields=bindings.get(node);if(!fields){fields=new Map();bindings.set(node,fields);}fields.set(attribute,String(value??''));
  if(attribute)node.setAttribute(attribute,text(value));else node.textContent=text(value);
 }
 function apply(root=document){
  for(const node of root.querySelectorAll('[data-i18n]'))node.textContent=t(node.dataset.i18n);
  for(const node of root.querySelectorAll('[data-i18n-placeholder]'))node.setAttribute('placeholder',t(node.dataset.i18nPlaceholder));
  for(const node of root.querySelectorAll('[data-i18n-label]'))node.setAttribute('aria-label',t(node.dataset.i18nLabel));
 }
 function set(next){
  language=supported.includes(next)&&locales[next]?next:'en';
  for(const [node,fields] of bindings){if(!node.isConnected){bindings.delete(node);continue;}for(const [attribute,value] of fields){if(attribute)node.setAttribute(attribute,text(value));else node.textContent=text(value);}}
  for(const listener of listeners)listener(language);
 }
 async function init(mode='popup'){
  if(mode==='content'){
   try{const result=await chrome.runtime.sendMessage({type:'I18N_GET'});if(result?.language)set(result.language);}catch{}
   chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='RYZEX_LANGUAGE_CHANGED'&&sender.id===chrome.runtime.id&&!sender.tab)set(message.language);});
  }else{try{const stored=await chrome.storage.local.get('uiLanguage');set(stored.uiLanguage);}catch{set('en');}}
  return language;
 }
 async function choose(next){if(!supported.includes(next))return;await chrome.storage.local.set({uiLanguage:next});set(next);}
 globalThis.RyzexI18n=Object.freeze({t,text,bind,apply,set,init,choose,supported,get language(){return language;},onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}});
})();
