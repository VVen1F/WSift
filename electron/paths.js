'use strict';
const path = require('path');
const fs = require('fs');

function dataDir() {
  if (process.env.REFRACT_DATA_DIR) {
    fs.mkdirSync(process.env.REFRACT_DATA_DIR, { recursive: true });
    return process.env.REFRACT_DATA_DIR;
  }
  const { app } = require('electron');
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { dataDir, ensure };
