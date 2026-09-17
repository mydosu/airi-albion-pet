/**
 * 阿尔比恩的眼睛 —— 两个来源，各自看得清是哪儿：
 *
 *   his  = 指挥官日常用的那台（Tailscale 名 albion）
 *   mine = 阿尔比恩自己所在的那台（Tailscale 名 taihou）—— 屏幕上那个立绘就是她本人
 *
 * 每张图交给本地视觉模型（Qwen3VL-4B）转成一段描述，存成"最近的观察"，
 * 再随系统提示一起交给她（界面里看不到、也不会被念出来）。
 *
 * 参数（界面的本地存储，默认关）：
 *   settings/albion/eyes-enabled        '1' = 开（默认 '0'）
 *   settings/albion/eyes-url            his 的采集端（默认主用电脑的 Tailscale 地址）
 *   settings/albion/eyes-token          his 的 token
 *   settings/albion/eyes-url-local      mine 的采集端（默认本机 Tailscale 地址）
 *   settings/albion/eyes-token-local    mine 的 token
 *   settings/albion/eyes-interval       间隔秒（默认 120，最小 10）
 *   settings/albion/eyes-vlm            视觉模型端点
 *   settings/albion/eyes-model          模型名
 *
 * 想立刻看一眼：控制台 `__albionEyes.look()`（默认看他的）或 `__albionEyes.look('mine')`。
 */

export type EyesSource = 'his' | 'mine' | 'cam'

export interface EyesObservation {
  at: number
  text: string
  screen?: string
  error?: string
}

const DEFAULTS = {
  // 三路端点默认是我们自己那套（都在 Tailscale 里）；换机器用 .env 覆盖
  // VITE_ALBION_EYES_HIS / VITE_ALBION_EYES_MINE / VITE_ALBION_VISION_BASE
  hisUrl: (import.meta.env.VITE_ALBION_EYES_HIS as string | undefined) ?? 'http://100.70.71.117:8790', // 主用电脑
  mineUrl: (import.meta.env.VITE_ALBION_EYES_MINE as string | undefined) ?? 'http://100.98.117.121:8790', // 她屏幕所在那台
  vlm: (import.meta.env.VITE_ALBION_VISION_BASE as string | undefined) ?? 'http://100.87.140.101:8080/v1', // 视觉模型
  model: '/models/Qwen3VL-4B-Instruct-Q4_K_M.gguf',
  interval: 120,
}

/** 观察多新算"还新鲜"（超过就别提了，免得说"我刚看到…"其实早不在了） */
const FRESH_MS = 3 * 60_000

const latest: Record<EyesSource, EyesObservation | null> = { his: null, mine: null, cam: null }

function setting(key: string, dft: string): string {
  try {
    return localStorage.getItem(`settings/albion/${key}`) ?? dft
  }
  catch {
    return dft
  }
}

export function eyesEnabled(): boolean {
  return setting('eyes-enabled', '0') === '1'
}

export function eyesLatest(source: EyesSource = 'his'): EyesObservation | null {
  return latest[source]
}

function fresh(source: EyesSource): EyesObservation | null {
  const o = latest[source]
  return o && !o.error && o.text && Date.now() - o.at <= FRESH_MS ? o : null
}

/** 把时间戳变成"月/日 时:分"（当地时间） */
function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 距今多久（给人看的说法） */
function ago(at: number): string {
  const min = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (min < 1)
    return '刚刚'
  if (min < 60)
    return `${min} 分钟前`
  return `${Math.round(min / 60)} 小时前`
}

/** 给系统提示用的一段话（没有新鲜观察就空串） */
// 常驻状态（不诱导）：只陈述"她自己可以看"这个事实，不要求她看、不指定看哪一路。
// 为什么需要它：以前"没图时"这段补充是空的 ⇒ 她在说话的当下根本收不到"我可以看"这个信号，
// 于是只有被指挥官/壳提示时才会点单（实测 6 次里 5 次是我提示的）。
const SELF_LOOK_LINE = '（我随时可以自己看：在回复里写 [[LOOK:his]] 指挥官那台电脑的屏幕、[[LOOK:mine]] 我自己所在那台、[[LOOK:cam]] 摄像头·真实世界——壳会现取一张交给我。看哪一路、什么时候看都由我定；不看也行。）'

