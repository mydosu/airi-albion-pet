<script setup lang="ts">
import type { IApplicationOptions } from '@pixi/app'
import type { BaseTexture } from '@pixi/core'

import { settings as spineSettings } from '@pixi-spine/base'
import { AtlasAttachmentLoader, SkeletonBinary, SkeletonJson, Spine } from '@pixi-spine/runtime-3.8'
import { Application } from '@pixi/app'
import { ALPHA_MODES } from '@pixi/constants'
import { BatchRenderer, Renderer, Texture } from '@pixi/core'
// 壳用的是模块化 Pixi（@pixi/*），渲染插件必须显式注册，否则：
//   - 没有 TickerPlugin → Application 没有 ticker（实测 hasTicker: false）
//   - 没有 BatchRenderer → Renderer.render() 里 this.batch 是 undefined，直接抛
//     "Cannot read properties of undefined (reading 'start')" → 画布全白
// 整包 pixi.js 在这个仓库里并未安装，所以照 Live2D 那条路的分包写法来。
// 注册必须发生在 new Application 之前。
import { Container } from '@pixi/display'
import { extensions } from '@pixi/extensions'
import { TickerPlugin } from '@pixi/ticker'
import { useLocalStorage } from '@vueuse/core'
import { TextureAtlas } from 'pixi-spine'
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

// 部署的装扮 B：打包态下 props.modelSrc 是 file://，Chromium 拒绝 fetch(file://)，
// 所以这里也以构建期资产引进来兜底（与装扮 A、语音同一套机制）。
import deployedCostumeUrl from '../../../../../stage-ui/src/assets/spine/models/albion-spine-38.zip?url'
import authorSpecA from '../../../assets/author-models/albion-spec-a.json'
import authorSpecB from '../../../assets/author-models/albion-spec-b.json'
// 作者的 change_cos 目标：装扮 A（去除衬衫）。与 B 包并存，切装扮时不碰外部的模型选择器。
import costumeAUrl from '../../../assets/author-models/albion-spine-38-costume-a.zip?url'

import { loadSpineZip } from '../../../utils/spine-zip-loader'
import { AuthorState, parseCommand, selfTest } from './author-engine'

import '@pixi/loaders'
import '@pixi/sprite'
// NOTICE:
// 独立的 Spine 3.8 渲染通道，与 4.x 的 spine/Model.vue 互不影响。
// 4.x 走 @esotericsoftware/spine-webgl 的 AssetManager，3.8 走 pixi-spine
// 加 @pixi-spine/runtime-3.8。两套 API 差异大，共用会互相牵制，所以这里
// 刻意不复用也不修改 4.x 的任何代码。
// 适用场景：碧蓝航线官方 spine 素材（3.8 时代产出，4.x 运行时读不了）。
// zip 解析复用 utils/spine-zip-loader —— 它只按 basename 配对骨架/图集/贴图，
// 不做版本判断，因此两个版本都能用。

const props = withDefaults(defineProps<{
  modelSrc?: string
  modelId?: string
  canvas?: HTMLCanvasElement
  width: number
  height: number
  resolution?: number
  paused?: boolean
  premultipliedAlpha?: boolean
  idleAnimationEnabled?: boolean
}>(), {
  resolution: 1,
  paused: false,
  premultipliedAlpha: true,
  idleAnimationEnabled: true,
})
extensions.add(TickerPlugin)
Renderer.registerPlugin('batch', BatchRenderer)

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

// 独立的视口状态键：settings/spine38/*（不与 4.x 的 settings/spine/* 混用）
const viewX = useLocalStorage('settings/spine38/x', 0)
const viewY = useLocalStorage('settings/spine38/y', 0)
const viewScale = useLocalStorage('settings/spine38/scale', 1)

let app: Application | undefined
let model: Spine | undefined
let holder: Container | undefined

// 作者交互规范（Live2DViewerEX 的 modelN.json）与它的运行时状态。
// 全部交互都由这份数据驱动 —— 加新模型只要换 spec，不用改代码。
// 对应关系以 zip 里的 atlas 首页名为准（比 modelN.json 里的字段名可靠）：
//   装扮 A = albion-spine-38-costume-a.zip（首页 aerbien_4.png）  ↔ 作者 model0.json
//   装扮 B = 已部署的那个包（首页 aerbien_4_2.png）                ↔ 作者 model1.json
// 两套 spec 的 hit_areas / controllers 完全一致，只有 motions 里的
// start / 选项 / shake / 去除衬衫(恢复衬衫) 不同。
const SPEC_A = authorSpecA as unknown as import('./author-engine').AuthorSpec
const SPEC_B = authorSpecB as unknown as import('./author-engine').AuthorSpec
let spec: import('./author-engine').AuthorSpec = SPEC_B
// 作者待机是分层的（`idle` / `idle#1` …，层号=轨道号），姿势要叠在它们之上 ⇒ 姿势轨 = 待机层数。
// 在 syncIdle() 里按实际层数更新，这里先给个安全初值。
let poseTrack = 1

/** 表情停留多久后自动退回（对齐 Live2D 那套 applyEmotion 的 5 秒） */
const EMOTION_HOLD_MS = 5000
let emotionTimer: ReturnType<typeof setTimeout> | undefined
const author = shallowRef<AuthorState>()
const bubble = ref('')
const menu = ref<{ title: string, choices: { text: string, next_mtn: string }[] }>()
let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let playTimer: ReturnType<typeof setTimeout> | undefined
let disposeControllers: (() => void) | undefined
/** 真正加载的包：默认跟随 props.modelSrc，作者的 change_cos 可以临时切到装扮 A。 */
const activeSrc = ref('')
/** 作者 modelN.json 的文件名 → 资源 URL（change_cos 的值就是这些文件名）。 */

