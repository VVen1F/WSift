# Refract

漏洞复测与报告工作台。一个 macOS 桌面客户端，把「发包 → 截图 → 写报告」串成一条线。

## 功能

**复测**
- 直接粘贴原始 HTTP 请求，按字节发出，不经过任何中间层
- 响应按 Burp 的配色渲染：头名称藏青、Cookie 值暗红、JSON 键藏青、字符串绿、数字蓝
- 一键生成 PNG 截图，左右分栏、行号、换行与 Burp Repeater 一致
- 截图和请求全程留在本机

**报告**
- 选模板、填材料，调用你配置的大模型生成 Markdown 报告
- 后端内置写作约束：标题固定句式、不夸大、段落不超过三句、禁用「值得注意的是」「综上所述」这类腔调，保证每次输出风格一致
- 生成结果可编辑、可复制、保存时自动把截图放进 `images/` 并附在文末

**模板**
- 内置通用、补天、漏洞盒子、CNVD、教育行业五套
- 支持新建、修改、删除、恢复内置；模板里可用 `{{title}}` `{{url}}` 这类占位符

**模型**
- OpenAI 兼容与 Anthropic 兼容两种协议，可加多个服务，随时切换
- 支持流式输出，可测试连接、拉取模型列表

**更新**
- 从 GitHub Releases 检查新版本，进度条下载，macOS 上自动挂载 dmg、替换 `/Applications` 里的旧版本并重启

## 开发

```bash
npm install
npm start        # 需要图形环境
npm test         # 无界面冒烟测试
```

## 打包

```bash
npm run dist:mac     # 需要 macOS，产出 dist/*.dmg
npm run dist:linux   # 可选，产出 AppImage
```

推 `v*` 标签会触发 GitHub Actions，在 macOS 上打出 arm64 与 x64 两个 dmg 并附到 Release。

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 设置、模板 | `~/Library/Application Support/Refract/` |
| 截图 | 同上 `shots/` |
| 报告 | `~/Documents/Refract/<时间>-<标题>/` |

API Key 只写在本机 settings.json，不会上传。

## 已知限制

- 安装包未做 Apple 签名与公证。首次打开如果被拦，右键 → 打开，或在「系统设置 → 隐私与安全性」里放行。
- 自动更新依赖 Release 里的 dmg 资产名带 `.dmg`。
