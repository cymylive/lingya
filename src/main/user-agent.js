/**
 * 动态生成「普通 Chrome」User-Agent + Client Hints 修正。
 *
 * 背景（来自 Cuckoo-Code 0.8.19 的成熟方案）：
 *  1. Electron 默认 UA 带 "Electron/x.y.z" 标识，任何平台都能一眼识别为第三方客户端
 *  2. Electron 默认 sec-ch-ua 缺少 "Google Chrome" 品牌，Google/DeepSeek 等
 *     反爬系统据此判定「浏览器不安全」或「第三方客户端」
 *  3. navigator.userAgentData 也缺 Google Chrome 品牌
 *
 * 本模块做三件事：
 *  - buildChromeUserAgent(): 按真实内核版本生成普通 Chrome UA（去掉 Electron 标识）
 *  - buildClientHintsHeaders(): 补齐 sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform
 *  - buildUserAgentDataFix(): 主世界脚本，补 navigator.userAgentData + webdriver=false
 *
 * 2026-11-01 改造：LingYa 原为硬编码 Chrome/130，与本机 Electron 33（内核 Chrome 130）
 * 一致但无法自动升级。改为从 process.versions.chrome 动态读。
 */
'use strict';

/** 取主版本号（"130.0.6723.58" → "130"） */
function chromeMajor() {
  const v = (process.versions && process.versions.chrome) || '';
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '130';
}

/** 取完整内核版本 */
function chromeFullVersion() {
  const v = (process.versions && process.versions.chrome) || '';
  return v || (chromeMajor() + '.0.0.0');
}

/** 普通 Chrome UA（去掉 Electron 标识） */
function buildChromeUserAgent() {
  const major = chromeMajor();
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
}

/** 补齐 sec-ch-ua* 请求头（与 UA 一致） */
function buildClientHintsHeaders() {
  const m = chromeMajor();
  return {
    'sec-ch-ua': '"Google Chrome";v="' + m + '", "Chromium";v="' + m + '", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

/** 主世界脚本：修正 navigator.userAgentData + webdriver（preload 注入） */
function buildUserAgentDataFix() {
  const m = chromeMajor();
  const full = chromeFullVersion();
  return '(function(){try{' +
    'var brands=[{brand:"Google Chrome",version:"' + m + '"},{brand:"Chromium",version:"' + m + '"},{brand:"Not_A Brand",version:"24"}];' +
    'var fullList=[{brand:"Google Chrome",version:"' + full + '"},{brand:"Chromium",version:"' + full + '"},{brand:"Not_A Brand",version:"24.0.0.0"}];' +
    'var uad={brands:brands,mobile:false,platform:"Windows",' +
    'getHighEntropyValues:function(){return Promise.resolve({architecture:"x86",bitness:"64",brands:brands,fullVersionList:fullList,mobile:false,model:"",platform:"Windows",platformVersion:"10.0.0",uaFullVersion:"' + full + '",wow64:false});},' +
    'toJSON:function(){return{brands:brands,mobile:false,platform:"Windows"};}};' +
    'try{Object.defineProperty(navigator,"userAgentData",{get:function(){return uad;},configurable:true});}catch(e){}' +
    'try{Object.defineProperty(navigator,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}' +
    '}catch(e){}})();';
}

module.exports = {
  buildChromeUserAgent,
  buildClientHintsHeaders,
  buildUserAgentDataFix,
  chromeMajor,
  chromeFullVersion,
};