const mouthLevelRef = ref(0)
// 嘴型只在"正在播语音"时驱动：待机动画自己会用 zui/zuiB 换嘴形，
// 平时压着 scaleX=0.55 等于让嘴一直缩着（实测静音时恒定 0.55，很明显）。
let voiceActive = false
let mouthNow = 1

// 作者的 `sound` 字段 → 同名 wav。语音是第三方资产，放在 gitignore 的本地目录里，
// 由 vite 作为资源提供（避免 file:// 与 dev server 的跨源限制）。
const voiceUrls = import.meta.glob('../../../assets/author-models/voice/*.wav', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const voiceByBase: Record<string, string> = {}
for (const [p, url] of Object.entries(voiceUrls))
  voiceByBase[p.split('/').pop() ?? p] = url

let audioEl: HTMLAudioElement | undefined
let audioCtx: AudioContext | undefined
let analyser: AnalyserNode | undefined
let lipRaf = 0

/** 播放作者指定的语音；口型强度由 `lip_sync.gain` × 实时音量驱动。需要用户手势解锁（点击即可）。 */
function playVoice(name: string) {
  const url = voiceByBase[name]
  if (!url) {
    console.warn('[spine38] 找不到语音文件（本地资产未放置？）:', name)
    return
  }
  stopVoice()
  audioEl = new Audio(url)
  audioEl.volume = 0.9
  try {
    audioCtx ??= new AudioContext()
    void audioCtx.resume()
    const node = audioCtx.createMediaElementSource(audioEl)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    node.connect(analyser)
    analyser.connect(audioCtx.destination)
    const buf = new Uint8Array(analyser.fftSize)
    const gain = (spec.controllers?.lip_sync as { gain?: number } | undefined)?.gain ?? 1
    const tick = () => {
      if (!analyser)
        return
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) {
        const d = (v - 128) / 128
        sum += d * d
      }
      // 噪声门 + 线性映射：之前直接 ×gain×3 会一路顶到饱和（实测 66% 的帧贴在最大值，
      // 表现就是"嘴一直张着"）。先把底噪（约 -45dB，实测 RMS≈0.02）压成 0，再按 gain 放大。
      const rms = Math.sqrt(sum / buf.length)
      setMouthLevel(rms < 0.02 ? 0 : Math.min(1, (rms - 0.02) * (gain / 5) * 6))
      lipRaf = requestAnimationFrame(tick)
    }
    tick()
  }
  catch (e) {
    console.warn('[spine38] 口型分析不可用（语音照常播放）', e)
  }
  voiceActive = true
  audioEl.onended = () => stopVoice()
  void audioEl.play().catch(e => console.warn('[spine38] 语音播放被拒（需要一次用户点击）', e))
}

function stopVoice() {
  voiceActive = false
  cancelAnimationFrame(lipRaf)
  lipRaf = 0
  analyser = undefined
  setMouthLevel(0)
}
let disposeAssets: (() => void) | undefined
let disposeControls: (() => void) | undefined
let disposeInteractions: (() => void) | undefined
let disposed = false

const skeletonVersion = ref('')

function textureResolver(assets: Awaited<ReturnType<typeof loadSpineZip>>) {
  const byName = new Map<string, string>()
  for (const path of assets.layout.texturePaths)
    byName.set(path.split('/').pop() ?? path, assets.blobUrls[path])
  // 注意：TextureAtlas 是 (name, callback) 形式的异步加载器，
  // 解析下一段 atlas 的 iterateParser() 就在这个回调里 —— 不调用回调，解析会
  // 停在第一个页面（表现为 regions 为空、findRegion 全落空）。
  return (name: string, callback: (texture: BaseTexture) => void) => {
    // 回调要的是 BaseTexture（运行时会读它的 valid/setSize/alphaMode 并按像素设页尺寸），
    // 传 Texture 会因为 setSize 不存在而抛错。
    const baseTexture = Texture.from(byName.get(name.trim()) ?? name.trim()).baseTexture
    // 这份素材是预乘 alpha 导出的（实测半透明像素 RGB 全部 <= A），但 atlas 的页名
    // 没带 pixi-spine 约定的 "-pma" 后缀，所以它默认按直通解释 —— 结果是半透明处
    // 被混成暗色（脸红发黑）。这里按 pixi-spine 本家的做法显式标成预乘。
    baseTexture.alphaMode = ALPHA_MODES.PMA
    callback(baseTexture)
  }
}

const TEXTURE_EXT_RE = /\.(?:png|webp|jpe?g)$/i

/**
 * 只做一件事：在每个新页面头之前补一个空行。
 *
 * pixi-spine 的 atlas 解析状态机里，**空行是唯一的页面分隔符**（空行会把当前页
 * 置为 null，下一行才被当作新页面）；没有空行时，页面一旦建立，后续行一律按区域
 * 解析。Live2DViewerEX 导出的 atlas 在第二个页面头前没有空行，导致第二页的页面名
 * 被当成区域、而第二页的区域全部丢失（表现为 Region not found in atlas）。
 *
 * 注意：不要顺手在"页面属性之后"也补空行 —— 那会把 page 置空，让第一个区域变成
 * 新页面。属性块自身靠 readEntry 遇到无冒号行结束，不缺空行。
 * 只用在本组件，不影响 4.x 那条路径。
 */
function normalizeAtlas(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const atCol0 = line.length > 0 && line[0] !== ' ' && line[0] !== '\t'
    if (atCol0 && TEXTURE_EXT_RE.test(line.trim()) && out.length && out[out.length - 1].trim())
      out.push('')
    out.push(line)
  }
  return out.join('\n')
}

