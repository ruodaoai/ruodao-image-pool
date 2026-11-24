# 生图号池（gpt-image-2.6 / 2 + 原生 GIF）— Ruodao 功能插件

> 英文文档：[README.en.md](./README.en.md)

AI 号池插件：插件内自带**原生号池引擎**（固定版本 chatgpt2api + Python 隔离环境 + 2.6/GIF 补丁），支持 **gpt-image-2.6 / 2 图像模型**与 **2.6 系列原生 GIF 动图**，并暴露 OpenAI 兼容本地 API 接入 Agent。粘贴账号即可入池，自带调用日志、图片库与消耗统计。

- 不需要 Git、不需要手动装 Python 依赖、不需要填写任何 Key：安装流程自己下载源码、打补丁、建虚拟环境、拉服务。
- 账号只在本地使用：密码 / 2FA 密钥只写入本机用户数据目录，日志与接口返回全部脱敏。

## 用户步骤（3 步）

1. **「服务状态」→ 点「安装原生号池」**。插件自动完成：探测 Python 3.10+ → 创建隔离虚拟环境 → 获取固定版本源码（本地 ZIP / 目录优先，否则按镜像下载）→ 应用 gpt-image-2.6 / GIF 补丁 → 安装依赖 → 启动后端 → 健康检查。进度实时显示，关闭界面不中断。
2. **「号池账号」→ 粘贴发货文本 →「导入并登录原生号池」**。每行 `邮箱----密码----2FA密钥`，插件用 OAuth PKCE + 密码 + TOTP 自动登录，把 token 导入后端；密码与 2FA 密钥只落本地，接口只返回脱敏邮箱。登录报 403 时，先在卡片下方「网络代理」填入本机可用代理（如 `http://127.0.0.1:7897`）→「保存代理」→「登录全部账号」重试。
2.1 **清理不可用账号**：账号列表勾选若干行（或点「检测全部账号」）→「批量检测选中」。插件先刷新 Token / 额度，状态正常的直接判定「可用 / 限流」；Token 失效或状态异常的会用保存的密码 + 2FA 强制重登验证，按结果标记「暂时不可用」或「彻底不可用」。检测完成后筛选「彻底不可用」，勾选即可「批量删除选中」；遇到临时网络 / 代理问题请先换节点再测，不要误删。

3. **「设置」→「默认画质」→ 选自动 / 标准 1K / 高清 2K / 超清 4K →「保存默认画质」**（推荐先做这一步）。默认画质对生成图片、CLI、本地 API 与 Agent 调用同时生效；之后到「生成图片」选模型（2.6 / 2）与画幅比例生图即可，单次也可临时改档位。可选 1–4 张参考图走图生图；勾选「输出原生 GIF」可生成 2–16 帧动图（仅 2.6 系列）。每次调用写进台账，「调用日志」「图片库」「消耗统计」可直接查看。

## 原生号池工作原理

插件不是把参考项目整个塞进安装包，而是按固定提交获取源码、在插件进程内托管完整生命周期：

| 环节 | 插件做什么 |
|---|---|
| 源码 | 固定 `chatgpt2api` v1.8.0（提交 `92dd80e`）；优先复用本地 ZIP / 目录，否则按 gh-proxy / codeload / ghfast / ghproxy 镜像顺序下载并校验 ZIP |
| 补丁 | 严格锚点应用 `ruodao-pool-gif-v1`：新增 `gpt-image-2.6` / `-flare` / `-sunburst`，贯通 `output_format` / `frame_count` / `frame_duration_ms`，校验 `GIF87a/GIF89a` 后按 `.gif` 落盘；同时用 `RUODAO_NATIVE_DATA_DIR` 把后端数据目录与源码解耦 |
| Python | 探测本机 3.10+ 解释器，创建独立 venv；pip 默认走阿里云镜像，可配置 |
| 账号 | OAuth PKCE / 密码 / TOTP 2FA 登录 worker；token 导入后端，密码与 2FA 密钥只保存在本地 `native/` 数据目录 |
| 网络 | 登录、刷新额度、生图共用引擎全局代理（`/api/settings`）：支持 `http(s)://` / `socks5://` / `host:port`，账号密码在返回值中脱敏；OpenAI 按 IP 风控，直连出现 403 时必须配置可用代理。工作台「一键检测 / 启动代理」会自动扫描本机代理端口，未启动时拉起已安装的 Jimmm / Clash Verge / v2rayN 等客户端，验证 ChatGPT 可达后自动保存 |
| 服务 | 独立端口（默认 `38650`），随机 Bearer Key 本机生成；启停 / 重启 / 健康检查 / 日志全部由插件管理 |
| 数据 | `native/data` 存后端数据库与配置；插件台账与图片库仍写入插件统一数据目录 |

### 模型与 GIF 边界

| 模型 | 说明 |
|---|---|
| `gpt-image-2.6` | 默认模型，支持原生 GIF |
| `gpt-image-2.6-flare` | flare 风格变体，支持原生 GIF |
| `gpt-image-2.6-sunburst` | sunburst 风格变体，支持原生 GIF |
| `gpt-image-2` | 兼容静态图模型 |
| `codex-gpt-image-2` / `plus-` / `pro-` / `team-` | Codex 账号专用，按后端实际账号动态出现 |

