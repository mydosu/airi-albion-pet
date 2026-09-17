/**
 * 阿尔比恩桌宠的「互动层」（我们 fork 的定制，2026-09-14）
 *
 * 三件小事，纯前端、可单独关掉：
 *   1. 触摸反馈   点她 → 随机播一个 touch 动作，并告诉她「被戳了」，让她有反应
 *   2. 情绪表情   她的回复里带 <|ACT:{"emotion":"happy"}|> → 摆出对应神情（姿态参数），标记不进正文
 *   3. 主动说话   安静 N 分钟后，她自己找个话头开口
 *
 * 开关（localStorage，可随时改）：
 *   settings/albion/touch-enabled        'true'（默认开）
 *   settings/albion/emotion-enabled      'true'（默认开）
 *   settings/albion/proactive-minutes    '8'（0 = 关；默认 8 分钟）
 *
 * 情绪用 AIRI 官方那套标记（constants/emotions.ts 的 9 种），但我们的模型没有
 * Happy/Sad 这类动作组、也没有 exp3 表情文件，所以这里用 motion-control 的
 * 姿态参数（眼/头/身/口）来"演"，效果比硬套不存在的动作组可靠。
 */
import type { Live2DMotionControlPose } from '@proj-airi/stage-ui-live2d/stores'

import { defaultLive2DMotionControlDynamics, neutralLive2DMotionControlPose, useLive2DMotionControl, useLive2dParams } from '@proj-airi/stage-ui-live2d/stores'

import { startAlbionEar } from './albion-ear'
import { startAlbionInteractions } from './albion-interactions'
import { useChatStore } from './stores/chat'
import { useChatSessionStore } from './stores/chat/session-store'

type EmotionName = 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'awkward' | 'question' | 'curious' | 'neutral'

const OWNER = 'albion-pet'
/** 情绪 → 姿态（数值保守，先跑通再照着屏幕微调） */
const POSES: Record<EmotionName, Partial<Live2DMotionControlPose>> = {
  happy: { mouthForm: 1, eyeSquint: 0.5, headY: -2 },
  sad: { mouthForm: -0.8, eyeSquint: -0.35, headY: 5, headX: 3 },
  angry: { mouthForm: -0.5, eyeSquint: -0.8, headZ: 5 },
  think: { eyeY: 0.6, eyeX: -0.3, eyeSquint: 0.2, headZ: -6 },
  surprised: { mouthOpen: 0.9, eyeSquint: -1, headY: -3 },
  awkward: { eyeY: -0.4, eyeSquint: 0.45, headZ: -9, mouthForm: -0.15 }, // 害羞 ≈ awkward
  question: { headZ: 8, eyeSquint: 0.1 },
  curious: { eyeY: -0.2, eyeSquint: 0.3, mouthForm: 0.3, headY: -1 },
  neutral: {},
}
/**
 * 命中用的是**模型自带的官方触摸网格**（`TouchHead` / `TouchBody` / `TouchSpecial` /
 * `TouchDrag*`，手游同款）：判定"是不是摸到她"由网格本身回答，所以**位置与缩放无关、也不用标定**。
 * （2026-09-15 改：此前用归一化矩形 + 人工标定，纯属猜；网格才是正解）
 * 部位：头由 `TouchHead` 网格直接给；其余按网格在整体高度里的相对位置分档，
 * 阈值可调：localStorage['settings/albion/part-split'] = '{"chest":0.30,"butt":0.46,"thigh":0.62,"calf":0.82}'
 */
export interface TouchPart {
  name: string
  label: string
  /** 该部位的语料库（日语，走桥的 TTS；被碰时随机抽一条）——不再往主脑发提示 */
  jp: string[]
  /** 被碰时立刻摆的表情（手游手感：点了马上有反应，不等 LLM） */
  pose: EmotionName
  motion: string
  idles: number[]
}

