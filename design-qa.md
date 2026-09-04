# 模型 API 设置视觉 QA

- source visual truth path: `/var/folders/9l/73hg_f8x6fs_0v02bbqb181c0000gn/T/codex-clipboard-9ee1fa8d-b457-4dc2-9bfa-dca040b9808e.png`
- implementation screenshot path: `/tmp/cornell-ai-settings-top.png`
- combined comparison path: `/tmp/cornell-ai-settings-comparison.png`
- focused implementation path: `/tmp/cornell-ai-settings-models.png`
- viewport: `1440 x 811` CSS px, Electron device scale factor `2`
- source pixels: `1544 x 1074`
- implementation pixels: `2880 x 1622`
- combined comparison pixels: `2800 x 1000`
- state: 云端模型、DeepSeek 预设、本次密钥已输入、模型发现成功
- density normalization: 对照图将来源截图和实现截图按内容区域等高缩放后并排；来源是信息结构参考，不是本产品的逐像素视觉稿，因此不对不同产品外壳做像素误差判断。

## Full-view comparison evidence

并排对照确认实现保留了参考图的核心层级：API 密钥、API 基础地址、模型检测结果、当前模型和操作按钮。实现根据已确认范围增加运行方式与服务预设，并沿用康奈尔笔记既有绿色桌面设计系统；未复制参考图中的多密钥、逐模型管理和第三方品牌装饰。

## Focused region comparison evidence

完整对照图中的密钥、地址和模型区域已经清晰可读；额外的模型区域截图用于核对滚动后的搜索、选中态、手填兜底与固定操作区。由于来源只提供单一桌面局部状态，未再制作重复的局部并排图。

## Required fidelity surfaces

- Fonts and typography: 标题、段落、字段标签、等宽 endpoint 预览与按钮层级清楚，字重和行高沿用现有应用；未发现截断或不可读文本。
- Spacing and layout rhythm: 双列运行方式、三列预设、分区卡片、模型滚动列表和底部操作区对齐稳定；长内容通过面板纵向滚动访问，无横向溢出。
- Colors and visual tokens: 使用现有深绿、浅绿、白色与语义成功/警告色；选中态、焦点态和未保存状态可区分。
- Image quality and asset fidelity: 参考界面没有任务所需的品牌图片或内容图像；实现没有新增占位图片、仿制品牌标识或低清资源。
- Copy and content: 明确说明基础地址的含义并预览最终 endpoint；区分检测、草稿测试和显式保存；明确测试不发送笔记且已存密钥不回显。

## Findings

没有发现可执行的 P0、P1 或 P2 视觉问题。

参考图与实现之间的外壳、颜色和额外预设区属于已确认的产品约束差异，而非设计漂移。

## Comparison history

- Pass 1: 未发现 P0/P1/P2；无需视觉修复迭代。

## Primary interactions checked

- 从应用工具栏直接打开模型 API 设置。
- 切换云端模型与 DeepSeek 预设。
- 输入并切换本次密钥显隐。
- 检测模型、搜索和选择模型。
- 测试草稿连接且不保存。
- 显式保存、关闭并恢复焦点。
- 使用 `Command/Ctrl + ,` 打开后返回原焦点。

## Console check

Electron 端到端流程没有捕获到应用 `console.error`。

final result: passed