- 模型目录 = 内置完整目录 + 后端 `/v1/models` 动态返回的图像模型；动态项只保留原生引擎白名单内的模型（2.6 系列 / gpt-image-2 / Codex 系列），其余会被引擎拒绝，因此不会出现在下拉框。
- 固定版本引擎不支持 `gpt-image-2.5` 系列，插件已移除；生图前会按引擎白名单校验，旧的 2.5 默认模型自动回落到 `gpt-image-2.6`。
- 画质档位 `auto / 1k / 2k / 4k` 与画幅比例 `1:1 / 16:9 / 9:16 / 3:2 / 2:3 / 4:3 / 3:4`，由原生引擎（`PRESET_SIZES`）换算为实际尺寸；`auto` 交给上游决定，通常约 1024。
- 设置页「默认画质」保存到 `native/preferences.json` 的 `defaultImageTier`，生成图片、CLI、本地 API 与 Agent 调用共用；单次请求显式传 `resolution`（含 `auto`）时以请求为准。
- 高清 2K / 超清 4K 会同时提交 `size` 与 `quality: high`；未选画幅时按提示词中的比例推断，推断不到按 `1:1`。也可显式传 `quality: auto / low / medium / high`。
- 对 ChatGPT 账号模型，`size` / `quality` 是发给上游的生成提示，实际像素仍取决于账号与上游能力；Codex 系列则作为真实工具参数提交。插件会把实际像素写进图片元数据并在图片库展示，方便核对。
- GIF 帧数 `2–16`，每帧时长 `20–2000ms` 且为 `10ms` 整数倍。
- GIF 只支持 2.6 三个模型；不支持参考图与流式输出。
- 请求 GIF 但上游返回静态图时，插件直接报错并阻止保存，避免「假 GIF」。

## 服务与数据

| 位置 | 说明 |
|---|---|
| `http://127.0.0.1:38650/v1` | 原生号池后端（插件托管，Bearer Key 本机生成） |
| `http://127.0.0.1:8100/v1` | 本地 OpenAI 兼容生图 API（Agent 实际调用） |
| `%LOCALAPPDATA%\RuodaoImagePool\native` | 原生引擎：源码、venv、后端数据、日志、Key、安装状态 |
| `%LOCALAPPDATA%\RuodaoImagePool\data` | 插件运行时：账号、图片、台账、API 日志 |
| `data/images/` | 生成的图片与 GIF |
| `data/usage.jsonl` | 每次生图的模型、账号、GIF 参数与耗时台账 |

密钥全部本机生成、只写本地配置，不上传任何服务器。

### 消耗统计口径

「消耗统计」与 `usage` 命令都基于本地台账 `usage.jsonl`，提供：按模型、账号的成功失败数、今日调用量、成功率与平均耗时，以及按模型/按天汇总和失败原因 Top。

ChatGPT 网页端**不返回剩余额度**，所以额度是可观测口径：今日实际调用次数。

## 命令

| 命令 | stdin 输入（JSON） | 输出 |
|---|---|---|
| 环境自检 `doctor` | — | 引擎 / 补丁 / 服务 / 账号 / 本地 API 五项检查 |
| 模型列表 `models` | — | 完整图像模型目录、GIF 边界、档位、默认偏好、安装与运行状态 |
| 默认偏好 `preferences` | `{ action: "get"\|"set", defaultModel?, defaultImageTier? }` | 读取 / 保存默认模型与画质档位（2k / 4k 自动附带 quality=high） |
| 接入 Agent `agent-access` | — | Base URL / Key / 模型 / 各端点 |
| 生成图片 `generate` | `{ prompt, model?, resolution?, quality?, aspect_ratio?, output_format?, frame_count?, frame_duration_ms?, images? }` | 图片路径、实际像素、分辨率 / 画质、GIF 参数、耗时 |
| 消耗统计 `usage` | `{ days? }` | 按模型/账号/按天汇总 |
| 调用日志 `logs` | `{ days?, limit?, offset?, state?, q? }` | 分页日志（模型/账号/耗时/失败原因） |
| 图片库 `images` | `{ action: "list"\|"delete"\|"reveal", file?, limit? }` | 图片列表（含 GIF）/ 删除 / 定位 |
| 安装原生号池 `native-setup` | `{ sourceZip?, sourceDir? }` | 后台任务句柄（进度用 `native-setup-status`） |
| 原生安装进度 `native-setup-status` | — | Python / 源码 / 补丁 / 依赖 / 启动 / 健康检查六步状态与日志 |
| 原生服务 `native-service` | `{ action: "start"\|"stop"\|"restart"\|"status" }` | 运行状态、baseUrl、账号数、源码/补丁版本、本地 API 状态 |
| 原生账号 `native-accounts` | `{ action: "import"\|"login"\|"check"\|"refresh"\|"delete"\|"list", text?, emails?, proxy?, force?, concurrency? }` | 导入解析 / 登录结果 / 批量检测（available / limited / retryable / dead 分类）/ 脱敏账号列表（含可操作错误提示） |
| 全局代理 `native-proxy` | `{ action: "get"\|"set"\|"test"\|"discover"\|"auto", url?, clientId?, waitMs? }` | 读取（脱敏）/ 保存 / 测试；`discover` 扫描本机代理客户端与端口；`auto` 自动发现、按需启动客户端、验证 ChatGPT 可达并保存；`set` 传空字符串清除 |
| 原生状态 `native-status` | — | 运行态、源码/补丁、Python、账号、模型、安装进度、本地 API |

