# Hermes 作为主脑 · API 接入文档

面向：要接这个脑的前端 / 桌面壳（当前是 AIRI fork 的 `stage-tamagotchi`）。
下文所有字段、状态码、响应形状都是在本机实测得到的，不是设计稿。

---

## 1. 分工

| | 壳（前端） | 脑（Hermes） |
|---|---|---|
| 职责 | 显示、Live2D 动作、语音播放、麦克风 | 会话历史、记忆、人格、工具调用 |
| 上下文 | 本地保留完整消息（给界面翻页用），**不外发历史** | 自己维护会话线程与长期记忆 |
| 网络 | 只连 `127.0.0.1` | 需要外网（模型、检索） |

原则一句话：**壳不出网、不带历史；脑管一切上下文。**

## 2. 端点与鉴权

- Base URL：`http://127.0.0.1:8650/v1`（OpenAI 兼容）
- 鉴权头：`Authorization: Bearer <API_SERVER_KEY>`
  - key 在 profile 的 `.env`：`%LOCALAPPDATA%\hermes\profiles\albion\.env` 里的 `API_SERVER_KEY`
  - **不要把 key 写进前端代码或仓库**；壳从应用设置里读，代码里只放默认端点

鉴权失败的样子（实测）：

```http
HTTP/1.1 401 Unauthorized
{"error": {"message": "Invalid gateway API key (API_SERVER_KEY)", "type": "gateway_auth_error", "code": "gateway_auth_failed"}}
```

## 3. 取模型列表

```
GET /v1/models
```

实测响应（本机只有一个模型）：

```json
{ "object": "list", "data": [{ "id": "albion", "object": "model", "created": 1789541621, "owned_by": "hermes", "root": "albion", "parent": null }] }
```

`model` 字段填 `albion` 即可。

## 4. 对话

```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <API_SERVER_KEY>
X-Hermes-Session-Id: albion-desktop
```

请求体（**只带最新一条 user 消息**，见第 6 节）：

```json
{ "model": "albion", "messages": [{ "role": "user", "content": "早安" }] }
```

流式：加 `"stream": true`，返回标准 SSE，`object` 为 `chat.completion.chunk`，以 `data: [DONE]` 结束。**流式与非流式都支持**（两种都实测通过）。

非流式响应（实测，内容已截断）：

```json
{
  "id": "chatcmpl-7066ad0cd1794ae39331a3f29a986",
  "object": "chat.completion",
  "created": 1789541625,
  "model": "albion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "<|ACT:{\"emotion\":\"happy\",\"motion\":\"login\"}|>\n（看到指挥官来了，悄悄把手里的话放下）指挥官，早安。……"
    }
  }]
}
```

## 5. 响应里的动作标签（壳-脑协议）

回复正文的**最前面**会带一个动作标签，用来驱动 Live2D：

```
<|ACT:{"emotion":"happy","motion":"login"}|>
```

- `emotion`：情绪（如 `happy` / `awkward`）→ 壳用于表情/语气
- `motion`：要播的动作组名（如 `login`，对应模型包 `Motions` 里的组）

壳侧的解析（`packages/stage-ui/src/albion-pet.ts`）：

```ts
const ACT_RE = /<\|ACT\s*(?::\s*)?(\{[\s\S]*?\})\s*\|>/i
```

解析掉标签后，剩余文本才是要显示 / 朗读的内容。**标签缺失是正常的**（不是每次都有），壳应当容错：没有标签就只显示文本。

## 6. 会话与记忆的约定（关键，别搞反）

实测实现（`packages/stage-ui/src/stores/chat.ts`）：

```ts
// 记忆/上下文交给 Hermes：出站只带最新一条用户消息，并用固定会话 id 让它续上自己的会话。
const outboundMessages = messages.filter(message => message.role === 'user').slice(-1)
if (outboundMessages.length && !headers['X-Hermes-Session-Id'])
  headers['X-Hermes-Session-Id'] = 'albion-desktop'
```

- **出站只发最后一条 user 消息**，不要把整段历史回灌——否则会和 Hermes 自己的历史形成双份上下文
- 固定会话 id（`albion-desktop`）让 Hermes 把多轮串成一个会话；换个 id 就是一段新会话
- 人格、长期记忆、设备上下文都在 Hermes 侧（见《Hermes 配置文档》）

## 7. 错误与重试

| 现象 | 含义 | 处置 |
|---|---|---|
| 401 `gateway_auth_failed` | key 不对 / 没带 | 检查 `Authorization` 头；key 取 profile 的 `.env` |
| 400 `Invalid JSON in request body` | 请求体没被正确解析（编码 / 引号） | 保证 UTF-8 JSON；**实测同参数重发即 200**，客户端做一次重试即可 |
| 连接被拒 | 网关没起 | `start_all.bat` 会拉起；或 `hermes -p albion gateway run` |
| 长时间无响应 | 模型端慢 | 建议 30~60s 超时；流式可先渲染首包 |

## 8. 最小示例

```bash
curl -s -X POST http://127.0.0.1:8650/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H 'X-Hermes-Session-Id: albion-desktop' \
  -d '{"model":"albion","messages":[{"role":"user","content":"早安"}]}'
```

```ts
const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'X-Hermes-Session-Id': 'albion-desktop',
  },
  body: JSON.stringify({ model: 'albion', messages: [{ role: 'user', content: text }] }),
})
const { choices } = await res.json()
const raw = choices?.[0]?.message?.content ?? ''
const act = raw.match(/<\|ACT\s*(?::\s*)?(\{[\s\S]*?\})\s*\|>/i)
const spoken = raw.replace(/<\|ACT[\s\S]*?\|>/gi, '').trim()
// act ? JSON.parse(act[1]) : null  → { emotion, motion }
```

## 9. 换一个脑

把 Base URL 换成另一个 Hermes 实例（或任意 OpenAI 兼容服务）即可，协议不变；
若那个实例配了别的 `API_SERVER_KEY`，同步换掉鉴权头。会话 id 建议跟着换，避免串线。
