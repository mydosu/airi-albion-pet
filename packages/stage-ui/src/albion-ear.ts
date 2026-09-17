/**
 * 阿尔比恩的耳朵（fork 定制，2026-09-14）
 *
 * 为什么不用 AIRI 自带的听觉管线：它的 VAD（判断"你在说话"的引擎）用
 * `AutoModel.from_pretrained('onnx-community/silero-vad')` 从 HuggingFace 在线拉模型，
 * 而本机 HF 直连不可靠 → 模型加载不出来 → 说话没有任何反应。所以这里自己接：
 *
 *   麦克风 → 能量端点（RMS 起止）→ MediaRecorder 录这一段 → POST 到本机 whisper(:9882)
 *   → 文本自动发进对话（她说不了话的时候不听自己：AEC + 与上一句回复查重 + 她说话时跳过）
 *
 * 调参都在下面的常量里。开关：localStorage `settings/albion/ear-enabled`（默认 true）。
 * 自测钩子：window.__albionEar = { status, testWithStream(stream) }
 */
import { useChatStore } from './stores/chat'
import { useChatSessionStore } from './stores/chat/session-store'

/** 耳朵服务（whisper_serve.py） */
/** 耳朵地址：默认本机 :9882，可在设置里覆盖（localStorage: settings/albion/ear-url） */
const EAR_URL = localStorage.getItem('settings/albion/ear-url')
  || 'http://127.0.0.1:9882/v1/audio/transcriptions'
const ENABLED_KEY = 'settings/albion/ear-enabled'

// ---- 端点检测参数（照着普通安静房间调过；太灵敏会把键盘声也当说话）----
const START_RMS = 0.015 // 起话阈值（连续 START_FRAMES 帧超过才算开口）
const START_FRAMES = 3 // 3 帧 × 50ms = 150ms
const END_RMS = 0.010 // 落话阈值
const END_SILENCE_MS = 700 // 静这么久算一句说完
const MIN_SPEECH_MS = 350 // 太短的（咳嗽/碰麦）丢掉
const MAX_SPEECH_MS = 15000 // 一句话最长 15 秒，到点强制收尾
const SAMPLE_MS = 50 // 能量采样间隔

interface EarState {
  listening: boolean
  speaking: boolean
  lastText: string
  lastError: string
}

function enabled() {
  const raw = localStorage.getItem(ENABLED_KEY)
  return raw === null ? true : raw === 'true'
}

/** 相似度（字符集合 Jaccard）：拿它跟她刚说过的话比对，防"自己听自己" */
function similar(a: string, b: string) {
  const norm = (s: string) => new Set(s.replace(/[\s，。！？、,.!?]/g, '').split(''))
  const A = norm(a)
  const B = norm(b)
  if (!A.size || !B.size)
    return 0
  let hit = 0
  for (const c of A) {
    if (B.has(c))
      hit++
  }
  return hit / Math.max(A.size, B.size)
}

