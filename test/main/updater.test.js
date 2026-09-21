'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const origLoad = Module._load;

function installMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
        dialog: { showMessageBox: async () => ({ response: 0 }) },
        Notification: { isSupported: () => false },
      };
    }
    if (request === 'electron-updater') {
      return {
        autoUpdater: {
          logger: null,
          autoDownload: true,
          autoInstallOnAppQuit: true,
          on: () => {},
          checkForUpdates: async () => {},
          downloadUpdate: async () => {},
          quitAndInstall: () => {},
        },
      };
    }
    if (request === 'electron-log') {
      return {
        transports: { file: { level: '' } },
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
      };
    }
    return origLoad.apply(this, arguments);
  };
}
function uninstallMock() {
  Module._load = origLoad;
}

beforeEach(() => {
  installMock();
  delete require.cache[require.resolve('../../src/main/updater')];
});

afterEach(() => {
  uninstallMock();
  delete require.cache[require.resolve('../../src/main/updater')];
});

test('isNetworkError 识别网络错误', () => {
  const updater = require('../../src/main/updater');
  assert.strictEqual(updater.isNetworkError({ message: 'net::ERR_CONNECTION_REFUSED' }), true);
  assert.strictEqual(updater.isNetworkError({ message: 'ECONNREFUSED' }), true);
  assert.strictEqual(updater.isNetworkError({ message: 'ETIMEDOUT' }), true);
  assert.strictEqual(updater.isNetworkError({ message: 'socket hang up' }), true);
});

test('isNetworkError 非网络错误返回 false', () => {
  const updater = require('../../src/main/updater');
  assert.strictEqual(updater.isNetworkError({ message: 'Cannot find latest.yml' }), false);
  assert.strictEqual(updater.isNetworkError({ message: 'unknown error' }), false);
  assert.strictEqual(updater.isNetworkError(null), false);
});

test('isGitHubAccessError 识别 GitHub 错误', () => {
  const updater = require('../../src/main/updater');
  assert.strictEqual(updater.isGitHubAccessError({ message: 'HttpError: 404' }), true);
  assert.strictEqual(updater.isGitHubAccessError({ message: 'api.github.com rate limit' }), true);
  assert.strictEqual(updater.isGitHubAccessError({ message: 'forbidden' }), true);
});

test('isGitHubAccessError 非 GitHub 错误返回 false', () => {
  const updater = require('../../src/main/updater');
  assert.strictEqual(updater.isGitHubAccessError({ message: 'ECONNREFUSED' }), false);
  assert.strictEqual(updater.isGitHubAccessError({ message: 'generic failure' }), false);
  assert.strictEqual(updater.isGitHubAccessError(null), false);
});

test('initAutoUpdater 开发环境不检查更新', () => {
  const updater = require('../../src/main/updater');
  // app.isPackaged 是 false，initAutoUpdater 应该直接返回，不抛异常
  assert.doesNotThrow(() => updater.initAutoUpdater({ isDestroyed: () => false }));
});