const PART_HEAD: TouchPart = { name: 'head', label: '头', pose: 'awkward', motion: 'touch_head', idles: [1, 2], jp: [
  '……っ、頭を撫でるんですか……？　えへへ、少し恥ずかしいです……',
  '指揮官の手、あたたかいですね……もう少しだけ、このままで……',
  'ふふっ……髪、乱れてしまいますよ？',
  'あっ……すみません、つい目を閉じてしまいました……',
  'な、撫でられるのは……嫌いじゃ、ないですけど……',
] }
const PART_CHEST: TouchPart = { name: 'chest', label: '胸', pose: 'surprised', motion: 'touch_body', idles: [3, 4], jp: [
  'ひゃっ……！　そ、そこは、だめです……！',
  '指揮官っ……！？　いきなりは、心の準備が……',
  'っ……そんなところ、見ないでください……',
  'も、もう……意地悪な人ですね……',
  'ふぁっ……！？　……びっくりしました……',
] }
const PART_SPECIAL: TouchPart = { name: 'special', label: '后背下方', pose: 'surprised', motion: 'touch_special', idles: [5, 6], jp: [
  'っ……！　いきなり、それは……心臓に悪いです……',
  'ひっ……そこは、あまり触らないでください……',
  '……指揮官、驚かせるのは禁止です……',
  'はぁ……びっくりしました……本当に……',
  'んっ……そこ、敏感なんですけど……',
] }
const PART_WAIST: TouchPart = { name: 'waist', label: '腰/腹', pose: 'awkward', motion: 'touch_drag2', idles: [2, 5], jp: [
  'ひゃうっ……！　腰は、くすぐったいです……！',
  'うぅ……笑ってしまいますから、やめてください……',
  '指揮官、そこは……弱いんです……',
  'ふふっ……もう、子ども扱いしないでください……',
  'あっ……くすぐったいですよ……本当に……',
] }
const PART_THIGH: TouchPart = { name: 'thigh', label: '大腿', pose: 'surprised', motion: 'touch_drag3', idles: [7, 9], jp: [
  '……っ、太ももは、だめです……！',
  '指揮官っ、そこは……！',
  'うぅ……そんなところ、見ないでください……',
  'っ……もう、冗談がすぎますよ……',
  'ひゃっ……あ、あの、手を……離してください……',
] }
const PART_LEG: TouchPart = { name: 'leg', label: '小腿/足', pose: 'question', motion: 'touch_drag4', idles: [10], jp: [
  'ふふっ、くすぐったいですよ……',
  'あっ……足は、やめてください……！',
  'うぅ……そんなに触られると、変な感じです……',
  'ひゃうっ……！　そこ、弱いんです……',
  '……もう、仕方ない人ですね……',
] }

/**
 * 触摸语音：走 Irodori 那条桥（:9881，OpenAI 兼容口，voice=albion）。
 * 首次合成后 URL 留在内存里，同部位再点就是零延迟。
 * 想换端口/音色：localStorage['settings/albion/tts-bridge'] / ['settings/albion/tts-voice']
 */
const VOICE_CACHE = new Map<string, string>()
/** 上一条还没放完的触摸语音（连点时先掐掉，免得两条叠在一起） */
let previousVoice: HTMLAudioElement | undefined

async function voiceUrl(text: string): Promise<string | undefined> {
  const cached = VOICE_CACHE.get(text)
  if (cached)
    return cached
  const base = localStorage.getItem('settings/albion/tts-bridge') || 'http://127.0.0.1:9881'
  const voice = localStorage.getItem('settings/albion/tts-voice') || 'albion'
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice, input: text, response_format: 'mp3' }),
  })
  if (!res.ok)
    throw new Error(`bridge ${res.status}`)
  const url = URL.createObjectURL(await res.blob())
  VOICE_CACHE.set(text, url)
  return url
}

async function speakLine(text: string) {
  try {
    const url = await voiceUrl(text)
    if (!url)
      return
    try {
      previousVoice?.pause()
    }
    catch {}
    const audio = new Audio(url)
    previousVoice = audio
    await audio.play()
  }
  catch (e) {
    console.warn('[albion-pet] 触摸语音失败（桥没起来？）', e)
  }
}

/** 七个部位（兜底/预热/调试口都用这一份） */
const ALL_PARTS = [PART_HEAD, PART_CHEST, PART_WAIST, PART_SPECIAL, PART_THIGH, PART_LEG]

/**
 * 开局把七句台词预合成好：桥每句要 2~5 秒（首句更久），
 * 预热完再点她才是零延迟——不然"点了立刻出声"根本不成立。
 */
async function warmTouchVoices() {
  for (const p of ALL_PARTS) {
    for (const line of p.jp.slice(0, 2)) {
      try {
        await voiceUrl(line)
      }
      catch (e) {
        console.warn('[albion-pet] 触摸语音预热中断（桥没起来？）', e)
      }
    }
  }
  console.info('[albion-pet] 触摸语音已预热', VOICE_CACHE.size, '句')
}

/** 明确的网格 → 部位（其余 TouchDrag* 按高度分档） */
/**
 * 命中分区：**模型坐标系**里的 6 段（y 向下，单位与 `toModelPosition` 一致）。
 *
 * 为什么不用模型自带的官方 Touch* 网格：这套 zip 的网格和美术对不上——量过
 * （见 `_zones.png`）：`TouchHead` 落在右下裙摆、`TouchBody` 落在背景上，
 * 点她脸上反而没有网格。所以按她实际画出来的位置自己划 6 段；
 * 坐标在模型坐标系里 ⇒ **窗口挪动 / 缩放 / 换机器都不受影响**
 * （官方 SDK 也是这么做的，只是数据换成我们自己量的那份）。
 *
 * 微调：localStorage['settings/albion/zones'] =
 *   '{"x0":1250,"x1":2600,"bands":[{"y":2090,"part":"head"},{"y":2450,"part":"chest"}]}'
 */
interface AlbionZones { y0: number, y1: number, x0: number, x1: number, bands: Array<{ y: number, part: string }> }

