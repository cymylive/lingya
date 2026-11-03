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

/**
 * 主世界脚本：补齐 window.chrome 对象（runtime / loadTimes / csi / app）。
 *
 * 背景：Electron 的 window.chrome 是空壳（Object.keys 返回 []），
 * 真实 Chrome 至少有 loadTimes / csi / app / runtime 四个成员。
 * FingerprintJS 一行代码就能判红。此处补结构，不实现功能。
 *
 * 注意：普通网页（非扩展上下文）里 chrome.runtime 本身也是"存在但不可用"，
 * connect/sendMessage 会抛「Receiving end does not exist」——此处保持同样的行为。
 */
function buildChromeObjectFix() {
  return '(function(){try{' +
    'if(!window.chrome)window.chrome={};' +
    // runtime：空壳 + 抛错方法，对齐真实 Chrome 无扩展上下文时的表现
    'if(!window.chrome.runtime){window.chrome.runtime={' +
      'id:undefined,' +
      'connect:function(){throw new Error("Could not establish connection. Receiving end does not exist.");},' +
      'sendMessage:function(){throw new Error("Could not establish connection. Receiving end does not exist.");},' +
      'onMessage:{addListener:function(){},removeListener:function(){},hasListener:function(){return false;},hasListeners:function(){return false;}}' +
    '};}' +
    // loadTimes：从 performance.timing 派生，避免全 0 被判定为伪造
    'if(typeof window.chrome.loadTimes!=="function"){window.chrome.loadTimes=function(){' +
      'var t=(window.performance&&performance.timing)||{};' +
      'return{' +
        'requestTime:(t.navigationStart||0)/1000,' +
        'startLoadTime:(t.navigationStart||0)/1000,' +
        'commitLoadTime:(t.responseStart||0)/1000,' +
        'finishDocumentLoadTime:(t.domContentLoadedEventEnd||0)/1000,' +
        'finishLoadTime:(t.loadEventEnd||0)/1000,' +
        'firstPaintTime:0,firstPaintAfterLoadTime:0,' +
        'navigationType:"Other",wasFetchedViaSpdy:false,wasNpnNegotiated:false,' +
        'npnNegotiatedProtocol:"unknown",wasAlternateProtocolAvailable:false,connectionInfo:"unknown"' +
      '};};}' +
    // csi：真实 Chrome 返回 startE/onloadT/pageT/tran 四个字段
    'if(typeof window.chrome.csi!=="function"){window.chrome.csi=function(){' +
      'return{startE:Date.now(),onloadT:Date.now(),pageT:0,tran:15};};}' +
    // app：完整结构
    'if(!window.chrome.app){window.chrome.app={' +
      'isInstalled:false,' +
      'InstallState:{DISABLED:"disabled",INSTALLED:"installed",NOT_INSTALLED:"not_installed"},' +
      'RunningState:{CANNOT_RUN:"cannot_run",READY_TO_RUN:"ready_to_run",RUNNING:"running"},' +
      'getDetails:function(){return null;},' +
      'getIsInstalled:function(){return false;},' +
      'installState:function(){return "not_installed";},' +
      'runningState:function(){return "cannot_run";}' +
    '};}' +
  '}catch(e){}})();';
}

/**
 * 主世界脚本：修正 navigator.permissions.query 的返回值。
 *
 * 背景：Electron 对 notifications/geolocation/camera/microphone 全部返回 granted，
 * 真实 Chrome 默认是 prompt（用户从未授权过）。全 granted 是「异常」特征，
 * 比「机器人」更严重——风控会判定客户端行为不符合任何已知浏览器。
 *
 * 实现：只对已知 name 返回符合 Chrome 默认策略的状态，未知 name 回退原实现。
 * 不修改 Notification.permission，那是独立的一项（见 buildNotificationFix）。
 */
function buildPermissionsFix() {
  return '(function(){try{' +
    'var D={' +
      'notifications:"prompt",geolocation:"prompt",camera:"prompt",microphone:"prompt",' +
      '"clipboard-read":"prompt","clipboard-write":"granted",' +
      '"background-sync":"granted","persistent-storage":"prompt",' +
      'midi:"prompt",push:"prompt","screen-wake-lock":"granted",' +
      '"storage-access":"prompt","window-management":"prompt","local-fonts":"prompt",' +
      'accelerometer:"granted",gyroscope:"granted",magnetometer:"granted"' +
    '};' +
    'var P=navigator.permissions;if(!P||typeof P.query!=="function")return;' +
    'var orig=P.query.bind(P);' +
    'function mk(n,s){var o={name:n,state:s,onchange:null};' +
      'o.addEventListener=function(){};o.removeEventListener=function(){};' +
      'o.dispatchEvent=function(){return true;};return o;}' +
    'P.query=function(d){try{' +
      'var n=d&&d.name;' +
      'if(n&&Object.prototype.hasOwnProperty.call(D,n))return Promise.resolve(mk(n,D[n]));' +
    '}catch(e){}return orig(d);};' +
  '}catch(e){}})();';
}

/**
 * 主世界脚本：修正 Notification.permission。
 *
 * 背景：Electron 默认 granted，真实 Chrome 首次访问是 default（用户从未授权）。
 * granted 会让检测器判定「自动化环境预设授权」，是典型的非正常浏览器信号。
 */
function buildNotificationFix() {
  return '(function(){try{' +
    'if(typeof Notification==="undefined")return;' +
    'try{Object.defineProperty(Notification,"permission",{get:function(){return "default";},configurable:true});}catch(e){}' +
    'try{if(typeof Notification.requestPermission==="function"){' +
      'Notification.requestPermission=function(cb){' +
        'var p=Promise.resolve("default");' +
        'if(typeof cb==="function")p.then(cb);' +
        'return p;' +
      '};' +
    '}}catch(e){}' +
  '}catch(e){}})();';
}

module.exports = {
  buildChromeUserAgent,
  buildClientHintsHeaders,
  buildUserAgentDataFix,
  buildChromeObjectFix,
  buildPermissionsFix,
  buildNotificationFix,
  chromeMajor,
  chromeFullVersion,
};
