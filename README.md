# 大肥鱼桌宠 · PI-Desktop 插件

把 [lilulj/dsh-dafeiyu-pet](https://github.com/lilulj/dsh-dafeiyu-pet)（原 DSH / Cordis 插件）移植到
**PI-Desktop**：透明桌面宠物、104 个动作、语音、设置页，并跟着 AI 会话状态切换表情。

> 插件本体只有几十 KB。helper 程序与 104 个动作的素材包共约 **580 MB**，
> 首次启动时从上游 Release 自动下载，只下一次。

![platform](https://img.shields.io/badge/platform-Windows%20x64-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![pi-desktop](https://img.shields.io/badge/PI--Desktop-%E2%89%A50.17-orange)

---

## 功能

| | |
| :--- | :--- |
| **桌宠** | 逐像素透明、可拖动、右键菜单、状态气泡、置顶、贴地 |
| **104 个动作** | 吃喝 / 玩乐 / 节日 / 情绪 / 工作 / 特效等，右键「动作」分 11 组 |
| **跟随 AI** | 思考 → 干活 → 完成 → 待命，动画与气泡跟着会话走 |
| **语音** | edge-tts 合成，电脑本机播放，免 key |
| **AI 工具** | `dafeiyu_play_action`（播动作）、`dafeiyu_speak`（说话） |
| **设置页** | <http://127.0.0.1:7811/> — 大小、动画速度、待命文案、音色… |
| **可调** | 动画速度 0.5–2.5×、待命文案支持 `{time}` / `{date}` / `{weekday}` |

---

## 环境要求

- **Windows x64**（helper 是 Windows 可执行文件，播放走系统 MCI）
- **PI-Desktop ≥ 0.17**
- **Python 3.9+**，并装好语音依赖：`python -m pip install edge-tts`
  （不装也能用，只是没有声音）
- 首次启动需要联网（下载素材，约 580 MB）

---

## 安装

### 方式一：`.piplug` 安装包

1. 从 Releases 下载 `local.dafeiyu-pet-<版本>.piplug`
2. PI-Desktop **设置 → 插件 → 安装本地插件**，选择该文件
3. 重新加载插件（首次会提示权限：`agent.tool.register`、`agent.extension`，同意即可）

### 方式二：手动放目录

把本仓库所有文件放到：

```
%APPDATA%\PI-Desktop\plugins\installed\local.dafeiyu-pet\
```

在 PI-Desktop **设置 → 插件** 里重新加载，或重启 PI-Desktop。

### 方式三：开发模式（改代码即时生效）

把本目录路径注册为开发插件后，改 `main.js` 会自动热重载；但
`agent-extension.mjs` 跑在 agent 进程里，改它要重启 PI-Desktop 才生效。

---

## 首次启动

1. 素材不在 → 自动用系统 `curl` 下载并用 `tar` 解压到
   `%APPDATA%\PI-Desktop\dafeiyu-pet-home\dafeiyu-pet\`
   （日志会打印「开始下载素材（约 580MB，只此一次）」）
2. 解压完成后自动启动桌宠，出现在屏幕右下角
3. 之后每次启动都是秒开

> 下载卡住通常是网络：插件用系统 `curl.exe`，会自动走系统代理。
> 也可以手动指定镜像：设置环境变量 `DAFEIYU_PET_ASSETS_URL` 指向自建地址。

排查日志：`%APPDATA%\PI-Desktop\dafeiyu-pet-home\dafeiyu-pet\plugin.log`

---

## 使用

| 操作 | 效果 |
| :--- | :--- |
| **右键桌宠** | 动作（11 组）/ 大小 / 各种开关 / 打开设置 / 退出 |
| **左键拖动** | 随便搬位置，松手落地 |
| **设置页** | <http://127.0.0.1:7811/> |
| **让 AI 播动作** | 直接说「做个开心的动作」，模型会调 `dafeiyu_play_action` |
| **让她说话** | 说「用大肥鱼的声音念…」，或 `POST /play` 手动触发动作 |

手动调控制口：

```powershell
# 动作清单（104 个）
Invoke-RestMethod http://127.0.0.1:7799/health

# 播一个动作
Invoke-RestMethod -Method Post http://127.0.0.1:7799/play -Body '{"clip":"ext_happy"}' -ContentType application/json
```

---

## 配置

数据目录：`%APPDATA%\PI-Desktop\dafeiyu-pet-home\dafeiyu-pet\`
（`config.json` / `layout.json` / `plugin.log` / `state.jsonl` / `voice/` / `tmp/`）

设置页可改的项：

| 字段 | 默认 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | 总开关（关掉不启动桌宠） |
| `petName` | `大肥鱼` | 提示词与工具描述里的称呼 |
| `animSpeed` | `1.5` | 动画倍速，1 = 素材原速（42ms/帧） |
| `scale` / `bubbleScale` | `0.6` / `0.8` | 角色 / 气泡缩放 |
| `activityLevel` | `lively` | 待机活跃度 `quiet` / `normal` / `lively` |
| `actionDelayMs` | `4500` | 动作延时（等回复播完再动） |
| `idleSummary` | `🐳 待命中 · {time}` | 气泡左下角常驻文案，支持占位符 |
| `voiceName` | `zh-CN-XiaoyiNeural` | edge-tts 音色名 |
| `voiceRate` / `voicePitch` | `1.08` / `+6Hz` | 语速倍率 / 音调偏移 |
| `qqAppId` / `qqAppSecret` / `qqOpenId` | 空 | 可选：语音发成 QQ 语音条 |

改 `animSpeed` 后 1～2 秒自动重启桌宠生效；`scale` 需要重启 PI-Desktop。

---

## 工作原理（简述）

```
PI-Desktop 插件主进程 (main.js)
  ├─ spawn dsh-dafeiyu-helper.exe ── JSONL stdin/stdout ──▶ 桌宠窗口
  ├─ pi.agent.registerTool ×2      ──▶ AI 可调的动作 / 语音
  └─ fs.watch state.jsonl ◀── 写入 ── agent-extension.mjs（agent 进程）
```

`agent-extension.mjs` 挂在 agent 进程的事件钩子上（`before_agent_start` / `tool_call` /
`tool_result` / `agent_settled` / `session_shutdown`），把状态写进 `state.jsonl`，
插件主进程转发给 helper。这样 AI 状态与桌宠动画就同步了。

---

## 已知限制

- 仅 Windows x64
- 语音依赖本机 `python` + `edge-tts`；缺了就静默无声（其余功能正常）
- 首次启动要下 580 MB
- 多个 PI-Desktop 窗口共用同一只桌宠（控制口 `7799` 单实例）
- 设置页端口 `7811` 被占用时设置页不可用，可用环境变量 `DAFEIYU_PET_SETTINGS_PORT` 换端口

---

## 授权与致谢

- **插件代码**（本仓库）：MIT
- **桌宠运行时与素材**：来自 [lilulj/dsh-dafeiyu-pet](https://github.com/lilulj/dsh-dafeiyu-pet)
  （代码 MIT，Copyright (c) 2026 QCYTSN），素材转制自
  [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，Copyright (c) 2026 PC2005-cloud）
- 本项目与 DeepSeek / 微软无隶属关系；`edge-tts` 使用的是微软 Edge 公开语音服务

详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
