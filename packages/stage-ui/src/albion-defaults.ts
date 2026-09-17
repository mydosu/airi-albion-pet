/**
 * 阿尔比恩桌宠的本机配置（我们 fork 的定制，2026-09-14）
 *
 * 端点与令牌来自应用根目录的 .env.local（Vite 约定，不进仓库）：
 *   VITE_ALBION_LLM_BASE / VITE_ALBION_LLM_KEY  → Hermes 网关 API Server（她的脑子）
 *   VITE_ALBION_TTS_BASE / VITE_ALBION_TTS_MODEL → Irodori 桥（她的嘴）
 *
 * 这里只放「默认配置」：各 store 把它当自身默认值，用户日后在界面上改过就以界面为准。
 * applyAlbionDefaults() 只负责首次引导标记（那部分是命令式的 localStorage 写入）。
 */

// 兜底即本机服务：不写 .env.local 也能跑（LLM/TTS/STT 都是本地那三个）
// LLM 的 key 是机密（Hermes 网关的 API_SERVER_KEY），只能来自 .env.local 或界面里填
export const ALBION_LLM_BASE = (import.meta.env.VITE_ALBION_LLM_BASE as string | undefined) ?? 'http://127.0.0.1:8650/v1'
export const ALBION_LLM_KEY = (import.meta.env.VITE_ALBION_LLM_KEY as string | undefined) ?? ''
export const ALBION_TTS_BASE = (import.meta.env.VITE_ALBION_TTS_BASE as string | undefined) ?? 'http://127.0.0.1:9881/v1'
export const ALBION_TTS_MODEL = (import.meta.env.VITE_ALBION_TTS_MODEL as string | undefined) ?? 'albion'
/** 耳朵：本机 whisper 服务（whisper_serve.py，OpenAI 兼容 /v1/audio/transcriptions） */
export const ALBION_STT_BASE = (import.meta.env.VITE_ALBION_STT_BASE as string | undefined) ?? 'http://127.0.0.1:9882/v1'
export const ALBION_STT_MODEL = 'paraformer-zh' // 耳朵默认引擎已换中文专用 paraformer（whisper-1 仍被接受，切回 whisper 引擎时改这里）

/** LLM 走 Hermes 网关的 OpenAI 兼容口；模型名就是 profile 名（albion） */
export const ALBION_LLM_PROVIDER_ID = 'openai-compatible'
export const ALBION_LLM_MODEL = 'albion'
/** 嘴走 Irodori 桥；voice/model 就是船名 */
export const ALBION_TTS_PROVIDER_ID = 'openai-compatible-audio-speech'
/** 耳朵走本机 whisper 服务 */
export const ALBION_STT_PROVIDER_ID = 'openai-compatible-audio-transcription'
/** 眼睛走 myduso-1（Tailscale）上的 Qwen3VL-4B；本机 llama.cpp 那份是备用（start_eye.bat） */
export const ALBION_VISION_BASE = (import.meta.env.VITE_ALBION_VISION_BASE as string | undefined) ?? 'http://100.87.140.101:8080/v1'
export const ALBION_VISION_MODEL = 'Qwen3VL-4B'
export const ALBION_VISION_PROVIDER_ID = 'vision-openai-compatible'
/** 默认形象：我们的 Live2D 预设（见 stores/display-models.ts） */
// 默认皮肤 = Spine 3.8 那套（打包版是全新的 localStorage，取的就是这个默认值；
// 原来是 Live2D，导致打包版启动时不是定稿的 Spine 皮肤）。
export const ALBION_STAGE_MODEL_ID = 'preset-spine38-albion'

/** 预置的 provider 配置（AIRI 的「服务来源」表） */
export function albionProviderDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (ALBION_LLM_BASE && ALBION_LLM_KEY) {
    out[ALBION_LLM_PROVIDER_ID] = {
      id: ALBION_LLM_PROVIDER_ID,
      definitionId: ALBION_LLM_PROVIDER_ID,
      config: { apiKey: ALBION_LLM_KEY, baseUrl: ALBION_LLM_BASE },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  if (ALBION_TTS_BASE) {
    out[ALBION_TTS_PROVIDER_ID] = {
      id: ALBION_TTS_PROVIDER_ID,
      definitionId: ALBION_TTS_PROVIDER_ID,
      // model/voice 必须写在这里：AIRI 对 openai 兼容的 TTS 只读 provider 配置
      // （Stage.vue：没有就用默认 tts-1/alloy → 桥 404 → 她不出声）
      config: { apiKey: 'local', baseUrl: ALBION_TTS_BASE, model: ALBION_TTS_MODEL, voice: ALBION_TTS_MODEL },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  if (ALBION_STT_BASE) {
    out[ALBION_STT_PROVIDER_ID] = {
      id: ALBION_STT_PROVIDER_ID,
      definitionId: ALBION_STT_PROVIDER_ID,
      config: { apiKey: 'local', baseUrl: ALBION_STT_BASE },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  if (ALBION_VISION_BASE) {
    out[ALBION_VISION_PROVIDER_ID] = {
      id: ALBION_VISION_PROVIDER_ID,
      // 视觉实例的 id 必须带 `vision-` 前缀（AIRI 用它把 provider 归类到 vision）
      definitionId: 'openai-compatible',
      config: { apiKey: 'local', baseUrl: ALBION_VISION_BASE },
      status: 'configured',
      configuredBy: 'user',
    }
  }
  return out
}

/** 标记为「已添加」的 provider（AIRI 用这张表决定下拉里有什么） */
export function albionAddedProviders(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id of Object.keys(albionProviderDefaults()))
    out[id] = true
  return out
}

/** 首次引导：我们开箱就有可用服务来源，别挡着（这两个键是裸字符串 'true'） */
export function applyAlbionDefaults() {
  for (const key of ['onboarding/completed', 'onboarding/skipped']) {
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, 'true')
  }
}