export function eyesDescribeForPrompt(): string {
  const parts: string[] = []
  const his = fresh('his')
  const mine = fresh('mine')
  const cam = fresh('cam')
  if (his)
    parts.push(`· 【来源 1：屏幕截图】指挥官日常那台电脑（${stamp(his.at)} 拍的，${ago(his.at)}）：${his.text}`)
  if (mine)
    parts.push(`· 【来源 2：屏幕截图】阿尔比恩自己所在那台电脑 —— 也就是她屏幕所在的那台（${stamp(mine.at)} 拍的，${ago(mine.at)}）：${mine.text}`)
  if (cam)
    parts.push(`· 【来源 3：摄像头照片·真实世界】这台电脑的摄像头（${stamp(cam.at)} 拍的，${ago(cam.at)}）：${cam.text} —— 这一路是真实世界，不是屏幕。`)
  if (!parts.length)
    return eyesEnabled() ? `【阿尔比恩的眼睛：现在手上没有画面】\n${SELF_LOOK_LINE}` : ''
  return `【阿尔比恩的眼睛·真实拍到的画面（屏幕截图 / 摄像头照片），不是猜的；现在是 ${stamp(Date.now())}】\n${parts.join('\n')}\n${SELF_LOOK_LINE}\n（只有上面写了的东西才算"看到"；没写到的部分不许编，直接说不清楚就好。截图有先后，可以拿来判断时间过去多久。）`
}

/** 摄像头在场检查（本机那台）：true = 画面里有人；false = 空着；undefined = 没看成/不确定 */
let presenceCache: { at: number, value: boolean | undefined } | null = null

