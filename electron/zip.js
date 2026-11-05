'use strict';
// 最小 ZIP（UTF-8 文件名 + deflate/store）。只用 Node 内置模块。
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d) {
  const dt = d instanceof Date ? d : new Date();
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
  const date = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  return { time, date };
}

/**
 * @param {{name:string, data:Buffer|string}[]} files
 * @returns {Buffer}
 */
function write(files) {
  const list = files || [];
  const { time, date } = dosStamp(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of list) {
    const name = Buffer.from(String(f.name || '').replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data == null ? '' : f.data));
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw);
    const store = deflated.length >= raw.length;
    const method = store ? 0 : 8;
    const payload = store ? raw : deflated;
    const flags = 0x0800;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + payload.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, eocd]);
}

function list(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  const min = Math.max(0, b.length - (22 + 65535));
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOff = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
    names.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function read(buf, name) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const entry = list(b).find((e) => e.name === name);
  if (!entry) return null;
  const p = entry.localOff;
  if (b.readUInt32LE(p) !== 0x04034b50) throw new Error('本地头损坏');
  const method = b.readUInt16LE(p + 8);
  const compSize = b.readUInt32LE(p + 18);
  const nameLen = b.readUInt16LE(p + 26);
  const extraLen = b.readUInt16LE(p + 28);
  const data = b.slice(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error('不支持的压缩方式 ' + method);
}

module.exports = { write, list, read, crc32 };
