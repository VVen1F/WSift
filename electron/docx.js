'use strict';
/**
 * 极简 .docx 生成：只为了把报告传上雷神众测（平台只收 .docx）。
 * 一个 docx 就是一个 zip：document.xml + 关系 + 图片，不引第三方库。
 */
const fs = require('fs');
const zip = require('./zip');

const EMU_PER_PX = 9525;             // 96dpi 下 1px = 9525 EMU
const CONTENT_WIDTH = 5700000;       // A4 去掉左右 2.54cm 页边距的内容宽度（EMU）

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 读 PNG 像素尺寸（IHDR），读不出就按 1200x800 估。 */
function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
  } catch (e) { /* 不是 png */ }
  return { w: 1200, h: 800 };
}

function run(text, opts = {}) {
  const bold = opts.bold ? '<w:b/>' : '';
  const size = opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '';
  const color = opts.color ? `<w:color w:val="${opts.color}"/>` : '';
  const font = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>';
  const parts = String(text == null ? '' : text).split('\n');
  return parts.map((line, i) => {
    const br = i ? '<w:br/>' : '';
    return `<w:r><w:rPr>${font}${bold}${size}${color}</w:rPr>${br}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`;
  }).join('');
}

function para(text, opts = {}) {
  const jc = opts.align ? `<w:jc w:val="${opts.align}"/>` : '';
  const spacing = opts.after ? `<w:spacing w:before="0" w:after="${opts.after}"/>` : '';
  return `<w:p><w:pPr>${spacing}${jc}</w:pPr>${run(text, opts)}</w:p>`;
}

function imagePara(relId, id, size) {
  const ratio = size.h / size.w || 0.75;
  const cx = Math.min(CONTENT_WIDTH, size.w * EMU_PER_PX);
  const cy = Math.round(cx * ratio);
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="图片${id}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>`;

const DOC_TAIL = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

/**
 * 把报告正文和截图拼成 docx。
 * @param {{markdown:string, title?:string, images:string[]}} input
 * @returns {{buffer:Buffer, images:number, bytes:number}}
 */
function build(input = {}) {
  const md = String(input.markdown || '');
  const images = (input.images || []).filter((p) => p && fs.existsSync(p));
  const used = [];
  const media = [];
  const rels = [];

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const body = [];
  let first = true;
  let imageIndex = 0;

  const pushImage = (file) => {
    if (!file || !fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    const size = pngSize(buf);
    imageIndex += 1;
    const rid = 'rId' + (100 + imageIndex);
    media.push({ name: `image${imageIndex}.png`, data: buf });
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageIndex}.png"/>`);
    used.push(file);
    body.push(imagePara(rid, imageIndex, size));
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const img = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(line.trim());
    if (img) {
      const name = img[1].split('/').pop();
      const idx = Number((/(\d+)\.png$/i.exec(name) || [])[1]) - 1;
      const file = images[idx] || images[imageIndex];
      pushImage(file);
      continue;
    }
    if (!line.trim()) {
      if (!first) body.push('<w:p/>');
      continue;
    }
    if (first) {
      body.push(para(input.title || line.trim(), { bold: true, size: 36, after: 240 }));
      first = false;
      continue;
    }
    const plain = line.replace(/^#+\s*/, '');
    body.push(para(plain, { size: 21, after: 80 }));
  }

  // 正文里没引用到的图，统一补在最后
  for (const file of images) if (!used.includes(file)) pushImage(file);

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(DOC_HEAD + body.join('') + DOC_TAIL, 'utf8') }
  ];
  if (rels.length) {
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
    files.push({ name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') });
    for (const m of media) files.push({ name: 'word/media/' + m.name, data: m.data });
  }
  const buffer = zip.write(files);
  return { buffer, images: media.length, bytes: buffer.length };
}

function save(file, input) {
  const out = build(input);
  fs.writeFileSync(file, out.buffer);
  return Object.assign({ file }, out);
}

module.exports = { build, save, pngSize };