## 高级配置（通常留空）

| 变量 | 说明 | 默认 |
|---|---|---|
| `RUODAO_NATIVE_PORT` | 原生号池端口 | `38650` |
| `RUODAO_IMAGE_API_PORT` | 本地 Agent 生图 API 端口 | `8100` |
| `RUODAO_NATIVE_PYTHON` | 指定 Python 3.10+ 解释器 | 自动探测 |
| `RUODAO_NATIVE_SOURCE_ZIP` | 原生引擎源码 ZIP（离线安装） | 自动下载固定版本 |
| `RUODAO_NATIVE_SOURCE_DIR` | 原生引擎源码目录（开发调试） | — |
| `RUODAO_NATIVE_PIP_INDEX` | 原生引擎 pip 镜像 | 阿里云 |
| `RUODAO_NATIVE_TLS_INSECURE` | 账号登录跳过 TLS 校验（`1` = 跳过） | `0` |
| `RUODAO_NATIVE_HOME` | 原生引擎数据目录 | 插件数据目录 `native/` |

## 常见问题

- **原生号池安装失败**：「服务状态」里展开安装日志查看具体步骤；常见原因是 Python 版本低于 3.10、源码镜像全部不可达或 pip 网络超时。可配置 `RUODAO_NATIVE_PYTHON` 指定解释器、`RUODAO_NATIVE_SOURCE_ZIP` 用离线源码、`RUODAO_NATIVE_PIP_INDEX` 换镜像。
- **原生模型不出现在下拉框**：下拉框内置完整目录（2.6 / 2），无需安装也会显示；后端在线时点「刷新」会合并引擎白名单内的动态图像模型。仍为空时检查 `native-status` 里 `source.ready`。
- **生出来的图还是 1024 左右的小图**：到「设置」把「默认画质」改成高清 2K / 超清 4K 并保存，再重新生图；图片库会显示实际像素，可确认这一次是否真的变大。若仍偏小，说明上游按账号能力压回了默认尺寸，可换 Codex 账号模型再试。
- **GIF 报参数错误**：检查帧数 2–16、每帧时长 20–2000ms 且为 10 的整数倍；GIF 不支持参考图与流式。
- **想知道哪些账号已经彻底废了**：点账号列表的「检测全部账号」（或勾选后「批量检测选中」）。`彻底不可用` 只包含密码/账号失效、2FA 密钥失效、账号被停用这类无法自动恢复的情况；代理 403、网络超时、5xx 会标成 `暂时不可用`，换节点后可以再测一次，不要直接删。检测结果会写入每个账号的「可用性」列，刷新页面后仍保留。
- **登录失败 / 状态「异常」**：先看账号列表的「最近错误」。`authorize_failed_403` 表示 OpenAI 拒绝了当前出口 IP（不是账号密码错误），在国内直连几乎必现：在「号池账号」底部「网络代理」点「一键检测 / 启动代理」，插件会自动找到或启动本机代理并保存，再点「登录全部账号」或单个账号的「重登」。代理测试返回 403 说明节点本身被风控，需要在代理客户端里换节点。报「无法连接代理 127.0.0.1:端口」说明代理客户端没启动或端口不对，同样点「一键检测 / 启动代理」。`refresh_failed_401` 表示 token 已失效，重新登录即可；`mfa_verify_failed_*` 检查 2FA 密钥是否为最新 Base32；`dependencies_missing` 回「服务状态」重新安装。
- **Agent 生图报 `ERR_CONNECTION_REFUSED`**：本地生图 API（:8100）没起来。到「服务状态」点「启动服务」；桌面端在 Agent 首次调用时也会自动拉起。
- **日志/图片库为空**：只记录插件自己发起的调用；直接调用后端不会出现在台账里。

## 本地验证

```bash
node bin/image-pool.mjs native-status
node bin/image-pool.mjs models
node bin/image-pool.mjs preferences <<< '{"action":"get"}'
node bin/image-pool.mjs native-setup <<< '{}'
node bin/image-pool.mjs native-accounts <<< '{"action":"list"}'
node bin/image-pool.mjs agent-access
node --test test/native.test.mjs
node --test test/ledger.test.mjs
```

Windows Git Bash 下传中文 JSON 用 `<<<` 或 UTF-8 文件，不要用 `curl -d '{"prompt":"中文"}'`（会按 GBK 发送导致乱码）。

## 免责声明

原生引擎基于 chatgpt2api（MIT）固定版本二次开发。仅供技术研究与学习，账号风控与合规风险由使用者自担，请遵守目标平台服务条款与当地法律法规。