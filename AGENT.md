# 影记项目接手说明

这份文档是给新的 AI 对话环境、协作者或未来的自己准备的。目标不是介绍概念，而是让接手者在最短时间内理解这个项目当前做到哪里、怎么启动、哪些地方不能乱动、下一步该优先做什么。

## 1. 项目一句话定义

影记是一个本地优先的 YouTube 视频知识沉淀系统：

- 在 YouTube 页面里收藏或直接处理视频
- 抓取字幕或转录音频
- 调用可配置大模型做中文结构化总结
- 写入 Obsidian 指定文件夹
- 让视频内容进入长期知识库

## 2. 当前真实架构

项目不是单体应用，而是三端协同：

### A. Chrome 插件

路径：

- `/Users/xiaofei/Documents/Codex/projects/yingji/chrome-extension`

职责：

- 在 YouTube `watch` 页面注入悬浮按钮与侧边工作台
- 采集当前页面的视频元信息
- 尝试抓取当前页面可见字幕
- 调用本地后端创建或重试任务
- 展示任务当前状态、阶段、结果和错误信息

当前交互方向：

- 插件弹窗不是主界面，只是入口
- 主体验在页内侧边工作台
- 用户希望按钮更精致、侧边栏更紧凑、更小而美
- 用户不希望两个功能重复的弹窗并存

### B. WebUI

路径：

- `/Users/xiaofei/Documents/Codex/projects/yingji/webui`

职责：

- 提供完整的后台管理与配置中心
- 负责收藏页、工作台、沉淀池、设置页
- 提供模型配置、模型测试、模型发现、主题与文件夹管理
- 展示任务列表与最近结果

产品方向：

- 网站首页不应是普通后台首页，而是全屏封面页
- 进入后再进入业务页面
- 整体视觉已改为“影记”品牌
- 风格应高级、克制、研究控制台感，不要紫色 AI SaaS 模板

### C. Python 本地后端

路径：

- `/Users/xiaofei/Documents/Codex/projects/yingji/work/youtube_obsidian`

职责：

- 提供 HTTP API
- 管理任务队列与状态机
- 获取字幕 / 下载音频 / 转录
- 生成总结
- 写入 Obsidian
- 做主题分类与沉淀蒸馏

默认端口：

- `127.0.0.1:8765`

## 3. 关键文件与作用

### 后端

- `server.py`
  FastAPI 入口，定义 API、队列和 worker。
- `service.py`
  串起完整处理链路：元信息、字幕、转录、分类、总结、写入。
- `core.py`
  核心能力集合，包含模型调用、字幕抓取、音频下载、分类、摘要等。
- `storage.py`
  SQLite 任务存储。
- `config.example.json`
  配置模板。
- `config.json`
  本地私有运行配置，不应提交。

### 插件

- `background.js`
  后台状态保活、任务轮询与消息桥。
- `content.js`
  注入 YouTube 页面 UI，处理浮窗、侧边栏、页内字幕辅助抓取。
- `manifest.json`
  插件声明。
- `popup.*`
  现在只是轻入口，不应再承担完整工作流。

### 前端

- `src/App.tsx`
  主界面骨架。
- `src/api.ts`
  与本地后端的 API 通信层。
- `src/index.css` / `src/App.css`
  品牌色、布局、页面样式。
- `public/branding/*`
  影记 logo 与字标资源。

## 4. 当前产品已做成什么样

已经打通：

- 本地后端健康检查与任务轮询
- 收藏视频并创建任务
- 抓取官方字幕
- 无官方字幕时下载音频并转录
- 默认自动删除音频临时文件
- 支持外部模型 API 配置
- 支持测试模型连通性
- 支持发现模型列表
- 支持 Obsidian 路径输出
- 插件侧边工作台与 WebUI 双端协作

已经做过的重要产品决策：

- 不默认依赖本地大模型做字幕压缩
- 模型接入应该做连通性测试
- 插件主界面应改为页内常驻侧边工作台
- 用户需要过程可见，不接受黑盒处理
- 同视频应尽量避免重复创建多个任务

## 5. 当前最重要的已知问题