async function setup() {
  const src = activeSrc.value || props.modelSrc || ''
  spec = activeSrc.value === costumeAUrl ? SPEC_A : SPEC_B
  if (!props.canvas || !src)
    return

  componentState.value = 'loading'

  // 打包态是 file:// 协议，Chromium 会拒绝 fetch(file://) —— 这正是"打包版看不到 Spine 模型"的根因。
  // 所以取不到时退回构建期资产 URL（dev 下正常走第一分支，行为不变）。
  let blob: Blob
  try {
    blob = await (await fetch(src)).blob()
  }
  catch (err) {
    if (!deployedCostumeUrl)
      throw err
    console.warn('[spine38] 直接取模型失败，改用构建期资产:', err)
    blob = await (await fetch(deployedCostumeUrl)).blob()
  }
  const file = new File([blob], 'model.zip', { type: 'application/zip' })
  const assets = await loadSpineZip(file)
  if (disposed)
    return

  disposeAssets = assets.dispose

  const atlasText = normalizeAtlas(assets.rawData[assets.layout.atlasPath] as string)
  const atlas = new TextureAtlas(
    atlasText,
    textureResolver(assets),
  )
  const attachmentLoader = new AtlasAttachmentLoader(atlas)
  // 调试出口：骨架读取会抛错，所以 atlas 要在读之前就挂上，方便定位解析问题
  ;(globalThis as unknown as Record<string, unknown>).__albionSpine38Atlas = atlas
  ;(globalThis as unknown as Record<string, unknown>).__albionSpine38AtlasText = atlasText
  const rawSkeleton = assets.rawData[assets.layout.skeletonPath]
  const skeletonData = assets.layout.skeletonFormat === 'binary'
    ? new SkeletonBinary(attachmentLoader).readSkeletonData(rawSkeleton as Uint8Array)
    : new SkeletonJson(attachmentLoader).readSkeletonData(rawSkeleton as string)
  skeletonVersion.value = String((skeletonData as unknown as { version?: string }).version ?? '')

  // ponytail: Pixi v6 的类型没声明 premultipliedAlpha，但运行时会把未知选项透给 renderer。
  // 类型对不上就断言掉；除非实测透明边缘发灰，否则不需要更细的处理。
  // ★ Application 只能创建一次：换装扮（作者的 change_cos）要复用它。
  // 同一进程里新建第二个 WebGL 上下文会失败，表现为
  // "Invalid value of `0` passed to `checkMaxIfStatementsInShader`"，画布直接空掉。
  app ??= new Application({
    view: props.canvas,
    width: Math.max(1, Math.floor(props.width * props.resolution)),
    height: Math.max(1, Math.floor(props.height * props.resolution)),
    backgroundAlpha: 0,
    antialias: true,
    autoStart: !props.paused,
    preserveDrawingBuffer: true,
    autoDensity: false,
    resolution: 1,
    premultipliedAlpha: props.premultipliedAlpha,
  } as unknown as IApplicationOptions)

  // pixi-spine 在 yDown=true 时，TransformMode.NoRotationOrReflection 分支里的 Math.abs(...)
  // 会丢掉行列式符号 → 46 根骨骼的基被重建错（左胸 zuoxiong 等网格最大位移 213px）。
  // 关掉 yDown 后与官方 spine-ts 逐位一致（403 帧 × 264 骨 × 760 顶点，Δ=0，见 logs/official）。
  // 屏幕上下方向改由外层容器翻转承担，model 上的 view 变换数值因此完全不变。
  spineSettings.yDown = false
  model = new Spine(skeletonData)

  // 恢复官方的加载期调用：pixi 把 `region.updateOffset()` 注释掉了
  // （lib/runtime-3.8.js:5540 / 6345），于是所有 RegionAttachment 的 offset 与世界顶点都是 0。
  // 它自己画图不看这些（走 attachment.region + 骨骼矩阵建 Sprite），
  // 但同文件的裁剪器（4891 行 `attachment.computeWorldVertices(slot.bone, ...)`）
  // 和任何包围盒/命中测试都会调用 computeWorldVertices ⇒ 会拿到 8 个 0。
  // 官方就是在加载期算这一次，这里补回来（只填几何，不改渲染路径）。
  for (const skin of (skeletonData.skins ?? []) as unknown[]) {
    const bySlotMap = (skin as { attachments?: Record<string, Record<string, { updateOffset?: () => void }>> }).attachments ?? {}
    for (const bySlot of Object.values(bySlotMap)) {
      for (const att of Object.values(bySlot ?? {})) {
        if (att && typeof att.updateOffset === 'function')
          att.updateOffset()
      }
    }
  }
  holder = new Container()
  holder.scale.y = -1
  holder.addChild(model)
  app.stage.addChild(holder)

  // 首次显示自动取景：模型原生 4523×2487，画布只有约 947×835，不缩会完全超出画面。
  // 按高度铺满（允许横向超屏）—— 与 Live2D 那边"尽量放大"的取景偏好一致。
  // 用户通过 settings/spine38/* 调过之后就不再自动覆盖。
  const untouched = viewScale.value === 1 && viewX.value === 0 && viewY.value === 0
  const bounds = model.getBounds()
  if (untouched && bounds.height > 0) {
    const target = app.screen.height / bounds.height
    viewScale.value = Number(target.toFixed(3))
    viewX.value = Math.round(app.screen.width / 2 - (bounds.x + bounds.width / 2) * target)
    viewY.value = Math.round(app.screen.height / 2 - (bounds.y + bounds.height / 2) * target)
  }
  model.scale.set(viewScale.value)
  holder.position.set(viewX.value, viewY.value)
  model.autoUpdate = true
  // 与 Live2D 侧 __albionModel 同样的调试出口：CDP 里可直接读骨架/动作列表做客观验证
  ;(globalThis as unknown as Record<string, unknown>).__albionSpine38 = model
  ;(globalThis as unknown as Record<string, unknown>).__albionSpine38App = app
  // 与上面两个同样的调试出口：CDP 里可直接驱动作者交互做客观验收
  ;(globalThis as unknown as Record<string, unknown>).__albionAuthor = {
    play: (ref: string) => playMotionRef(ref),
    choose: (i: number) => choose(i),
    slotOpacity: (name: string, v: number) => setSlotGroupOpacity(name, v),
    mouth: (v: number) => setMouthLevel(v),
    voice: (n: string) => playVoice(n),
    state: () => author.value,
  }

  // 待机交给作者的 idle 组：normal(=idle0) 与 '1'..'11' 由 `表情` 变量切换。
  // 回退顺序：作者的 idle 组 → 名字像待机的 → 时长最长的（0 秒的都是姿势，不能当循环）。
  author.value = new AuthorState(spec)
  if (import.meta.env.DEV) {
    const errs = selfTest()
    if (errs.length)
      console.error('[spine38] author-engine 自检失败', errs)
  }
  if (props.idleAnimationEnabled)
    syncIdle()

  installViewControls()
  installAuthorInteractions()
  installControllers()
  applyStartLocks() // 作者的"锁"（如 model1 的去除衬衫）在加载时就要生效
  snapshotExpressionSlots() // 记住"没有表情"时脸/眼槽的样子，供表情结束后恢复
  componentState.value = 'mounted'
}