export function startAlbionEar() {
  const chat = useChatStore()
  const session = useChatSessionStore()
  const state: EarState = { listening: false, speaking: false, lastText: '', lastError: '' }
  /** 自测注入的流不受 `ear-enabled` 开关限制（那个开关只管真麦克风） */
  let testing = false
  let herLastWords = ''
  let herLastSpokeAt = 0

  // 记住她最近说过的话：用来查重（AEC 之外的第二道保险）
  setInterval(() => {
    const msgs = session.messages ?? []
    const last = msgs.filter(m => m.role === 'assistant').slice(-1)[0]
    const text = typeof last?.content === 'string' ? last.content : ''
    if (text && text !== herLastWords) {
      herLastWords = text
      herLastSpokeAt = Date.now()
    }
  }, 1500)

  function muted(): boolean {
    // 她正在说（或刚说完不到 1.2 秒）：这段不听，免得把自己的声音录进去
    return state.speaking || Date.now() - herLastSpokeAt < 1200
  }

  async function transcribe(blob: Blob): Promise<string> {
    const form = new FormData()
    form.append('model', 'whisper-1')
    form.append('file', blob, 'speech.webm')
    const r = await fetch(EAR_URL, { method: 'POST', body: form })
    if (!r.ok)
      throw new Error(`ear HTTP ${r.status}`)
    const data = await r.json() as { text?: string }
    state.lastError = ''
    return (data.text ?? '').trim()
  }

  async function sendHeard(text: string) {
    if (!text || text.length < 2)
      return
    if (similar(text, herLastWords) > 0.7) {
      console.info('[albion-ear] 像是我自己的声音，忽略：', text)
      return
    }
    state.lastText = text
    await session.initialize()
    await chat.send({ sessionId: session.activeSessionId, text })
  }

  /** 把一条音频流接上端点检测；返回一个停止函数 */
  function listenTo(stream: MediaStream): () => void {
    const ac = new AudioContext()
    const src = ac.createMediaStreamSource(stream)
    const analyser = ac.createAnalyser()
    analyser.fftSize = 1024
    src.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)

    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = []
    let speaking = false
    let startAt = 0
    let silenceMs = 0
    let loudFrames = 0

    function rms(): number {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf)
        sum += v * v
      return Math.sqrt(sum / buf.length)
    }

    function stopRecording() {
      if (!recorder) {
        return
      }
      const rec = recorder
      recorder = null
      speaking = false
      state.speaking = false
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' })
        chunks = []
        if (blob.size < 1200) {
          return
        } // 太短，基本是杂音
        transcribe(blob).then(sendHeard).catch((e) => {
          state.lastError = String(e?.message ?? e)
          console.warn('[albion-ear] 转写失败：', e)
        })
      }
      rec.stop()
    }

    const timer = setInterval(() => {
      const level = rms()
      if (!speaking) {
        if (level > START_RMS) {
          loudFrames++
          if (loudFrames >= START_FRAMES && !muted() && (testing || enabled())) {
            speaking = true
            state.speaking = true
            startAt = Date.now()
            silenceMs = 0
            chunks = []
            try {
              recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
              recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
              recorder.start()
              state.listening = true
            }
            catch (e) {
              state.lastError = String((e as Error)?.message ?? e)
              speaking = false
              state.speaking = false
            }
          }
        }
        else {
          loudFrames = 0
        }
        return
      }
      // 已经在录：看什么时候安静下来
      if (level < END_RMS)
        silenceMs += SAMPLE_MS
      else
        silenceMs = 0
      const long = Date.now() - startAt > MAX_SPEECH_MS
      const elapsed = Date.now() - startAt
      if ((silenceMs >= END_SILENCE_MS && elapsed >= MIN_SPEECH_MS) || long)
        stopRecording()
    }, SAMPLE_MS)

    return () => {
      clearInterval(timer)
      stopRecording()
      try {
        src.disconnect()
        void ac.close()
      }
      catch {}
      state.listening = false
    }
  }

  let stopCurrent: (() => void) | undefined

  async function start() {
    if (!enabled()) {
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      stopCurrent = listenTo(stream)
      state.listening = true
      console.info('[albion-ear] 耳朵已打开（本机 whisper :9882）', stream.getAudioTracks()[0]?.label ?? '')
    }
    catch (e) {
      state.lastError = String((e as Error)?.message ?? e)
      console.warn('[albion-ear] 拿不到麦克风：', e)
    }
  }

  // 供 headless 自测：把任意音频流接进来（例如用 TTS 音频造一条流）
  ;(window as unknown as Record<string, unknown>).__albionEar = {
    status: () => ({ ...state, herLastWords: herLastWords.slice(0, 60) }),
    testWithStream: (s: MediaStream) => {
      testing = true
      state.listening = true
      return listenTo(s)
    },
    start,
    stop: () => stopCurrent?.(),
  }

  void start()
}
