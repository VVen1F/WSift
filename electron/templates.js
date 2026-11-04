'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const BUILTIN = [
  {
    id: 'general',
    name: '通用',
    platform: '通用',
    builtin: true,
    body: `# {{title}}

## 漏洞信息

| 项目 | 内容 |
| --- | --- |
| 漏洞类型 | {{type}} |
| 危害等级 | {{level}} |
| 影响地址 | {{url}} |
| 测试时间 | {{date}} |

## 漏洞描述

{{description}}

## 复现步骤

{{steps}}

## 影响

{{impact}}

## 修复建议

{{fix}}
`
  },
  {
    id: 'butian',
    name: '补天',
    platform: '补天',
    builtin: true,
    body: `# {{title}}

**漏洞类型**：{{type}}
**危害等级**：{{level}}
**漏洞URL**：{{url}}

## 漏洞描述

{{description}}

## 复现过程

{{steps}}

## 修复建议

{{fix}}

## 备注

测试账号：{{account}}
`
  },
  {
    id: 'butian-box',
    name: '漏洞盒子',
    platform: '漏洞盒子',
    builtin: true,
    body: `## {{title}}

- 危害等级：{{level}}
- 漏洞类型：{{type}}
- 影响域名：{{url}}

### 漏洞详情

{{description}}

### 复现步骤

{{steps}}

### 修复方案

{{fix}}
`
  },
  {
    id: 'cnvd',
    name: 'CNVD',
    platform: 'CNVD',
    builtin: true,
    body: `# {{title}}

**报送单位**：{{author}}
**漏洞类型**：{{type}}
**危害级别**：{{level}}
**影响产品**：{{product}}

## 漏洞描述

{{description}}

## 漏洞证明

{{steps}}

## 修复方案

{{fix}}
`
  },
  {
    id: 'edu',
    name: '教育行业',
    platform: '教育行业',
    builtin: true,
    body: `# {{title}}

## 基本信息

| 项 | 值 |
| --- | --- |
| 系统名称 | {{product}} |
| 漏洞类型 | {{type}} |
| 危害等级 | {{level}} |
| 影响地址 | {{url}} |

## 漏洞描述

{{description}}

## 复现过程

{{steps}}

## 影响范围

{{impact}}

## 修复建议

{{fix}}
`
  }
];

function file() {
  return path.join(dataDir(), 'templates.json');
}

function loadAll() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch (e) {
    /* 首次运行 */
  }
  const seeded = JSON.parse(JSON.stringify(BUILTIN));
  saveAll(seeded);
  return seeded;
}

function saveAll(list) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function list() {
  return loadAll();
}

function upsert(tpl) {
  const all = loadAll();
  const item = {
    id: tpl.id || 'custom-' + Date.now().toString(36),
    name: tpl.name || '未命名模板',
    platform: tpl.platform || '自定义',
    builtin: !!tpl.builtin && !!all.find((t) => t.id === tpl.id),
    body: tpl.body || ''
  };
  const i = all.findIndex((t) => t.id === item.id);
  if (i >= 0) all[i] = item;
  else all.push(item);
  saveAll(all);
  return item;
}

function remove(id) {
  const all = loadAll().filter((t) => t.id !== id);
  saveAll(all);
  return all;
}

function reset() {
  return saveAll(JSON.parse(JSON.stringify(BUILTIN)));
}

module.exports = { list, upsert, remove, reset, BUILTIN, file };
