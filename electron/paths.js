'use strict';
const path = require('path');
const fs = require('fs');

/**
 * 数据目录。
 *
 * 品牌从 Refract 换成 WSift 后，Electron 的 userData 目录名跟着 productName 变了；
 * 直接换会看不到旧版本的任务、报告、账号和设置。这里的规则：
 *   - 新目录不存在、旧目录（Refract）存在 → 继续用旧目录，数据零迁移；
 *   - 两个都在 → 用新目录（用户已经在新版本里跑过）；
 *   - 两个都没 → 用新目录。
 */
function resolveUserData(app) {
  const dir = app.getPath('userData');
  try {
    const legacy = path.join(path.dirname(dir), 'Refract');
    // Electron 启动时就会建好新目录，所以不能只看目录是否存在，要看里面有没有 settings.json
    const hasNew = fs.existsSync(path.join(dir, 'settings.json'));
    const hasOld = fs.existsSync(path.join(legacy, 'settings.json'));
    if (legacy !== dir && hasOld && !hasNew) {
      app.setPath('userData', legacy);
      return legacy;
    }
  } catch (e) {
    // 读不到旧目录就按新目录走，不阻塞启动
  }
  return dir;
}

function dataDir() {
  const env = process.env.WSIFT_DATA_DIR || process.env.REFRACT_DATA_DIR;
  if (env) {
    fs.mkdirSync(env, { recursive: true });
    return env;
  }
  const { app } = require('electron');
  const dir = resolveUserData(app);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { dataDir, ensure, resolveUserData };
