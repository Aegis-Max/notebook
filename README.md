# 康奈尔笔记

一个完全离线运行的原生 HTML 康奈尔笔记软件。笔记保存在当前浏览器的 `localStorage` 中，不需要账号、后端或网络资源。

## 运行

```bash
npm install
npm start
```

然后打开 <http://127.0.0.1:4173>。

## 测试

```bash
npm run test:unit
npm run test:e2e
npm test
```

端到端测试使用本机 Google Chrome，由 Playwright 驱动。运行时本身不依赖任何第三方库。

## 数据与备份

- 本地存储键：`cornell-notes:v1`
- 自动保存：停止输入约 500ms 后保存；切换笔记或页面隐藏时立即保存
- 导出：下载全部笔记的版本化 JSON 备份
- 导入：先整体校验，再按笔记 ID 合并；更新时间相同则保留本地版本
- 打印：只打印当前笔记，并自动使用 A4 康奈尔版式

浏览器站点数据被清除时，本地笔记也会被删除；请定期使用“导出”保存备份。

## 验收截图

- `screenshots/desktop-final.png`
- `screenshots/mobile-final.png`