const ZONES_DEFAULT: AlbionZones = {
  y0: 1820, // 头顶（含头发最高处）以上不响应——否则会点到屋顶/夜空
  y1: 3640, // 脚底以下不响应（地板）
  x0: 1430, // 她身体左缘（含左侧长发）——左边再远就是背景，不响应
  x1: 2740, // 右缘（含飘出去的长发）

  bands: [
    { y: 2090, part: 'head' }, // 头发/脸
    { y: 2450, part: 'chest' }, // 胸
    { y: 2760, part: 'waist' }, // 腰腹
    { y: 2960, part: 'hip' }, // 臀/后腰（彩蛋位）
    { y: 3120, part: 'thigh' }, // 大腿
    { y: 99999, part: 'leg' }, // 小腿/足
  ],
}

const PARTS: Record<string, TouchPart> = {
  head: PART_HEAD,
  chest: PART_CHEST,
  waist: PART_WAIST,
  hip: PART_SPECIAL,
  thigh: PART_THIGH,
  leg: PART_LEG,
}

/** 分区表（可被 localStorage 覆盖，配坏了就回默认） */
function albionZones(): AlbionZones {
  try {
    const raw = localStorage.getItem('settings/albion/zones')
    if (raw) {
      const got = JSON.parse(raw)
      return { ...ZONES_DEFAULT, ...got, bands: got.bands?.length ? got.bands : ZONES_DEFAULT.bands }
    }
  }
  catch { /* 配坏了用默认 */ }
  return ZONES_DEFAULT
}

/**
 * 屏幕坐标 → 部位：把点换算进**模型坐标系**再查分区表。
 * 换算和分区同源 ⇒ 模型挪到哪、放大多少都准；落在她身体之外返回 undefined（点空白没反应）。
 */
function pickPart(clientX: number, clientY: number): TouchPart | undefined {
  const m = (globalThis as unknown as Record<string, any>).__albionModel
  if (!m?.toModelPosition)
    return undefined
  const pt = m.toModelPosition({
    x: clientX,
    y: clientY,
    clone() {
      return { x: this.x, y: this.y }
    },
  })
  const z = albionZones()
  if (pt.x < z.x0 || pt.x > z.x1 || pt.y < z.y0 || pt.y > z.y1)
    return undefined
  for (const b of z.bands) {
    if (pt.y < b.y)
      return PARTS[b.part]
  }
  return PARTS.leg
}

/**
 * 模型自带的 34 组动作（读自 albion.zip 的 aerbien_3.model3.json）。
 * 分组语义是照手游习惯 + 名字推断的，细节见 MOTION-MAP.md。
 */
export const ALBION_MOTIONS: Array<{ group: string, label: string, kind: 'idle' | 'touch' | 'event' | 'voice' }> = [
  // 空闲（已加进模型的 Idle 组，SDK 会自动随机轮播）
  { group: 'idle', label: '空闲·基本', kind: 'idle' },
  { group: 'idle1', label: '空闲·变体1', kind: 'idle' },
  { group: 'idle2', label: '空闲·变体2', kind: 'idle' },
  { group: 'idle3', label: '空闲·变体3', kind: 'idle' },
  { group: 'idle4', label: '空闲·变体4', kind: 'idle' },
  { group: 'idle5', label: '空闲·变体5', kind: 'idle' },
  // 触摸
  { group: 'touch_head', label: '摸头', kind: 'touch' },
  { group: 'touch_body', label: '摸身体', kind: 'touch' },
  { group: 'touch_special', label: '特殊触摸（彩蛋）', kind: 'touch' },
  { group: 'touch_drag1', label: '拖动反应1', kind: 'touch' },
  { group: 'touch_drag2', label: '拖动反应2', kind: 'touch' },
  { group: 'touch_drag3', label: '拖动反应3', kind: 'touch' },
  { group: 'touch_drag4', label: '拖动反应4', kind: 'touch' },
  { group: 'touch_idle1', label: '触摸后空闲1', kind: 'touch' },
  { group: 'touch_idle2', label: '触摸后空闲2', kind: 'touch' },
  { group: 'touch_idle3', label: '触摸后空闲3', kind: 'touch' },
  { group: 'touch_idle4', label: '触摸后空闲4', kind: 'touch' },
  { group: 'touch_idle5', label: '触摸后空闲5', kind: 'touch' },
  { group: 'touch_idle6', label: '触摸后空闲6', kind: 'touch' },
  { group: 'touch_idle7', label: '触摸后空闲7', kind: 'touch' },
  { group: 'touch_idle8', label: '触摸后空闲8', kind: 'touch' },
  { group: 'touch_idle9', label: '触摸后空闲9', kind: 'touch' },
  { group: 'touch_idle10', label: '触摸后空闲10', kind: 'touch' },
  // 事件/剧情
  { group: 'login', label: '登录', kind: 'event' },
  { group: 'home', label: '回港', kind: 'event' },
  { group: 'mail', label: '邮件', kind: 'event' },
  { group: 'mission', label: '任务', kind: 'event' },
  { group: 'mission_complete', label: '任务完成', kind: 'event' },
  { group: 'complete', label: '完成', kind: 'event' },
  { group: 'effect', label: '特效', kind: 'event' },
  { group: 'wedding', label: '誓约', kind: 'event' },
  // 语音伴随动作
  { group: 'main_1', label: '主界面1', kind: 'voice' },
  { group: 'main_2', label: '主界面2', kind: 'voice' },
  { group: 'main_3', label: '主界面3', kind: 'voice' },
]
/**
 * 作者的动作元信息（`renderer/public/albion-motions.json`，由打包脚本从 model0.json 导出）：
 *   { 组: [{ name, loop, next }, …] }
 * `loop` = 作者标的 FileLoop；`next` = 作者的动作链（NextMtn，形如 "Action1:idle1"）。
 * 空闲是「身体(Idle) + 效果层(Idle#1)」两条同时播的（Live2DViewerEX 的「多动作组同时播放」，
 * 高层级的同名参数覆盖低层级）——引擎一次只播一条，所以离线把它们烧成了一条 18s 的待机。
 */