/**
 * 复现作者的交互（model0.json 的 hit_areas）：
 *   头   faF-6      → 姿势 '2' + 台词（tap摸头）
 *   胸   xiongL_x   → 姿势 '9' + 台词（tap特殊触摸）
 *   左脚 zuotuiik3  → 选项菜单（暂未做菜单 UI）
 *   身体 Y9         → 姿势 '5' + 台词（tap触摸）
 * 作者的一个"动作"= 播放一个 0 秒动画（姿势），按住不放，到时回 normal 待机。
 */
// 3.8 运行时的骨骼在运行时带 worldX/worldY（探针实测可读），但 @pixi-spine/base 的
// IBone 类型只声明了子集，这里补一个本地类型来读。
interface BoneLike {
  data: { name: string }
  worldX: number
  worldY: number
}

/**
 * 作者的 controllers（modelN.json 的 controllers 字段）。
 *
 * 实现口径（每条都按作者给的参数，不是自己编的）：
 *   eye_blink      {min_interval, max_interval}  在区间内随机眨眼
 *   mouse_tracking {smooth_time}                 头部平滑跟随指针
 *   auto_breath    {}                            胸口小幅正弦（叠加在待机动画之上）
 *   lip_sync       {gain}                        口型强度接口（由音频侧调用 setMouthLevel）
 *   slot_opacity   {items:[{name, ids, value}]}  按作者的"背景/柜子"分组调 slot.color.a
 *   accelerometer / intimacy_system              作者的看图器内建，数据里没有可执行字段
 *   key_trigger    {items:[{input, down_mtn}]}   已由 installAuthorInteractions 处理
 *
 * 骨骼 mod 的时机：动画每帧会把骨骼写回去，所以只能在动画 apply 之后叠加，
 * 再补一次 updateWorldTransform 让世界矩阵跟上（多一次遍历，代价可接受）。
 */
