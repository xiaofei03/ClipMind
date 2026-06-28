# 影记 Yingji

影记是一个本地优先的 YouTube 知识采集与沉淀工具。它把高价值视频从“收藏过但会流走的信息”变成“进入 Obsidian 知识库的结构化笔记”：支持 YouTube 页面侧边插件采集、后台抓取字幕或音频转录、调用可配置大模型生成中文总结，并自动写入 Obsidian 指定主题文件夹。

当前项目由三部分组成：

- `chrome-extension/`
  YouTube 场景下的浏览器插件。主交互是页内悬浮按钮与侧边工作台，而不是传统一次性 popup。
- `webui/`
  本地 Web 控制台。负责收藏页、工作台、沉淀池、设置页，以及模型与 Obsidian 配置管理。
- `work/youtube_obsidian/`
  本地后台服务。负责任务队列、字幕获取、音频转录、模型总结、主题分类与 Markdown 写入。

## 核心能力

- 收藏 YouTube 视频并创建本地任务
- 优先抓取官方字幕
- 无字幕时自动走音频下载与转录兜底
- 支持浏览器侧抓取当前页面可见字幕作为辅助兜底
- 支持外部 API 模型配置，而不是只绑定本地模型
- 支持按主题写入 Obsidian 文件夹
- 支持知识沉淀与文件夹级蒸馏
- 支持任务状态可视化，避免黑盒处理

## 当前产品定位

影记不是典型“聊天即一切”的 AI 工具，而是一个本地优先、过程可见、可控性强的知识工作流产品。

- 品牌气质：冷静、克制、可信
- 交互原则：收藏、处理、沉淀在同一条链路里完成
- 技术原则：本地优先、WebUI + 插件协同、输出可追踪

## 目录结构

```text
.
├── AGENT.md
├── PRODUCT.md
├── README.md
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── webui/
│   ├── package.json
│   ├── public/
│   └── src/
└── work/
    └── youtube_obsidian/
        ├── server.py
        ├── service.py
        ├── core.py
        ├── storage.py
        ├── ingest_youtube.py
        ├── requirements.txt
        ├── config.example.json
        └── test_server.py
```

## 运行方式

### 1. 启动后端

```bash
cd /Users/xiaofei/Documents/Codex/projects/yingji/work/youtube_obsidian
python3 -m venv ../.venv
../.venv/bin/pip install -r requirements.txt
cp config.example.json config.json
PYTHONPATH=. ../.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
```

默认后端地址：

- `http://127.0.0.1:8765`

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

### 2. 启动 WebUI

```bash
cd /Users/xiaofei/Documents/Codex/projects/yingji/webui
npm install
npm run dev
```

默认前端地址：

- `http://127.0.0.1:4173`

### 3. 加载 Chrome 插件

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择项目中的 `chrome-extension/`

插件当前设计：

- 点击扩展图标只作为轻入口
- 主要工作流在 YouTube 播放页中的悬浮按钮与侧边工作台内完成

## 配置说明

后端本地配置文件：

- `work/youtube_obsidian/config.example.json`
- `work/youtube_obsidian/config.json`：本地私有配置，不应提交

至少需要配置：

- `obsidian_output_dir`
- 模型提供商、模型名、API Base URL、API Key
- 默认标签、主题文件夹映射

## 处理链路

```text
YouTube 视频页
-> Chrome 插件侧边工作台
-> 本地后端创建任务
-> 优先抓官方字幕
-> 失败则尝试页面辅助字幕
-> 再失败则下载音频并转录
-> 主题分类
-> 大模型总结
-> 生成 Markdown
-> 写入 Obsidian 目标文件夹
```

## 当前状态

已经完成的部分：

- 本地后端服务与任务队列
- WebUI 基本控制台
- YouTube 插件侧边工作台
- Obsidian 写入链路
- 模型配置、模型连通性测试、模型发现接口
- 无字幕视频的转录兜底
- 默认自动删除临时音频缓存

仍在持续打磨的部分：

- 插件 UI/交互精修
- 任务重入与取消体验
- 失败原因可视化
- 总结速度与长字幕压缩策略
- 更稳定的 YouTube 反爬/机器人验证兜底

## 常见问题

### 1. 为什么有些视频会失败

常见原因：

- YouTube 官方要求登录，`yt-dlp` 触发机器人验证
- 当前视频无官方字幕，且页面辅助抓取也失败
- 本地未安装 `ffmpeg`
- 模型 API 可连通，但所选模型名无效
- 本地 `config.json` 未正确配置 Obsidian 路径或模型参数

### 2. 为什么 API 明明测试成功，总结时还是失败

模型接口测试成功只代表“这个接口可访问”，不代表：

- 模型名一定正确
- 当前服务商兼容 OpenAI Chat Completions 结构
- 长文本输入不会超时
- 该模型能稳定处理中文长摘要任务

因此影记在接入模型时，需要分别关注：

- 接口是否可访问
- 可用模型列表是否发现成功
- 模型名是否正确选中
- 真实总结任务是否能在超时时间内完成

## Git 提交建议

建议只提交源码和文档，不提交本地运行产物：

- 不提交 `node_modules/`
- 不提交 `dist/`
- 不提交 `jobs.db`
- 不提交 `config.json`
- 不提交 `.cache/`
- 不提交本地虚拟环境

## 项目命名说明

产品当前中文名是“影记”，强调把视频变成知识笔记。

仓库名目前保留为 `ClipMind`，是因为你希望直接更新原仓库；后续如果需要，也可以再统一仓库名、包名与前端展示文案。
