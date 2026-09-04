# 康奈尔笔记

一个使用 Electron、React 和 TypeScript 构建的 macOS 康奈尔笔记桌面客户端。基础笔记功能离线可用；只有用户主动开始 AI 复习时，应用才会调用所选的云端模型或本机 Ollama。

## 功能

- 创建、编辑、搜索、删除和自动保存康奈尔笔记。
- 导入、导出版本化 JSON 备份，并按 A4 康奈尔版式打印当前笔记。
- AI 以“学习教练”而非“笔记代写者”的方式辅助内化：
  - **回忆模式**：从当前笔记生成 3～5 道有原文依据的问题，用户提交初答后才可查看提示和依据。
  - **费曼讲解**：用户先用自己的话解释，AI 只指出遗漏、模糊和可能错误，并继续追问。
  - **间隔复习队列**：根据正确度、信心和提示使用情况，安排次日、3 日或 7 日后的变式复习。

完整产品边界、反馈契约和验收标准见 [AI 学习教练首版规范](docs/ai-study-coach-v1.md)。

## 开发启动

```bash
npm install
npm run dev
```

该命令会启动 Vite 开发服务器和 Electron 客户端。仅需在浏览器中预览笔记界面时，可以运行：

```bash
npm run dev:web
```

浏览器预览地址为 <http://127.0.0.1:4173>；它使用独立的 `localStorage`，不与桌面数据互通，AI 与原生文件能力也只在 Electron 客户端中可用。执行一次完整构建并启动客户端可使用 `npm start`。

## 测试

```bash
npm run test:unit
npm run test:e2e:web
npm run test:e2e:electron
npm run test:e2e
npm test
```

`npm test` 会依次运行单元测试、浏览器端到端测试和 Electron 端到端测试。提交前还可单独执行类型检查和生产构建：

```bash
npm run typecheck
npm run build
```

## 构建 macOS 安装包

当前打包目标为 macOS Apple Silicon（arm64）：

```bash
npm run package:mac
```

产物位于 `release/`，包括 `Cornell-Notebook-<version>-arm64.dmg` 和未压缩的 `mac-arm64/康奈尔笔记.app`。首版未做代码签名和公证，因此分发到其他 Mac 时可能触发系统安全提示。

## 数据与备份

- 笔记、复习会话、复习卡片和作答记录保存在 Electron `userData` 目录下的 `cornell-data.json`，采用原子写入。
- 自动保存：停止输入约 500ms 后保存；切换笔记或页面隐藏时立即保存
- 导出：保存包含笔记和复习数据的版本化 JSON 备份
- 导入：先整体校验，再按 ID 合并；兼容旧版 v1 笔记备份
- 打印：只打印当前笔记，并自动使用 A4 康奈尔版式
- AI 设置保存在同一 `userData` 目录下的 `ai-settings.json`。云端密钥只由 Electron 主进程访问，并通过 `safeStorage` 使用系统安全存储能力加密；渲染进程只能得知是否已经配置，密钥不会进入笔记备份。
- 应用不会自动上传整本笔记。只有用户主动进入 AI 复习后，才会向所选服务发送当前笔记所需的冻结片段；Ollama 地址仅允许本机回环地址。

本地文件损坏或应用数据被移除仍可能造成数据丢失，请定期使用“导出”保存备份。

## 当前 MVP 限制

- 只支持基于当前单篇笔记的 AI 训练，不包含跨章节训练。
- 不提供通用聊天、一键完整总结、全文润色、自动改写笔记或知识图谱。
- 云端模式需要用户自备 OpenAI 兼容接口密钥；本地模式需要自行安装并启动 Ollama 及相应模型。
- 尚未包含代码签名、公证和自动更新。

## 验收截图

- `screenshots/desktop-final.png`
- `screenshots/mobile-final.png`