function installControllers() {
  const spine = model
  if (!spine || !spine.skeleton)
    return

  const controllers = (spec.controllers ?? {}) as Record<string, unknown>
  const skeleton = spine.skeleton
  const bones = skeleton.bones as unknown as BoneLike[]
  const boneOf = (n: string) => bones.find(b => b.data.name === n) as unknown as {
    scaleY: number
    rotation: number
    y: number
  } | undefined

  const disposers: (() => void)[] = []

  // ---- eye_blink ----
  // 眨眼**不做**：作者的待机动画 `normal` 自己就在眨眼 ——
  // 眼睛槽（youyan-3..9 / zuoyan-2..8）在 normal 里有 DeformTimeline，
  // 关键帧成簇出现（实测 1.23~1.8s、4.33~4.8s …，约每 3 秒一次），那就是作者的眨眼。
  // 每个眼槽在皮肤里只有 1 个附件、没有闭眼变体，所以作者也不可能靠换附件眨眼 ——
  // 我们额外再缩眼骨，只会和它撞在一起（用户实测：脸部每隔 ~5 秒抽一下）。

  // ---- mouse_tracking ----
  // 注意：作者的 smooth_time=0.15s 是给**眼球**的。直接把它用在头骨上，
  // 表现就是鼠标一动/一点，头就"突"一下（实测 5°/150ms，肉眼就是"突然闪一下"）。
  // 头部单独用慢时间常数 + 更小幅度，转起来才像人。
  const HEAD_SMOOTH_T_FALLBACK = 0.15
  // 幅度：作者的数据里**只有 smooth_time**，没有幅度字段 ⇒ 幅度是缺口，不是偏离作者。
  const HEAD_MAX_DEG = 3
  const mtCfg = controllers.mouse_tracking as { smooth_time?: number } | undefined
  let targetRot = 0
  let curRot = 0
  // 头骨是 lian（i=81，父 bozi）。实测 lian.rotation +5° → 眼部中点 Δ(-2.36,-5.86) 屏幕像素，
  // 近似线性（约 -1.7px/deg）；±5° 是"轻微跟随"，超过 10° 就不像待机了。
  // 眼骨 youyan-6/zuoyan-6 有 translate 可叠 ±2.5/±3，但先只用头骨，够用。
  const trackBone = boneOf('lian') ?? boneOf('bozi2') ?? boneOf('bozi')
  if (mtCfg && trackBone && props.canvas) {
    const canvas = props.canvas
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      targetRot = Math.max(-1, Math.min(1, nx)) * HEAD_MAX_DEG
    }
    window.addEventListener('pointermove', onMove)
    disposers.push(() => window.removeEventListener('pointermove', onMove))
  }

  // ---- lip_sync 接口 ----
  // 嘴骨 zui（i=106，父 lian，len=0）。世界朝向 76.22° → **张嘴用局部 X**：
  // zui.scaleX 0.4/1.0/1.4/1.8/2.2 → 嘴高 4.8/14.0/20.9/28.0/35.1 px（实测）。
  // 旋转对 len=0 的骨没有视觉作用，别用 rotation。
  const zui = boneOf('zui') as unknown as { scaleX: number } | undefined

  // ---- auto_breath ----
  // **不做**：作者的待机动画 `normal` 本来就在呼吸 —— xiongR_y/xiongL_y 在 normal 里
  // 同时有 Rotate / Translate / Scale 轨道（胸网格权重也主要落在它们上面）。
  // 我们再叠正弦就是同一种动作做两遍，画面会多出一层肉眼可见的额外起伏。

  const hasTrack = !!trackBone && !!mtCfg
  const hasLip = !!zui

  if (hasTrack || hasLip) {
    // 用作者 data 里的 smooth_time（0.15s）；没有才退回常量。
    const smoothT = (mtCfg?.smooth_time ?? HEAD_SMOOTH_T_FALLBACK) > 0.01 ? (mtCfg?.smooth_time ?? HEAD_SMOOTH_T_FALLBACK) : HEAD_SMOOTH_T_FALLBACK

    // 叠加 mod 必须"先撤上一帧的增量、再写新的"：
    // 动画里没有该骨轨道时（bozi2 跟随时就会遇到），+= 会一帧一帧累积到几百上千度。
    // 叠加方式**不能靠"这根骨有没有动画"来猜** —— 两种猜法都实测翻过车：
    //   · 一律 `+=`：动画不覆写它时（lian 就是有时不写）会一帧帧累积 → 头越转越偏 = 抽搐；
    //   · 一律 delta-restore：动画覆写它时只剩每帧增量（≈0）→ 跟随几乎不动。
    // 改成每帧自检：先看骨上的值是不是我上一帧写下的 —— 是 ⇒ 动画没覆写，撑掉旧值再写；
    // 不是 ⇒ 动画刚把基准写回来了，直接加。
    // 必须同时记住"我上帧写的值"和"动画给的基准值"：
    // 动画这一帧没写它时，骨上留着的是我上帧写的结果（= 上帧基准 + 上帧增量），
    // 只拿它去减上帧增量、而不知道基准，就会把"值本身"当成结果写回去 ——
    // 头会在 "-42°" 和 "+3°" 之间来回跳，正是用户看到的"持续抽搐"。
    interface ModState { written?: number, base?: number }
    const modState = new Map<object, { rot: ModState, y: ModState }>()
    const applyDelta = (b: object, prop: 'rot' | 'y', value: number) => {
      const key = prop === 'rot' ? 'rotation' : 'y'
      const rec = modState.get(b) ?? { rot: {}, y: {} }
      const st = rec[prop]
      const cur = (b as Record<string, number>)[key]
      const animWroteIt = st.written === undefined || Math.abs(cur - st.written) > 1e-6
      const base = animWroteIt ? cur : (st.base ?? cur)
      const next = base + value
      ;(b as Record<string, number>)[key] = next
      st.base = base
      st.written = next
      modState.set(b, rec)
    }

    const origUpdate = (spine as unknown as { update: (dt: number) => void }).update.bind(spine)
    ;(spine as unknown as { update: (dt: number) => void }).update = (dt: number) => {
      origUpdate(dt)
      let touched = false
      if (hasTrack && trackBone) {
        const k = Math.min(1, (dt || 0.016) / smoothT)
        curRot += (targetRot - curRot) * k
        applyDelta(trackBone, 'rot', curRot)
        touched = true
      }
      if (hasLip && zui) {
        // 姿势播放中（轨道 1 有动画）不驱动嘴：
        // 作者的姿势动画是用**整张脸图**表达表情的（此时嘴槽是空的），
        // 再缩 zui 骨会把脸图拉变形 —— 实测脸图在时缩嘴骨仍有 44.5 万像素变化，
        // 表现就是"脸红时脸部突然闪一下"。
        const posing = !!model?.state.getCurrent(poseTrack)?.animation
        // 闭嘴 scaleX=0.55（嘴高约 6px），满幅 2.2（约 35px）；一阶平滑 τ=0.12s
        const want = (voiceActive && !posing) ? 0.55 + 1.65 * Math.min(1, Math.max(0, mouthLevelRef.value)) : 1
        mouthNow += (want - mouthNow) * Math.min(1, (dt || 0.016) / 0.12)
        zui.scaleX = mouthNow
        touched = true
      }
      if (touched)
        skeleton.updateWorldTransform()
    }
    disposers.push(() => {
      ;(spine as unknown as { update: (dt: number) => void }).update = origUpdate
    })
  }

  disposeControllers = () => {
    for (const d of disposers)
      d()
  }
}