这些问题是后续接手时优先关注的：

1. 插件 UI 仍需精修
   目标是更紧凑、更精致、更少遮挡播放器，同时状态信息可读。

2. YouTube 机器人验证仍可能导致失败
   特别是在 `yt-dlp` 下载音频时，会出现：
   `Sign in to confirm you're not a bot`

3. 任务重入与取消体验仍需继续完善
   用户希望主按钮从“抓取并处理”切换成“中止任务”，减少误触重复任务。

4. 长字幕总结速度仍可优化
   用户希望尽量减少多轮分段总结，优先用更少调用次数完成总结。

5. 插件与 WebUI 的职责边界需要继续收紧
   插件负责“当前视频即时工作流”，WebUI 负责“全局管理与沉淀管理”。

## 6. API 概览

当前后端主要接口：

- `GET /health`
- `GET /config`
- `PUT /config/model`
- `POST /config/model/test`
- `POST /config/model/models`
- `PUT /config/app`
- `POST /config/topic-folders`
- `GET /jobs`
- `GET /jobs/{id}`
- `POST /jobs`
- `POST /jobs/{id}/process`
- `POST /jobs/{id}/retry`
- `PUT /jobs/{id}/topic`
- `DELETE /jobs/{id}`
- `POST /captures/youtube`
- `GET /library/folders`
- `POST /library/folders/{topic}/distill`

插件最重要的接口依赖：

- `POST /captures/youtube`
- `GET /jobs?url=...`
- `GET /jobs/{id}`
- `POST /jobs/{id}/retry`

## 7. 启动顺序

推荐顺序：

1. 启动后端
2. 启动 WebUI
3. 加载 Chrome 插件
4. 打开 YouTube 视频页测试

### 后端

```bash
cd /Users/xiaofei/Documents/Codex/projects/yingji/work/youtube_obsidian
PYTHONPATH=. ../.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
```

### WebUI

```bash
cd /Users/xiaofei/Documents/Codex/projects/yingji/webui
npm install
npm run dev
```

## 8. 本地运行依赖

后端依赖通常包括：

- `fastapi`
- `uvicorn`
- `yt-dlp`
- `faster-whisper`
- `ffmpeg`
- 与模型调用相关的 HTTP 客户端库

前端依赖基于：

- React
- TypeScript
- Vite
- GSAP
- Framer Motion
- TanStack Query

## 9. 不要提交的文件

以下内容必须视为本地环境文件或运行产物：

- `work/youtube_obsidian/config.json`
- `work/youtube_obsidian/jobs.db`
- `work/youtube_obsidian/.cache/`
- `webui/node_modules/`
- `webui/dist/`
- `work/.venv/`
- `__pycache__/`
- `.DS_Store`

## 10. 产品与设计约束

来自产品方向的硬约束：

- 不要做成典型白底紫色 AI SaaS 风格
- 不要做成黑盒聊天工具
- 状态必须可见
- 页面应有高级感与少量精致动效
- 插件与 WebUI 视觉需要统一
- 对中文用户友好，文案优先中文

## 11. 推荐下一步路线

如果是新的 AI 接手，建议按这个顺序推进：

1. 先确认本地后端健康和模型配置可用
2. 实测插件对一个有字幕视频、一个无字幕视频的完整流程
3. 优化插件主按钮状态机
4. 继续收紧插件 UI，保证单屏可见与非阻塞播放器
5. 再考虑插件打包、独立 App 和更完整的知识蒸馏能力

## 12. 如果出现“API 测试成功，但总结仍失败”

优先排查：

1. 模型名是否真的存在于当前服务商
2. 该服务商是否兼容标准 OpenAI Chat Completions
3. 长文本输入是否超时
4. 是否先走了错误的本地压缩链路
5. 是否存在旧任务内容被错误复用

不要只看设置页的“测试成功”提示，因为那只代表最短请求可通。

## 13. 当前项目名与仓库名

- 产品展示名：`影记`
- 仓库名：`ClipMind`

这是当前的过渡态。后续如需统一，可以再做仓库重命名、包名同步和品牌资源清理。