type MotionMeta = Record<string, Array<{ name: string, loop: boolean, next: string, dur?: number, fadeIn?: number, fadeOut?: number, priority?: number, interruptable?: boolean }>>

let MOTION_META: MotionMeta | undefined
/** 一定返回对象：读不到就返回空表（所以返回类型里没有 undefined，调用方不必再判空） */
async function loadMotionMeta(): Promise<MotionMeta> {
  if (MOTION_META)
    return MOTION_META
  try {
    MOTION_META = await (await fetch('/albion-motions.json')).json()
  }
  catch {
    MOTION_META = {}
  }
  MOTION_META ??= {}
  return MOTION_META
}
const ACT_RE = /<\|ACT\s*(?::\s*)?(\{[\s\S]*?\})\s*\|>/i

function flag(key: string, fallback: boolean) {
  const raw = localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}
function minutes(key: string, fallback: number) {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) ? raw : fallback
}

export function startAlbionPetInteractions() {
  const chat = useChatStore()
  const session = useChatSessionStore()
  // 注意：**不能解构** —— setup store 解构出来的是已解包的值，写 .value 等于写给一个普通对象，
  // 动作会"调用成功但画面不动"（2026-09-14 踩过）。必须写 store 上的属性。
  const live2d = useLive2dParams()
  const motionControl = useLive2DMotionControl()

  let poseTimer: ReturnType<typeof setTimeout> | undefined
  let lastTouch = 0
  let lastPlayedGroup = ''
  let lastHandled = ''

  // ---- 2. 情绪表情：她的回复带 <|ACT:{"emotion":"..."}|> ------------------------
  // 作者的动作元信息（NextMtn 动作链要用）—— 开局就拉，别等第一次请求
  void loadMotionMeta()
  // 开局预热触摸语音（不预热的话第一次点她要等好几秒才出声）
  if (flag('settings/albion/touch-voice', true))
    void warmTouchVoices()

  function applyEmotion(name: EmotionName) {
    if (name === 'neutral') {
      motionControl.release(OWNER)
      return
    }
    const pose = { ...neutralLive2DMotionControlPose, ...POSES[name] }
    motionControl.claimExclusiveControl(OWNER)
    motionControl.setPose(OWNER, pose, defaultLive2DMotionControlDynamics)
    clearTimeout(poseTimer)
    poseTimer = setTimeout(() => motionControl.release(OWNER), 5000)
  }

  function handleAssistantMessage(content: string): string | undefined {
    const m = ACT_RE.exec(content)
    const cleaned = m ? content.replace(ACT_RE, '').trim() : undefined
    if (!flag('settings/albion/emotion-enabled', true))
      return cleaned
    let name = ''
    let motion = ''
    if (m) {
      try {
        const payload = JSON.parse(m[1]) as { emotion?: unknown, motion?: unknown }
        const raw = typeof payload.emotion === 'string'
          ? payload.emotion
          : (payload.emotion as { name?: string } | undefined)?.name
        name = String(raw ?? '').trim().toLowerCase()
        // 后端也能直接指定动作组：<|ACT:{"motion":"touch_head"}|>
        if (typeof payload.motion === 'string')
          motion = payload.motion.trim()
      }
      catch {
        // 标记写坏了就按没写处理
      }
    }
    // 只放行"空闲/触摸"类动作。事件/UI 动作（wedding / login / mission_complete /
    // complete / mail …）是游戏里特定界面用的，**带道具（比如那个相框）**，
    // 在桌宠上出现就是乱入——所以哪怕她自己写了标记也不播。
    const safeMotion = ALBION_MOTIONS.some(m => m.group === motion && (m.kind === 'idle' || m.kind === 'touch'))
    if (motion && safeMotion && flag('settings/albion/motion-enabled', true))
      playMotion(motion)
    // 兜底：她偶尔会忘记写标记，就按文字里最明显的情绪演一个
    if (!name || !(name in POSES))
      name = guessEmotion(cleaned ?? content)
    if (name && name !== 'neutral' && name in POSES)
      applyEmotion(name as EmotionName)
    return cleaned
  }

  /** 没写标记时的兜底情绪推断（按关键词，宁少不错） */
  function guessEmotion(text: string): string {
    const t = (text ?? '').replace(/[。，！？、\s]/g, '')
    const rules: Array<[string, RegExp]> = [
      ['awkward', /害羞|不好意思|羞|脸红|躲开|不知道手|被夸/],
      ['happy', /开心|高兴|好开心|太好了|笑着|安心|真好/],
      ['sad', /难过|低落|寂寞|孤单|伤心|担心|不安|没事吧|注意身体|早点休息/],
      ['angry', /生气|不高兴|哼|不许|说好的/],
      ['surprised', /[诶欸咦]|真的吗|没想到|竟然/],
      ['think', /我想|让我想想|大概|应该是|琢磨|考虑/],
      ['curious', /为什么|怎么会|是什么|好奇/],
    ]
    for (const [name, re] of rules) {
      if (re.test(t) && name in POSES)
        return name
    }
    return ''
  }

  // ---- 1. 触摸反馈：点她（按部位分区 + 精确命中） -------------------------------
  /**
   * 作者的 Priority 仲裁（`model0.json` 每条动作都带 `Priority`/`Interruptable`）。
   * 规则：新动作 Priority ≥ 当前在播的 → 放行；更低的，只有当前这条标了 `Interruptable` 才放行。
   * 引擎源码里没有这段（仲裁在闭源 App 里），字段语义按包里的取值对齐：
   *   Idle 2 < Tap 3(可打断) < 触摸/Mune 4 < touch_idle双数/Mune:mune/Mouse 5
   */
  let curPrio = 0
  let curInterruptable = false
  // 这条动作的结束时刻（ms）。到点就回落到待机优先级 —— 不用定时器：
  // Electron 窗口在后台时 setTimeout 会被节流到分钟级，靠它降不下来。
  let curPrioUntil = 0
  function motionPriority(group: string, index = 0) {
    return MOTION_META?.[group]?.[index]?.priority ?? 2
  }
  function effectivePrio() {
    if (curPrioUntil && Date.now() > curPrioUntil) {
      curPrio = motionPriority('Idle', 0)
      curInterruptable = false
      curPrioUntil = 0
    }
    return curPrio
  }
  function arbitrationPass(group: string, index = 0) {
    const p = motionPriority(group, index)
    effectivePrio()
    if (p >= curPrio || curInterruptable)
      return true
    console.info(`[albion-pet] Priority 仲裁：${group}[${index}] 的 ${p} < 在播的 ${curPrio}，且它不可打断 → 忽略`)
    return false
  }
  ;(window as any).__albionArbitration = () => ({ curPrio: effectivePrio(), curInterruptable })
  ;(window as any).__albionPlay = (g: string, i = 0) => playMotion(g, i) // 自检用

  /** 播一个动作组（写进 live2d store；SDK 会按 Meta 里的淡入淡出衔接） */
  function playMotion(group: string, index = 0) {
    // 守卫问模型自己：不用写死的组名表（换模型/换包就不会再"没有这个动作组"）
    const mm = (window as any).__albionModel?.internalModel?.motionManager
    if (mm && !mm.definitions?.[group]) {
      console.warn('[albion-pet] 模型里没有这个动作组:', group)
      return false
    }
    // 作者的"命令/菜单"条目（`Mune:mune`、`Mouse:*`）没有动作文件 → meta 里 dur=0：
    // 它们不播动作，也不该动仲裁记账（否则优先级会卡在高位不降）
    if (!MOTION_META?.[group]?.[index]?.dur) {
      console.info('[albion-pet] 这条不是动作（命令/菜单条目），交给交互层:', group, index)
      return false
    }
    if (!arbitrationPass(group, index))
      return false
    curPrio = motionPriority(group, index)
    curInterruptable = !!MOTION_META?.[group]?.[index]?.interruptable
    curPrioUntil = MOTION_META?.[group]?.[index]?.loop ? 0 : Date.now() + (MOTION_META?.[group]?.[index]?.dur ?? 0) * 1000
    live2d.currentMotion = { group, index }
    lastPlayedGroup = group
    void applyNativeLoops()
    scheduleFollowUp(group, index)
    console.info('[albion-pet] 播动作:', group, index)
    return true
  }

  /**
   * 提前接力（作者 `PreMtn`"提前运行的动作"的思路）：下一条在**这一条结束前**就开始淡入，
   * 交界处才不会"停一下再跳"。作者标了 FileLoop 的（触摸后那个姿势 idle）就把同一条提前重播，
   * 接缝已经收敛到零 + model3 里给了 0.35s 淡入，重播也看不出来。
   * 基础待机（Idle）不在这儿接：它的循环交给引擎自己（0.6s 淡入盖住接缝）。
   */
  let followTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleFollowUp(group: string, index = 0) {
    clearTimeout(followTimer)
    const info = MOTION_META?.[group]?.[index]
    if (!info?.dur || group === 'Idle' || group === 'Idle#1')
      return
    const fade = info.fadeOut || 0.35
    const delay = Math.max(120, (info.dur - fade) * 1000)
    followTimer = setTimeout(() => {
      if (lastPlayedGroup !== group)
        return // 期间被别的动作打断，就不接了
      if (info.next) {
        const [ng, nn] = info.next.split(':')
        const ni = (MOTION_META?.[ng] ?? []).findIndex(m => m.name === nn)
        if (ni >= 0) {
          console.info('[albion-pet] 提前接力:', group, '→', info.next)
          playMotion(ng, ni)
        }
      }
      // 循环由 SDK 原生接管（applyNativeLoops），这里不再重播自己 —— 重播就会"回头"
      // 作者没标循环、也没有 NextMtn 的动作：交给引擎回落待机（不自己做定格）
    }, delay)
  }

  /**
   * 原生循环：pixi 从不让动作自己循环（它从不调用 setIsLoop），所以我们照作者标的 FileLoop
   * 自己打开 `setIsLoop(true)` —— SDK 内部会带 `_isLoopFadeIn` 在循环点淡入，**不会重播、不会回头**。
   * 空闲 2→1 那个"回溯卡顿"就是靠这个解决的（2026-09-16，来源：引擎源码 + pixi 源码）。
   */
  const loopsApplied = new Set<string>() // 按“组:序号”记账，别用一次性闩（pixi 按需创建 motion 对象）
  /**
   * 想在场景里**循环播放**的动作组（淡入淡出循环，不是停在最后一帧）——
   *  默认 `Touch_drag`（相机切场景用的那组）；localStorage['settings/albion/loop-groups']，空串=不额外加
   */
  /**
   * 明确**不要**循环的组：动作链里的"动作后姿势"（Action*:idleN）。
   *  作者标了 FileLoop，但真机上是"触摸完的姿势一直循环"= 看起来像触摸动画在重复（指挥官 2026-09-16）。
   *  改成播完一轮就回基础待机 —— 手游那次触摸就算过去了。localStorage['settings/albion/noloop-groups'] 可调。
   */
  async function applyNativeLoops() {
    const mm = (window as any).__albionModel?.internalModel?.motionManager
    if (!mm?.motionGroups)
      return
    const meta = await loadMotionMeta()
    let n = 0
    for (const [group, arr] of Object.entries(meta)) {
      arr.forEach((info, i) => {
        // 只认作者标的 FileLoop —— 他标了循环的循环，其余一次性（别再自己加规则）
        if (!info.loop)
          return
        const key = `${group}:${i}`
        if (loopsApplied.has(key))
          return
        const m = mm.motionGroups?.[group]?.[i]
        if (typeof m?.setIsLoop !== 'function')
          return
        m.setIsLoop(true)
        m.setIsLoopFadeIn?.(true)
        loopsApplied.add(key)
        n++
      })
    }
    if (n)
      console.info('[albion-pet] 原生循环已打开:', n, '条')
  }
  let warmed = false
  /**
   * 先把"循环名单"里的动作对象建出来（pixi 是按需创建的：第一次播的瞬间它就把时长 4.58s 抓走了，
   * 那时再设 setIsLoop 已经晚了 —— 实测第一次不循环、第二次才循环）。
   * 办法：开机时对每条循环动作 startMotion 一帧再 stopAllMotions，动作对象会留在缓存里，之后再设循环就有效。
   */
  async function warmLoopMotions() {
    if (warmed)
      return
    const mm = (window as any).__albionModel?.internalModel?.motionManager
    if (!mm?.motionGroups)
      return
    const meta = await loadMotionMeta()
    let n = 0
    for (const [group, arr] of Object.entries(meta)) {
      arr.forEach((info, i) => {
        if (!info.loop)
          return
        try {
          // priority 3 = 强制：pixi 对同优先级的 startMotion 会直接拒绝，那样对象就建不出来，
          // 也就永远标不上循环（实测 Action1[1] 一直 false 就是这个原因）
          mm.startMotion(group, i, 3)
          mm.stopAllMotions()
          n++
        }
        catch {}
      })
    }
    warmed = true
    await applyNativeLoops()
    console.info('[albion-pet] 循环动作已预热', n, '条')
  }
  /**
   * 分层动作同时播 —— 作者包里 `Idle`(身体) 与 `Idle#1`(特效) 是两个组，
   * 他的引擎按组名 "name#层号" 同时播放、**高层覆盖同名参数**；pixi 一次只播一个动作。
   * 所以：层 0 交给 pixi 播，层 1 及以上我们自己每帧推进（直接调 SDK 的 CubismMotion.doUpdateParameters，
   * 不做任何曲线改写——文件永远是作者的）。
   */
  const LAYERS = {
    t: 0,
    last: 0,
    base: '',
    groupNames: [] as string[],
    meta: {} as Record<string, any[]>,
  }
  function layerNo(g: string) {
    const n = Number(g.split('#')[1])
    return Number.isFinite(n) ? n : 0
  }
  function num(v: any, d: number) {
    const n = Number(v)
    return Number.isFinite(n) ? n : d
  }

  /**
   * 只干一件事：把"层 1 及以上"的动作组同时播出来（作者的 Idle#1 = 特效层）。
   * 层 0（身体）**不碰** —— 交给 pixi 按作者文件的 FileLoop 循环，循环点用它自带的淡入。
   * 时间就是文件自己的时长（`dur`），没有窗口、没有混合，作者文件一个字节没动。
   */
  function driveLayers() {
    const im = (window as any).__albionModel?.internalModel
    const mm = im?.motionManager
    const core = im?.coreModel
    if (!mm?.state || !core || !LAYERS.groupNames.length)
      return
    const cur = String(mm.state.currentGroup || '')
    const base = cur.split('#')[0]
    const groups = LAYERS.groupNames
      .filter(g => g.startsWith(`${base}#`)) // 只要带 #层号 的，层 0 不管
      .sort((a, b) => layerNo(a) - layerNo(b))
    if (!groups.length || cur !== base)
      return

    const now = performance.now()
    const dt = Math.min(0.25, Math.max(0, (now - (LAYERS.last || now)) / 1000))
    LAYERS.last = now
    if (LAYERS.base !== base) {
      LAYERS.base = base
      LAYERS.t = 0
    }
    LAYERS.t += dt

    for (const g of groups) {
      const info = (LAYERS.meta[g] || [])[0]
      const m = mm.motionGroups?.[g]?.[0]
      if (!info?.loop || !m)
        continue
      const dur = num(info.dur, 0)
      if (!(dur > 0.1))
        continue
      let u = ((LAYERS.t % dur) + dur) % dur
      if (!Number.isFinite(u) || u < 0)
        u = 0
      if (u >= dur)
        u = 0
      try {
        m.doUpdateParameters(core, u, 1, null)
      }
      catch {}
    }
  }

  /** 把 motionManager.update 包一层：pixi 更新完动作之后，再叠上层动作 */
  function hookLayerDriver() {
    const mm = (window as any).__albionModel?.internalModel?.motionManager
    if (!mm || mm.__albionLayered)
      return
    const orig = mm.update.bind(mm)
    mm.update = (model: any, now: number) => {
      const r = orig(model, now)
      try {
        driveLayers()
      }
      catch {}
      return r
    }
    mm.__albionLayered = true
  }

  setInterval(() => {
    void warmLoopMotions().then(() => applyNativeLoops()) // 预热只做一次，补标每次都做
    void loadMotionMeta().then((m) => {
      LAYERS.groupNames = Object.keys(m)
      LAYERS.meta = m as any
    })
    hookLayerDriver()
  }, 2000)

  /** 作者的动作链：这一条播完该接哪一条（NextMtn）。接上就返回 true。 */
  function chainNextMotion(): boolean {
    const mm = (window as any).__albionModel?.internalModel?.motionManager
    const group = String(mm?.state?.currentGroup || lastPlayedGroup || '')
    const index = Number(mm?.state?.currentIndex ?? 0)
    const next = MOTION_META?.[group]?.[index]?.next
    if (!next)
      return false
    const [ng, nn] = next.split(':')
    const ni = (MOTION_META?.[ng] ?? []).findIndex(m => m.name === nn)
    if (ni < 0)
      return false
    console.info('[albion-pet] 动作链:', group, '→', next)
    return playMotion(ng, ni)
  }

  /**
   * 动作串（手游的衔接方式）：一次性触摸动作播完 → 该部位专属的「触摸后空闲」循环 →
   * 下一次交互再换。不接这一棒，SDK 会直接跳回通用 idle，中间就是一次可见的"断"。
   * 数据早在 PART_*.idles 里了，这里只是把它用起来。
   */
  function chainAfterMotion() {
    if (localStorage.getItem('selected-runtime-motion-group'))
      return // 检查器里手选了常驻动作，别抢它
    if (!flag('settings/albion/motion-enabled', true))
      return
    // 刚播完的是哪一条（先问引擎，再退回自己记的）
    // 作者标了 FileLoop 的（如 Action*:idleN = 触摸后把姿势留住）要一直循环。
    // pixi 不一定吃 motion3 里的 Loop，所以自己接：播完重播同一条（接缝已修平，重播看不出来）。
    // （循环不在这儿处理：SDK 原生循环，播不完就不会触发 finish）
    // 动作链照作者来：这一条播完接 `NextMtn` 指定的下一条（触摸→它自己的 idle，从而把姿势留住）。
    // 链上没有下一跳的（相机/场景这类）就交给引擎回落待机。
    chainNextMotion()
  }
  // 挂在 window 上做去重：HMR 重新求值本模块时会再执行一遍这里，不去重就会串两次动作
  if (!(window as any).__albionChainBound) {
    (window as any).__albionChainBound = true
    window.addEventListener('albion:motion-finish', chainAfterMotion)
  }

  /** 按部位戳她：动作 + 该部位专属的小动作 + 对应描述（她的回话与语音跟着变） */
  function poke(part: TouchPart = PART_CHEST, wav?: string, playOwnMotion = true) {
    const now = Date.now()
    if (now - lastTouch < 4000)
      return
    lastTouch = now
    if (flag('settings/albion/touch-enabled', true)) {
      // 新模型（香气来朱阁）的动作组名完全不同：交互层已经按模型包自己的规格播了动作，
      // 这里就不再拿旧模型的组名去点播（否则日志里一条"模型没有这个动作组"）。
      if (playOwnMotion)
        playMotion(part.motion)
      // 只播动作、不再叠「神情姿态」：那 5 秒的头部参数覆盖会把这 6~10 秒的动作压平，
      // 松手那一刻还会弹一下 —— 动作本身已经带着她的反应，这才像录好的视频（2026-09-15）
      if (wav && flag('settings/albion/pack-voice', true))
        void playWav(wav) // 模型包自带的那句官方语音（比如 Tap 的台词）
      else if (flag('settings/albion/touch-voice', true))
        void speakLine(part.jp[Math.floor(Math.random() * part.jp.length)]) // 该部位语料库里随机一条（合成一次就缓存）
      // 不再挂"3.2 秒后的收尾小动作"：那等于往 6~10 秒的触摸动作中间插一刀，
      // 看起来就是"动画切换不协调"。模型里的触摸动作已改成一次性（Loop=false），
      // 播完由 SDK 带 0.5s 淡出回到 Idle 组 —— 手游就是这么做的（2026-09-15）。
    }
    // 不再往主脑发「指挥官戳了戳你」这种提示：触摸只走本地的动作+语音（2026-09-15 指挥官要求）
  }

  /** 播一条模型包自带的官方语音（public/albion-voice/ 下） */
  function playWav(url: string) {
    try {
      const a = new Audio(url)
      a.volume = 1
      void a.play().catch(e => console.warn('[albion-pet] 语音播放失败', url, e))
    }
    catch (e) {
      console.warn('[albion-pet] 语音播放异常', e)
    }
  }

  async function sendPoke(text: string) {
    try {
      await session.initialize()
      await chat.send({ sessionId: session.activeSessionId, text })
    }
    catch (e) {
      console.warn('[albion-pet] 发送失败', e)
    }
  }

  // ---- 3. 主动说话：安静太久了 ------------------------------------------------
  let lastSeenCount = 0
  let lastSpeakAt = Date.now()
  setInterval(() => {
    const everyMin = minutes('settings/albion/proactive-minutes', 8)
    if (everyMin <= 0)
      return
    const msgs = session.messages ?? []
    if (msgs.length !== lastSeenCount) {
      lastSeenCount = msgs.length
      lastSpeakAt = Date.now()
      return
    }
    if (Date.now() - lastSpeakAt < everyMin * 60_000)
      return
    lastSpeakAt = Date.now()
    void sendPoke('（好一会儿没人说话了。用一句自然的话主动和指挥官搭个话，别连着提问。）')
  }, 60_000)

  // ---- 轮询最新回复，处理情绪标记（AIRI 主流程没接这个标记，这里自己接） --------
  setInterval(() => {
    const msgs = session.messages ?? []
    const last = msgs.filter(m => m.role === 'assistant').slice(-1)[0]
    const content = typeof last?.content === 'string' ? last.content : ''
    if (!content || content === lastHandled)
      return
    lastHandled = content
    const cleaned = handleAssistantMessage(content)
    if (cleaned !== undefined && cleaned !== content && last)
      last.content = cleaned
  }, 1200)

  // 触摸/拖动交给交互层（读模型包自带的 HitAreas 与 ParamHit 规格）
  void startAlbionInteractions({
    playWav: (url: string) => playWav(url),
    playMotion: (group: string, index: number) => playMotion(group, index),
    onMotion: (group, index) => scheduleFollowUp(group, index),
    onTap: (partName, wav) => {
      const part = ALL_PARTS.find(p => p.name === partName)
      if (part)
        poke(part, wav, false)
      else if (wav)
        void playWav(wav)
    },
  })
  // 耳朵：默认交给 AIRI 自己的「Model Based」（silero-vad 已拉到本地，见 PLAN §2）。
  // 我们自建那只（自己找端点 + 本机 whisper）留作备用：把
  //   localStorage['settings/albion/ear-enabled'] = 'true'
  // 打开即可顶上（AIRI 的耳朵出问题时用）。
  if (flag('settings/albion/ear-enabled', false))
    startAlbionEar()
  // 方便调试/自测：window.__albionPet.hitTest(clientX, clientY) 返回部位名（undefined = 空白处）
  //   .poke('head') / .play('touch_head') / .emotion('happy') / .zones() 看官方网格
  ;(window as unknown as Record<string, unknown>).__albionPet = {
    poke: (name?: string) => poke(ALL_PARTS.find(p => p.name === name) ?? PART_CHEST),
    emotion: applyEmotion,
    send: sendPoke,
    play: playMotion,
    motions: ALBION_MOTIONS,
    hitTest: (x: number, y: number) => pickPart(x, y)?.name,
    zones: albionZones,
    messages: () => session.messages,
    params: () => (globalThis as any).__albionInteractions,
  }
  console.info('[albion-pet] 互动层已就绪（触摸分区 / 情绪表情 / 动作映射 / 主动说话）')
}