/** 把作者的 slot_opacities 套到一组槽上（改 slot.color.a；对 Mesh 与 SpineSprite 都实测有效）。 */
function applySlotOpacity(ids: string[], value: number) {
  const spine = model
  if (!spine)
    return
  const v = Math.min(1, Math.max(0, value))
  for (const id of ids) {
    const slot = spine.skeleton.slots.find(s => String(s.data.name) === id)
    if (slot)
      slot.color.a = v
  }
}

/**
 * 加载时套用作者在 `start` 里下的锁。
 * "去除衬衫"的真实实现就是这个：model1.json 的 start 带
 *   slot_opacities lock youxiuzi-4,youxiuzi-3,youxiuzi-1,youxiuzi-2 0
 *   slot_opacities lock chenshan-4,chenshan-3,chenshan-2,chenshan-1 0
 * 把衬衫与右袖锁成透明。它不在 UI 里点得到，只在"登录"动作里执行 —— 我们自动播 start
 * 会带出 26 秒语音，所以直接把锁应用掉（post_command 不解锁，等于常驻）。
 */
function applyStartLocks() {
  for (const entry of spec.motions?.start ?? []) {
    for (const op of parseCommand(entry.command).slotOpacity)
      applySlotOpacity(op.ids, op.value)
  }
}

/** lip_sync：由音频侧按当前音量调用（0..1）。 */
function setMouthLevel(level: number) {
  mouthLevelRef.value = Math.min(1, Math.max(0, level))
}

/** slot_opacity：按作者的 items 分组调 slot.color.a（对 Mesh 与 Sprite 都有效，已实测）。 */
function setSlotGroupOpacity(groupName: string, value: number) {
  const groups = (spec.controllers?.slot_opacity as { items?: { name: string, ids: string[], value: number }[] } | undefined)?.items
  const g = groups?.find(x => x.name === groupName)
  if (!g || !model)
    return
  const v = Math.min(1, Math.max(0, value))
  for (const id of g.ids) {
    const slot = model.skeleton.slots.find(s => String(s.data.name) === id)
    if (slot)
      slot.color.a = v
  }
  g.value = v
}

function installAuthorInteractions() {
  const canvas = props.canvas
  const spine = model
  if (!canvas || !spine || !spine.skeleton)
    return

  let downAt: { x: number, y: number } | null = null

  const worldToScreen = (wx: number, wy: number) => {
    // 模型局部坐标 → 画布坐标（视图变换在 holder 上，屏幕 y 由它翻转）
    return {
      x: (holder?.position.x ?? 0) + wx * spine.scale.x,
      y: (holder?.position.y ?? 0) - wy * spine.scale.y,
    }
  }

  const hitAt = (px: number, py: number) => {
    const bones = spine.skeleton.bones as unknown as BoneLike[]
    // 基准只能用【模型实际绘制高度】：骨骼包围盒里混着背景（房间/窗帘）的骨头，
    // 拿它当基准会把系数放大几倍，结果所有点击都被最大的"身体"框吃掉。
    // 作者的"身体"框高 17.0 正好罩住人物 → k = 模型高度 / 17。
    const k = (spine.height || 900) / 17
    for (const area of author.value?.spec.hit_areas ?? []) {
      const bone = bones.find(b => b.data.name === area.id)
      if (!bone)
        continue
      const cx = area.center_x ?? 0
      const cy = area.center_y ?? 0
      const c = worldToScreen(bone.worldX + cx * k, bone.worldY + cy * k)
      const halfW = (area.width * k * spine.scale.x) / 2
      const halfH = (area.height * k * spine.scale.y) / 2
      if (px >= c.x - halfW && px <= c.x + halfW && py >= c.y - halfH && py <= c.y + halfH)
        return area
    }
    return null
  }

  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY }
  }
  const onUp = (e: PointerEvent) => {
    if (!downAt)
      return
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
    downAt = null
    if (moved > 5) // 拖动过就不算点击
      return
    const rect = canvas.getBoundingClientRect()
    const px = (e.clientX - rect.left) * (props.resolution ?? 1)
    const py = (e.clientY - rect.top) * (props.resolution ?? 1)
    const hit = hitAt(px, py)
    if (hit)
      playMotionRef(hit.motion)
  }

  // 作者的 key_trigger：input 88 = 键盘 X（作者默认快捷键）→ 打开选项菜单
  // 作者的 key_trigger 只给数字键码（input 88 = X）。浏览器里 KeyboardEvent 构造器
  // 会忽略 keyCode，所以再用 key 反推一次码值，两边都能命中。
  const kt = spec.controllers?.key_trigger as { items?: { input: number, down_mtn: string }[], enabled?: boolean } | undefined
  const keyItems = (kt?.enabled === false ? [] : kt?.items) ?? []
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat)
      return
    const code = e.keyCode || (e.key ? e.key.toUpperCase().charCodeAt(0) : 0)
    for (const it of keyItems) {
      if (code === it.input)
        playMotionRef(it.down_mtn)
    }
  }

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  window.addEventListener('keydown', onKey)
  disposeInteractions = () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKey)
  }
}

/**
 * 表情槽：表情动画（作者的动 '1'..'11'）是"整张脸替换成一张静态表情图"——
 * 它会换掉脸槽 `1` / `1-2` 与全部眼球槽 `youyan-*` / `zuoyan-*`，并把眼球槽置空。
 * 而 spine 在 `clearTrack` 之后**不会**把附件还回来（待机 `normal` 里没有这些槽的
 * AttachmentTimeline），所以不自己恢复的话，一次触摸之后脸就永远定格在那个表情上
 * （用户实测："脸红之后一直静止了"）。作者的本意是表情只持续 motion_duration。
 */
const EXPR_SLOT_RE = /^(?:1|1-2|(?:you|zuo)yan-\d)$/
let exprSnapshot: Map<number, unknown> | undefined

