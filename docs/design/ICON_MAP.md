# 图标映射表

共 26 个图标，全部来自 DeepSeek Harness 官方资源，**不自行绘制**：

- 来源：`deepseek-ai/deepseek-harness` → `packages/client/ui-primitives/src/icons/artwork.ts`
- 许可：MIT License, Copyright (c) 2026 DeepSeek。复制到本项目的 `renderer/icons.js` 时保留原始 `<svg>`、`viewBox` 和路径，只注入宽高。
- 规格：viewBox `0 0 16 16`，细线 1px / 中粗 1.3px（DSH 的 regular / medium 两档），渲染尺寸只用 14 和 16。

## 映射

| 语义 | artwork 键 | 渲染尺寸 | 用在哪 |
|---|---|---|---|
| 新建任务 / 新建工作区 | `plus-outline` | 16 | 侧栏「新建任务」、工作区右侧加号 |
| 测试（发包） | `send-outline` | 16 | 侧栏「测试」 |
| 模板 | `layers-outline` | 16 | 侧栏「模板」 |
| 设置 | `settings-outline` | 16 | 侧栏底部「设置」 |
| 工作区展开 | `folder-open` | 16 | 工作区展开态 |
| 工作区折叠 | `folder-close` | 16 | 工作区折叠态 |
| 展开指示器 | `chevron-down-outline` | 12 | 工作区行左侧，折叠时旋转 -90° |
| 更多操作 | `ellipsis-outline` | 16 | 备用 |
| 搜索 | `search-outline` | 16 | 归档搜索 |
| 复制 | `copy-outline` | 16 | 复制网关地址等 |
| 删除 | `trash-outline` | 16 | 删除确认 |
| 归档 / 取消归档 | `archive-outline` / `unarchive-outline` | 16 | 任务菜单 |
| 关闭 | `close-outline` | 16 | 弹窗右上角 |
| 刷新 | `refresh-outline` | 16 | 类型刷新 |
| 下载 | `download-outline` | 16 | 导出 |
| 保存 | `save-outline` | 16 | 模板保存 |
| 编辑 | `edit-outline` | 16 | 重命名 |
| 面板折叠 | `panel-left-outline` | 16 | 侧栏收起 |
| 浅色外观 | `light-outline` | 22 | 设置 → 外观 |
| 深色外观 | `dark-outline` | 22 | 设置 → 外观 |
| 跟随系统 | `followsystem-outline` | 22 | 设置 → 外观 |
| 弹窗关闭 | `close-outline` | 16 | 所有弹窗右上角（替换 `×` 字符） |
| 完成勾选 | `check-outline` | 16 | 模型选择当前项 |
| 警告 / 提示 | `warning-outline` / `info-outline` | 16 | 错误提示 |

## 使用方式

```js
el.innerHTML = icon('folder-open', 16);      // 或
// HTML 里用占位，boot 时统一填充：
<span class="nav-ic" data-icon="plus-outline"></span>
```

## 约束

- 不允许用 Emoji、Unicode 符号（▾、▸、＋）当功能图标。
- 不允许混入其他图标库。
- 同一语义只能有一个图标；新增图标时先查本表，再从 artwork.ts 复制。
- 图标按钮必须有 `aria-label`，`icon-btn` 的 Tooltip 直接读它。