export async function eyesPresence(): Promise<boolean | undefined> {
  if (presenceCache && Date.now() - presenceCache.at < 60_000)
    return presenceCache.value
  const { url: rawUrl, token } = sourceConfig('mine')
  const url = rawUrl.replace(/\/$/, '')
  const vlm = setting('eyes-vlm', DEFAULTS.vlm).replace(/\/$/, '')
  const model = setting('eyes-model', DEFAULTS.model)
  let value: boolean | undefined
  try {
    const cam = await fetch(`${url}/cam?t=${encodeURIComponent(token)}`)
    if (!cam.ok)
      throw new Error(`摄像头 ${cam.status}`)
    const dataUrl = await blobToDataUrl(await cam.blob())
    const res = await fetch(`${vlm}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '画面里有没有人在？只回一个字：有 或 无' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 8,
        temperature: 0,
      }),
    })
    if (!res.ok)
      throw new Error(`视觉模型 ${res.status}`)
    const data = await res.json()
    const ans = String(data?.choices?.[0]?.message?.content ?? '')
    value = ans.includes('有') ? true : ans.includes('无') ? false : undefined
  }
  catch (e) {
    console.warn('[albion-eyes] 在场检查没成：', String((e as Error)?.message ?? e).slice(0, 100))
    value = undefined
  }
  presenceCache = { at: Date.now(), value }
  return value
}

const PROMPT = [
  '这是一个人的电脑屏幕截图。请用中文详细描述：',
  '1) 整体在做什么——哪个软件、什么窗口、标题栏写了什么；',
  '2) 屏幕上出现的文字、文件名、按钮、代码或对话内容，能看清的都尽量列出来；',
  '3) 有没有人在操作、光标或输入框在哪、状态栏或时间显示是什么；',
  '4) 尽量具体。只说你真看到的，看不清就说看不清，不要猜。',
  '5) 不要输出敏感信息：密码、密钥、令牌、验证码、身份证号、银行卡号、聊天里的私人隐私内容——',
  '   遇到这类就跳过，只写"这里有一处敏感信息，已跳过"，绝对不要照抄出来。',
].join('')

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读图失败'))
    fr.readAsDataURL(blob)
  })
}

function sourceConfig(source: EyesSource) {
  if (source === 'mine')
    return { url: setting('eyes-url-local', DEFAULTS.mineUrl), token: setting('eyes-token-local', ''), path: '/shot', label: '阿尔比恩自己所在那台（就是她屏幕所在的那台）' }
  if (source === 'cam')
    return { url: setting('eyes-url-local', DEFAULTS.mineUrl), token: setting('eyes-token-local', ''), path: '/cam', label: '这台电脑的摄像头 —— 真实世界的画面' }
  return { url: setting('eyes-url', DEFAULTS.hisUrl), token: setting('eyes-token', ''), path: '/shot', label: '指挥官日常那台电脑的屏幕' }
}

// 摄像头看的是真实世界，问法跟屏幕不一样
const CAM_PROMPT = [
  '这是电脑摄像头拍下的一张真实世界的照片（不是屏幕截图）。用中文说：',
  '1) 画面里有几个人？他们在做什么（看着屏幕/看手机/离开座位/别的）？',
  '2) 他们的状态（在不在忙、神情如何、离得近不近）？',
  '3) 尽量具体。只说你真看到的，看不清就说看不清。',
  '4) 不要输出敏感信息：证件、单据、密码之类，遇到就跳过，只写"这里有一处敏感信息，已跳过"。',
].join('')

async function lookOnce(source: EyesSource): Promise<EyesObservation> {
  const { url: rawUrl, token, path, label } = sourceConfig(source)
  const url = rawUrl.replace(/\/$/, '')
  const vlm = setting('eyes-vlm', DEFAULTS.vlm).replace(/\/$/, '')
  const model = setting('eyes-model', DEFAULTS.model)
  try {
    const shot = await fetch(`${url}${path}?t=${encodeURIComponent(token)}`)
    if (!shot.ok)
      throw new Error(`${label} 采集端 ${shot.status}`)
    const dataUrl = await blobToDataUrl(await shot.blob())
    const health = await fetch(`${url}/health`).then(r => r.json()).catch(() => null)
    const res = await fetch(`${vlm}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: source === 'cam' ? CAM_PROMPT : PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: 500,
        temperature: 0.2,
      }),
    })
    if (!res.ok)
      throw new Error(`视觉模型 ${res.status}`)
    const data = await res.json()
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    latest[source] = { at: Date.now(), text, screen: health?.screen }
  }
  catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 120)
    latest[source] = { at: Date.now(), text: '', error: msg }
    console.warn(`[albion-eyes] ${source} 这次没看成：`, msg)
  }
  return latest[source] as EyesObservation
}

// 视觉模型是单线程的：同一时刻只允许一次，失败隔 3 秒重试一次
const inFlight: Partial<Record<EyesSource, Promise<EyesObservation>>> = {}

export async function eyesLook(source: EyesSource = 'his'): Promise<EyesObservation> {
  if (inFlight[source])
    return inFlight[source] as Promise<EyesObservation>
  inFlight[source] = (async () => {
    let r = await lookOnce(source)
    if (r.error) {
      await new Promise(resolve => setTimeout(resolve, 3000))
      r = await lookOnce(source)
    }
    return r
  })()
  try {
    return await (inFlight[source] as Promise<EyesObservation>)
  }
  finally {
    delete inFlight[source]
  }
}

/**
 * 眼睛改成"她要才看"（2026-09-17）：不再定时盲抓三路。
 * 她自己决定看哪一路、什么时候看——回复里写 <|LOOK:his|> / <|LOOK:mine|> / <|LOOK:cam|>，
 * 壳收到就现取一张 → 视觉模型 → 交回给她。这里只保留启停语义，没有定时器。
 */
export function startAlbionEyes(): void {}

export function stopAlbionEyes(): void {}

;(globalThis as any).__albionEyes = {
  look: (source: EyesSource = 'his') => eyesLook(source),
  latest: (source: EyesSource = 'his') => latest[source],
  all: () => ({ ...latest }),
  describe: () => eyesDescribeForPrompt(),
  presence: () => eyesPresence(),
  enabled: () => eyesEnabled(),
  start: () => startAlbionEyes(),
}