function snapshotExpressionSlots() {
  const spine = model
  if (!spine)
    return
  const m = new Map<number, unknown>()
  spine.skeleton.slots.forEach((slot, i) => {
    if (EXPR_SLOT_RE.test(String(slot.data.name)))
      m.set(i, slot.getAttachment())
  })
  exprSnapshot = m
}

function restoreExpressionSlots() {
  const spine = model
  if (!spine || !exprSnapshot)
    return
  for (const [i, att] of exprSnapshot) {
    const slot = spine.skeleton.slots[i]
    if (slot)
      slot.setAttachment(att as never)
  }
}

/**
 * 待机轨（作者的 idle 是分层的）：`idle` 上 0 轨、`idle#1` 上 1 轨 …… 层号就是轨道号。
 * 本模型第 0 层是脸（跟 `表情` 变量切 normal / '1'..'11'），第 1 层恒为 normal（身体）。
 * 姿势要叠在所有待机层之上，所以姿势轨 = 待机层数。
 */
function syncIdle() {
  const spine = model
  if (!spine)
    return
  const names = spine.spineData.animations.map(a => a.name)
  const layers = (author.value?.idleLayers() ?? []).filter(n => names.includes(n))
  if (layers.length) {
    poseTrack = layers.length
    layers.forEach((anim, i) => {
      if (spine.state.getCurrent(i)?.animation?.name !== anim)
        spine.state.setAnimation(i, anim, true)
    })
    return
  }
  // 数据里没有 idle 组时的兜底
  const anim = names.find(n => /idle|normal|待机/i.test(n))
    ?? [...spine.spineData.animations].sort((a, b) => b.duration - a.duration)[0]?.name
  poseTrack = 1
  if (anim && spine.state.getCurrent(0)?.animation?.name !== anim)
    spine.state.setAnimation(0, anim, true)
}

/**
 * 播放一个作者定义的引用（"组:条目"）。
 * 严格按作者字段执行：file→动画、sound→音频、text→气泡、command/post_command→开关组、
 * motion_duration→保持时长、choices→菜单、var_floats→变量条件与赋值。
 */
function playMotionRef(ref: string) {
  const st = author.value
  if (!st || !model)
    return
  const eff = st.play(ref)
  if (!eff) {
    console.warn('[spine38] 未执行的引用（作者数据里存在但本实现未覆盖）:', ref)
    return
  }
  applyEffect(eff)
}

function applyEffect(eff: NonNullable<ReturnType<AuthorState['play']>>) {
  const spine = model
  if (!spine)
    return

  // ① 动画：作者的 file 多为 0 秒姿势，叠在 1 轨（0 轨留给待机）
  if (eff.animation && spine.spineData.animations.some(a => a.name === eff.animation)) {
    const entry = spine.state.setAnimation(poseTrack, eff.animation, false)
    if (entry)
      entry.mixDuration = 0 // 作者 fade_in/fade_out 都是 0
  }

  // ② 台词气泡
  if (eff.text) {
    bubble.value = eff.text
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      bubble.value = ''
    }, eff.textMs)
  }

  // ③ 语音（作者 motion 的 sound 字段 → 同名 wav）
  if (eff.sound)
    playVoice(eff.sound)

  // ③b 作者的 slot_opacities 锁（脱/穿衣服的实际手段）
  for (const op of eff.command.slotOpacity)
    applySlotOpacity(op.ids, op.value)

  // ④ 菜单（作者的 choices）
  menu.value = eff.choices ? { title: eff.text ?? '', choices: eff.choices } : undefined

  // ④b 作者的 change_cos：两套装扮的 modelN.json 互相指向对方
  //     （model0 的 去除衬衫 → model1.json；model1 的 恢复衬衫 → model0.json）
  //     所以语义就是"切到另一套"，不必依赖哪份文件叫什么名。
  const cos = eff.command.changeCos
  if (cos) {
    const target = activeSrc.value === costumeAUrl ? (props.modelSrc ?? '') : costumeAUrl
    if (target && activeSrc.value !== target) {
      activeSrc.value = target
      teardownModel()
      void setup()
      return
    }
    if (!target)
      console.warn('[spine38] change_cos 目标没有对应的资源:', cos)
  }

  // ⑤ 立即同步待机轨：作者的 `切换表情` 只做 assign（没有动画、没有时长），
  //    必须当场把 0 轨换成 idleN，否则要等下一次播放才切。syncIdle 是幂等的：
  //    想要的待机与当前一致时什么也不做，所以对"姿势类"动作没有副作用。
  syncIdle()

  // ⑥ 到 motion_duration：撤姿势 → 执行 post_command（作者用它恢复交互）
  clearTimeout(playTimer)
  playTimer = setTimeout(() => {
    spine.state.clearTrack(poseTrack)
    restoreExpressionSlots() // clearTrack 不会还回附件，必须自己恢复（否则脸永久定格）
    const nextEff = author.value?.finish(eff)
    if (nextEff) // 作者 post_command 的 start_mtn：接着播那个组
      applyEffect(nextEff)
    syncIdle()
  }, eff.holdMs)
}

/** 点菜单里的第 i 项（作者的 choices[i].next_mtn）。 */
function choose(index: number) {
  const c = menu.value?.choices[index]
  if (!c)
    return
  menu.value = undefined
  playMotionRef(c.next_mtn)
}

/**
 * 只卸掉"模型这一层"（附件、交互、控制器、音频），保留 Application 与 WebGL 上下文。
 * 作者的 change_cos（换装扮）走这条路 —— 不能连上下文一起重建。
 */
