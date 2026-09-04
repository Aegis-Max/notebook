import { createNote, type Note } from './note-store.js';

export const BUILTIN_EXAMPLE_NOTE_ID = 'builtin-example:codex-workshop:v1';

const BUILTIN_EXAMPLE_TIMESTAMP = '2026-06-08T00:00:00.000Z';

const CUES = `基础篇
1. 首次使用 Codex，需要依次完成哪些准备工作？
2. 预览区域、Annotate 与预览安全限制分别解决什么问题？
3. 三种安全模式与模型配置应如何配合？

进阶篇
4. 内置终端、编辑消息、Git 与 Fork 各适合什么场景？
5. 如何用会话归档和 AGENTS.md 保持项目上下文清晰？
6. Plan Mode、Side Chat、并行任务与 Steer 如何配合完成复杂任务？

扩展篇
7. Plugin 可以把 Codex 扩展到哪些外部工具？
8. Plugin 与 Skill 的职责有什么不同？
9. 如何通过定时任务和 Codex Mobile 延伸工作流？`;

const NOTES = `基础篇｜上手实战、核心配置与注意事项
01:01 下载并安装 Codex
01:25 Codex 登录与套餐选择
03:27 实现第一版马克笔记
06:05 预览区域的使用
06:39 Annotate
08:18 预览区域的安全限制
10:06 三种安全模式
12:17 模型配置

进阶篇｜版本控制、会话管理与任务调度
13:50 使用内置终端
14:54 编辑消息
16:48 使用 Codex 的 Git 功能
18:22 Fork
24:43 会话归档
25:37 AGENTS.md
29:32 Plan Mode
32:06 Side Chat
35:27 同时运行多个任务
36:27 使用 Steer 中途追加命令

扩展篇｜插件、技能、自动化与远程控制
40:14 Plugin 简介
42:37 使用 Presentations Plugin 做 PPT
44:30 使用 Chrome Plugin 操作浏览器
46:52 使用 Computer Use Plugin 操作电脑
49:37 使用 Image Gen Skill 生成图片
50:39 截图
52:42 自己写一个 Skill
53:47 定时任务
56:03 Codex Mobile`;

const SUMMARY =
  '这套课程按照“基础上手—进阶协作—能力扩展”的路径组织 Codex 学习：先完成安装登录、预览安全与模型配置，再掌握终端、Git、会话和任务调度，最后通过 Plugin、Skill、定时任务与 Codex Mobile 扩展工作流。复习时应能根据左侧问题，不看目录复述三个阶段的关键工具与使用顺序。';

/** 创建一条内容固定、可安全写入和编辑的内置 Cornell 笔记。 */
export function createBuiltinExampleNote(): Note {
  return createNote(
    {
      id: BUILTIN_EXAMPLE_NOTE_ID,
      title: 'Codex 工作坊：从基础使用到插件、技能与自动化',
      date: '2026-06-08',
      cues: CUES,
      notes: NOTES,
      summary: SUMMARY,
    },
    { now: BUILTIN_EXAMPLE_TIMESTAMP },
  );
}
