# UI 迁移报告（DSH 设计体系）

## 1. 基线与范围

- 备份：动手前把整个工作区复制到 `/tmp/refract-baseline-20261112-214507/refract-work`（当前目录不是 git 仓库，用副本保底）。
- 基线截图：36 张，覆盖报告页 / 测试页 / 模板页 / 设置五个分区 / 提交弹窗 × 浅色深色 × 1280 与 900 宽，存放在 `/tmp/ui-shots`。
- 改造范围：只动视觉层（`renderer/style.css`、少量 `index.html` 结构与 `app.js` 里的 class），业务逻辑、IPC、数据结构不动。

## 2. 规范来源

已实际读取（GitHub API 拉取官方仓库 master）：

- `.agents/skills/dsh-client-ui-ux/SKILL.md` 及 `references/{alignment,spacing,icons}.md`
- `packages/client/ui-layout/README.zh.md`
- `packages/client/ui-theme/README.md`
- `packages/client/ui-sidebar/README.md`
- `docs/web-styling.md`、`docs/ui-radius.md`
- 本机安装包 `@deepseek-ai/dsh-client-ui-theme`、`-ui-layout`、`-ui-sidebar` 的 README 与目录结构（用于确认 token 的 `--dsw-*` 命名与实际存在的包）

无法核实：DSH 各插件的具体 CSS 数值（主题 token 在运行时由 `lib/client.js` 生成，安装包里只有品牌字体 CSS）。因此颜色/尺寸以官方文档里明确写出的值为准，其余按本产品窗口尺寸重新推导，文中已标明哪些是推导值。

## 3. 本轮改动

### 3.1 设计 Token

在 `renderer/style.css` 的 `:root` 增加三组尺：

- 间距：`--sp-1..--sp-8`（4/8/12/16/20/24/32/40）
- 字号：`--fs-11/12/13/14/16/20/32`
- 控件高度：`--h-ctl: 28px`、`--h-ctl-lg: 32px`、`--h-row: 22px`

### 3.2 圆角归一

清除 `border-radius` 的裸数值（10px ×10、8px ×8、12px ×3、6px ×2、4px ×1），全部换成 `--dsw-radius-*` 六档；保留的裸值是结构性的 `50%`（圆点）、`999px`（胶囊）、品牌点 `7px/2px`。

### 3.3 文档

- `docs/design/DSH_DESIGN_SYSTEM.md`
- `docs/design/DSH_LAYOUT_RULES.md`
- `docs/design/DSH_COMPONENT_RULES.md`

## 4. 验证

- `node test/run.js`：177 项全过（本轮只改 CSS/文档，不涉及逻辑）。
- 改后重新截图 36 张（`/tmp/ui-shots-after`），逐页对比基线：报告页、测试页与基线像素一致；设置页、弹窗未出现错位或溢出。
- 覆盖到的状态：浅色/深色、1280/900 宽、空列表、弹窗打开态。

## 5. 遗留问题（下一轮）

1. 还有 14 处裸圆角是结构性的（圆点/胶囊），需要逐个确认是否保留。
2. `border-radius: 0` 与 `999px` 混用在分段控件上，需统一。
3. 字号仍有 11/12/13/14 混用在同一行的情况，要按尺表重排（列表行 13、说明 12）。
4. 设置页「截图目录」长路径挤压按钮，需要截断 + tooltip。
5. 控件高度 20/22/24/28/32/36 并存，需要按变体收敛。
6. 弹窗边界、菜单翻转、Escape 关闭还没逐个验证。
7. 深色主题下部分 `--caption` 文字对比度偏低，需复核。
8. 图标仍混用 1.6/1.7/1.8 描边与 14/15/16 尺寸，需要统一到 1.7 + 16。