function teardownModel() {
  clearTimeout(bubbleTimer)
  clearTimeout(playTimer)
  clearTimeout(emotionTimer)
  bubble.value = ''
  menu.value = undefined
  disposeControls?.()
  disposeControls = undefined
  disposeInteractions?.()
  disposeInteractions = undefined
  disposeControllers?.()
  disposeControllers = undefined
  stopVoice()
  audioEl?.pause()
  audioEl = undefined
  try {
    holder?.destroy({ children: true })
  }
  catch {
    // 上下文已经不可用了，忽略即可
  }
  holder = undefined
  model = undefined
  disposeAssets?.()
  disposeAssets = undefined
}

function teardown() {
  disposed = true
  teardownModel()
  try {
    app?.destroy(false, { children: true })
  }
  catch {
    // 上下文已经不可用了，忽略即可
  }
  app = undefined
}

onMounted(() => {
  void setup()
})
onUnmounted(teardown)

/**
 * 视角操作：直接拖画面移动、滚轮缩放。
 *
 * 比在设置面板里做滑杆省事得多，而且值直接落到 settings/spine38/* 持久化。
 * 注意 Pixi 的坐标是"画布像素"（= 显示尺寸 × renderScale），所以拖拽位移要
 * 乘上 renderScale 才能跟手。
 */
function installViewControls() {
  const canvas = props.canvas
  if (!canvas)
    return

  let dragging = false
  let lastX = 0
  let lastY = 0
  const scaleFactor = () => Math.max(1, props.resolution ?? 1)

  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging)
      return
    const k = scaleFactor()
    viewX.value += (e.clientX - lastX) * k
    viewY.value += (e.clientY - lastY) * k
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = (e: PointerEvent) => {
    dragging = false
    canvas.releasePointerCapture?.(e.pointerId)
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const next = viewScale.value * (e.deltaY > 0 ? 0.92 : 1.08)
    viewScale.value = Math.min(4, Math.max(0.05, Number(next.toFixed(4))))
  }

  canvas.style.pointerEvents = 'auto'
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  disposeControls = () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    canvas.removeEventListener('wheel', onWheel)
  }
}

watch([viewX, viewY, viewScale], ([x, y, s]) => {
  holder?.position.set(x, y)
  model?.scale.set(s)
})

watch(() => [props.width, props.height, props.resolution], ([w, h, r]) => {
  app?.renderer.resize(Math.max(1, Math.floor(w * r)), Math.max(1, Math.floor(h * r)))
})

watch(() => props.paused, (value) => {
  // Pixi v6 的 Application 控制启停靠内部 ticker，但当前 @pixi/app 的类型没暴露它
  const ticker = (app as unknown as { ticker?: { start: () => void, stop: () => void } })?.ticker
  if (value)
    ticker?.stop()
  else ticker?.start()
})

watch(() => props.modelSrc, (v) => {
  activeSrc.value = v ?? ''
  teardownModel()
  void setup()
})

function listAnimations() {
  return model?.spineData.animations.map(a => ({ name: a.name, duration: a.duration })) ?? []
}

function listSkins() {
  return model?.spineData.skins.map(s => ({ name: s.name })) ?? []
}

/**
 * AIRI 的 9 种情绪 → 作者那 11 张脸。
 * 脸号来自**实拍标注**（2026-09-17 把 12 张脸逐张截图后人工辨认）：
 *   1 惊讶/慌张（颤抖线）· 3 好奇/欲言又止 · 8 开心微笑 · 9 害羞（脸红 + ////）
 *   10 困惑/晕（螺旋 + 汗滴）· 11 无奈/叹气 · normal 平静温柔 · 2 淡然思考 · 4 平静认真 · 5 温柔 · 6 轻声 · 7 友善
 * 认不出的按语义就近取（sad → 11 叹气脸、angry → 10 皱眉脸），没有就退回 normal。
 */
const FACE_OF_EMOTION: Record<string, string> = {
  neutral: 'normal',
  happy: '8',
  sad: '11',
  angry: '10',
  surprised: '1',
  awkward: '9',
  question: '3',
  think: '2',
  curious: '3',
}

/**
 * 表情：
 *   ① 同名动画优先（换模型/换包时还能用）；
 *   ② 本模型没有情绪动画 —— 作者是用 `表情` 变量在第 0 层切**整张脸图**（'1'..'11' 都是 0 秒动画），
 *      所以改变量再重套一次 idle 层即可：layer0 换脸，layer1 身体照常。
 */
function setEmotion(name: string, _intensity?: number) {
  if (!model)
    return false
  if (model.spineData.animations.some(a => a.name === name)) {
    model.state.setAnimation(poseTrack, name, false)
    return true
  }
  const face = FACE_OF_EMOTION[name]
  const st = author.value
  if (!face || !st)
    return false
  st.vars['表情'] = face === 'normal' ? 0 : Number(face)
  syncIdle()
  console.info('[spine38] 换脸:', name, '→', face)

  // 到点自己退回原表情 —— 和 Live2D 那套（applyEmotion 的 5 秒 poseTimer）对齐。
  // 少了这一步，她说完一句话那副神情就永远留在脸上，再也回不到原来的样子。
  clearTimeout(emotionTimer)
  if (face !== 'normal') {
    emotionTimer = setTimeout(() => {
      if (author.value) {
        author.value.vars['表情'] = 0
        syncIdle()
      }
    }, EMOTION_HOLD_MS)
  }
  return true
}

defineExpose({
  setMouthLevel,
  setSlotGroupOpacity,
  bubble,
  menu,
  choose,
  authorState: () => author.value,
  listAnimations,
  listSkins,
  setEmotion,
  skeletonVersion: () => skeletonVersion.value,
})
</script>

<template>
  <slot v-if="componentState === 'mounted'" />
</template>
