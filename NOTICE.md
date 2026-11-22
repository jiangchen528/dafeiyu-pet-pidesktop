# NOTICE

本仓库（PI-Desktop 插件 `local.dafeiyu-pet`）是在他人作品基础上的移植与再封装。
插件本身只包含装配代码；桌宠运行时与美术素材**不随本仓库分发**，
由插件首次启动时从上游 Release 下载到用户本机数据目录。

## 上游项目

| 作品 | 作者 | 许可 | 用途 |
| :--- | :--- | :--- | :--- |
| [lilulj/dsh-dafeiyu-pet](https://github.com/lilulj/dsh-dafeiyu-pet) | QCYTSN | MIT | 桌宠 helper 运行时、通信协议、设置页、动作清单（本项目的改造基础） |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | PC2005-cloud | MIT | 角色美术素材（104 个动作的 WebP 帧序列），由上游转制 |

素材包下载地址（上游 Release）：

```
https://github.com/lilulj/dsh-dafeiyu-pet/releases/download/v1.0.0/dafeiyu-pet-assets-1.0.0.tar.gz
```

可用环境变量 `DAFEIYU_PET_ASSETS_URL` 指向自建镜像。

## 本项目的改动

- 把 Cordis/DSH 的插件装配层改写为 PI-Desktop 插件 API（`pi.agent.registerTool`）
- 新增 `agent-extension.mjs`，通过 `state.jsonl` 把会话状态桥接给 helper
- 语音合成从 npm 包 `msedge-tts` 改为本机 Python `edge-tts`
- 本机播放从 WMP COM 改为 MCI `play ... wait`
- 新增动画倍速（`animSpeed`）、可自定义待命文案（`idleSummary`）
- 素材改为首次运行自动下载，不再随包分发

## 第三方服务

- `edge-tts` 调用微软 Edge 的公开语音合成服务，无需 key；本项目与微软无隶属关系。
- 本项目与 DeepSeek / OpenAI 无隶属关系。

## 授权

插件代码：MIT（见 LICENSE）。
上游代码与素材：各自遵循其 MIT 许可与原始署名要求，转载或再分发时请一并保留本文件。
