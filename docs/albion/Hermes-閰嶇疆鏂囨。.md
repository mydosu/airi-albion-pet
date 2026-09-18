# Hermes 作为主脑 · 配置文档

面向：要把 Hermes 配成桌宠大脑的人。下面的路径与配置项都取自本机现网跑的实例（`albion` profile）。

- Hermes Agent：`v0.21.3`（2026.9.14），安装目录 `%LOCALAPPDATA%\hermes\hermes-agent`
- 大脑 profile：`albion`
- profile 目录：`%LOCALAPPDATA%\hermes\profiles\albion\`（Windows 下即 `C:\Users\<你>\AppData\Local\hermes\profiles\albion\`）

---

## 1. 启动

```bat
:: 启动大脑（OpenAI 兼容网关，默认 :8650）
"%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe" -p albion gateway run
```

`start_all.bat` 的第 4 步就是这条命令（它先探 8650 端口，已在跑就跳过，可重复执行）。

- 任意 Hermes 命令都可以用 `-p <profile>` 指定用哪个 profile
- 查各组件状态：`hermes status`
- 网关的 key 与端口来自 profile 的 `.env` 与 `config.yaml`

## 2. profile 目录里有什么

```
profiles/albion/
├─ config.yaml         主配置（模型 / 语音 / 记忆 / 人格开关）
├─ .env                密钥（API_SERVER_KEY、模型 key 等）——不要提交、不要外发
├─ SOUL.md             人格文本（本项目的权威人格源）
├─ sessions/           会话记录
├─ memories/           记忆（后端为 openviking 时由外部服务持有）
├─ skills/             该 profile 自己的技能
├─ logs/               运行日志
├─ workspace/          工作目录
└─ state.db            SQLite 状态库
```

## 3. config.yaml 关键段（照实测抄）

```yaml
model:
  provider: deepseek
  default: deepseek-flash

providers: # 自定义 OpenAI 兼容端点
  custom:slb-v1-api-fan:
    name: PackyCode
    base_url: https://slb-v1.api.fan/v1
    api_mode: chat_completions
    transport: openai_chat
    model: deepseek-v4-flash
    api_key: <你自己的 key>

display:
  personality: none # 人格不走 display，走 SOUL.md
  language: zh

tts: # 说话：指向本机 TTS 桥
  provider: openai
  openai:
    model: albion
    voice: albion
    base_url: http://127.0.0.1:9881/v1
    api_key: <桥不校验时可留占位>

memory: # 记忆：本机 OpenViking
  provider: openviking
  openviking:
    endpoint: http://127.0.0.1:1933
    account: default
    user: default
    agent: hermes
    recall_limit: '6'
    recall_score_threshold: '0.15'
    recall_max_injected_chars: '4000'

terminal:
  cwd: D:\AI\albion-pet # 命令默认工作目录

approvals:
  mode: 'off' # 桌宠场景不需要逐条批准
plugins:
  enabled: [ponytail, skill-triage]
```

**别把真实 key 抄进文档或仓库**；`.env` 与 `config.yaml` 里的 `api_key` 都要当成机密。

## 4. profile 的 `.env`

放密钥，至少要有网关的：

```
API_SERVER_KEY=<网关鉴权用的 key>
```

壳调用网关时把它放进 `Authorization: Bearer <API_SERVER_KEY>`（见《Hermes 接入文档》）。
换 key 之后两边都要更新（脑的 `.env` + 壳的应用设置）。

## 5. 人格

- `profiles/albion/SOUL.md` 是这个 profile 的人格权威源
- `display.personality: none` —— 表示不使用内置人格模板，人格完全由 `SOUL.md` 定义
- 想让桌宠换性格，改 `SOUL.md` 即可，不用动代码

## 6. 语音闭环（说话与听话）

```
       ┌──────────── 说话 ────────────┐
脑(Hermes :8650) ──tts 段──▶ TTS 桥(:9881) ──▶ Irodori 后端(:9889) ──▶ 音频
       └──────────── 听话 ────────────┘
麦克风 ──▶ 耳朵(STT :9882, paraformer) ──▶ 文本 ──▶ 脑
```

- 桥 `:9881` 是 OpenAI 兼容口，`/v1/models` 会列出可用声线（本项目：`albion`、`taihou`、`shinano`、`brest`、`jinshi`、`denia`）
- 声线由 Irodori 后端 `:9889` 承载（单进程多船，配置改动可热载）
- 耳朵 `:9882` 走 paraformer 中文识别，也支持切 whisper（`ALBION_STT_ENGINE`）

## 7. 排障

| 症状 | 先看 |
|---|---|
| 壳说连不上脑 | `:8650` 在不在听；`hermes -p albion gateway run` 有没有报错 |
| 401 | 壳里的 key 与 profile `.env` 的 `API_SERVER_KEY` 不一致 |
| 说话没声音 | 桥 `:9881` → Irodori `:9889` 链路；`curl :9881/v1/models` 看声线在不在 |
| 听不到我说话 | 耳朵 `:9882` 是否 loaded=True；录音权限 |
| 记忆不生效 | OpenViking `:1933` 是否在跑（运维见 openviking-ops 技能） |
| 一键自检 | 项目根目录 `check_all.py`（`start_all.bat` 末尾会自动跑）：六项全绿即通 |

## 8. 从零复刻一个同样的脑

1. 装好 Hermes（`hermes --version` 能出版本）
2. 建 profile：`albion`（名字随意，本文档统一用 `albion`）
3. 按第 3 节写 `config.yaml`，按第 4 节写 `.env`（填自己的 key）
4. 写 `SOUL.md`（人格）
5. 起依赖：Irodori `:9889`、TTS 桥 `:9881`、耳 `:9882`、OpenViking `:1933`
6. 起脑：`hermes -p albion gateway run`，然后 `curl :8650/v1/models` 应返回 `albion`
7. 壳侧把 Base URL 指向 `http://127.0.0.1:8650/v1`、模型填 `albion`、带上 `X-Hermes-Session-Id`
