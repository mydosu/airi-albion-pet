/**
 * 阿尔比恩 · 模型包自带的交互层（数据驱动）
 *
 * 规格来自模型包自己的 `model0.json`（Live2DViewerEX 格式），运行时从
 * `/albion-interactions.json` 读（就是那份文件的拷贝，放在壳的 public/ 下）。
 *
 * 两类互动：
 *   1. `HitAreas[]`      —— 点一下 → 播 `Motion`（形如 "Touch_head.body.special:head"），
 *                           动作条目里若有 `Sound` 就播那条官方语音。
 *   2. `Controllers.ParamHit.Items` —— 在某块命中区按住拖动 → 驱动参数 `Id`
 *                           （丝袜 touch_drag1 / 孔明灯 touch_drag16 / 相机手柄 touch_drag9~12 …）。
 *       `Axis` 0=横 1=纵；`Factor` 是包作者标定的灵敏度（我们按同一比例换算成"拖过画布多少"）；
 *       `ReleaseType` 2=松手弹回，3=保持（丝袜就是要保持住）；`LockParam` 的参数要每帧锁住，
 *       否则空闲动作会把它写回去（这只模型里 Idle 只驱动 Param165=梅花）。
 *
 * 逻辑只有一份：26 条滑动 + 33 个命中区全部由 JSON 推出来，没有一条条硬编码。
 */
import { useLive2dParams } from '@proj-airi/stage-ui-live2d/stores'

import albionInteractionSpec from '../../../apps/stage-tamagotchi/src/renderer/public/albion-interactions.json'

/** 命中区 → 动作：`Group:Name` */
interface SpecHitArea { Name: string, Id: string, Motion?: string }
interface SpecChoice { Text?: string, NextMtn?: string, Command?: string }
interface SpecMotion { Name?: string, File?: string, Sound?: string, Text?: string, NextMtn?: string, Choices?: SpecChoice[], Priority?: number }
interface SpecParamHit {
  Name: string
  Id: string
  HitArea: string
  Axis: number
  Factor: number
  ReleaseType: number
  LockParam?: boolean
}
export interface AlbionInteractionSpec {
  FileReferences: { Motions: Record<string, SpecMotion[]> }
  Controllers: { ParamHit: { Items: SpecParamHit[] } }
  HitAreas: SpecHitArea[]
}

export interface InteractionHooks {
  /** 点到某个部位时叫她说话（沿用桌宠那套）：part 为我们的部位名，可选 */
  onTap: (part: string | undefined, wav: string | undefined) => void
  /** 开始播一条动作时通知壳（壳据此提前接力下一条 —— 作者 PreMtn 的做法） */
  onMotion?: (group: string, index: number) => void
  /** 求壳来播一条动作（走壳里的 Priority 仲裁）；没接就在本地直接写 store */
  playMotion?: (group: string, index: number) => boolean
  /** 播一条模型包自带的语音（菜单选项那些不走 onTap 的路径） */
  playWav: (url: string) => void
}

/** 拖动换算系数：包的 Factor≈0.005 时"拖过约 60% 画布高度"给满量程，0.015 时约 20% —— 全是同一个常数推出来的 */
const DRAG_SCALE = 3333

// 打包态是 file:// 协议 —— 根路径 fetch('/albion-voice/x.wav') 读不到（Chromium 拒绝），
// 所以和 Spine 那边一样，用构建期资产表把 16 条语音收进来（dev/打包态通用）。
const VOICE_URLS = import.meta.glob('../../../apps/stage-tamagotchi/src/renderer/public/albion-voice/*.wav', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

function wavUrl(sound?: string) {
  if (!sound)
    return undefined
  // Motions_Tap_0_Sound_0.wav → albion-voice/tap_0.wav
  const stem = sound.replace(/^Motions_/, '').replace(/_Sound_0\.wav$/i, '').toLowerCase()
  const key = Object.keys(VOICE_URLS).find(k => k.toLowerCase().endsWith(`/${stem}.wav`))
  return key ? VOICE_URLS[key] : undefined
}

export async function startAlbionInteractions(hooks: InteractionHooks) {
  const canvas = await waitCanvas()
  const model = () => (globalThis as any).__albionModel
  // 模型是异步挂上来的（Model.vue 加载完才写 globalThis），等它一会儿
  for (let i = 0; i < 60 && !model(); i++)
    await new Promise(r => setTimeout(r, 500))
  if (!model()) {
    console.warn('[albion-interactions] 等了 30 秒模型还没挂上，交互层不启用')
    return
  }

  let spec: AlbionInteractionSpec
  try {
    // 打包态是 file:// 协议，Chromium 拒绝 fetch(file://) —— 所以改成构建期静态引入
    // （原来是 fetch('/albion-interactions.json')，只有 dev 能读到）。
    spec = albionInteractionSpec as unknown as AlbionInteractionSpec
    // 换模型保护：这份规格是阿尔比恩专属的（命中区/参数名都是作者给这个模型起的）。
    // 抽查几个标志性参数，当前模型没有就说明换了别的 Live2D（或换成 Spine）→ 不启用交互层，免得张冠李戴。
    {
      const core = (model() as any)?.internalModel?.coreModel
      if (core?.getParameterIndex) {
        const marks = ['touch_drag6', 'touch_drag1', 'Paramwuli']
        const found = marks.filter(p => core.getParameterIndex(p) >= 0)
        if (found.length === 0) {
          console.warn('[albion-interactions] 当前模型不是阿尔比恩（标志参数都不存在），交互层不启用')
          return
        }
      }
    }
  }
  catch (e) {
    console.warn('[albion-interactions] 读不到交互规格，跳过', e)
    return
  }

  // ---- 组名 → 该组每个动作的索引 / 语音 / 文本 / 菜单选项 ----
  const groupIndex = new Map<string, Array<{ name: string, i: number, sound?: string, text?: string, choices?: SpecChoice[] }>>()
  for (const [group, arr] of Object.entries(spec.FileReferences.Motions)) {
    groupIndex.set(group, arr.map((m, i) => ({ name: m.Name ?? '', i, sound: m.Sound, text: m.Text, choices: m.Choices })))
  }
  /** "Group:Name" → { group, index, sound, choices } */
  function resolveMotion(ref?: string) {
    if (!ref)
      return null
    const [group, name] = ref.includes(':') ? ref.split(':') : [ref, '']
    const list = groupIndex.get(group)
    if (!list)
      return null
    const item = name ? list.find(x => x.name === name) : list[0]
    if (!item)
      return null
    return { group, index: item.i, sound: item.sound, choices: item.choices }
  }

  const paramHits = spec.Controllers?.ParamHit?.Items ?? []
  const hitAreaMotion = new Map<string, SpecHitArea>()
  for (const h of spec.HitAreas ?? []) hitAreaMotion.set(h.Name, h)

  const live2d = useLive2dParams()
  const locked = ((globalThis as any).__albionLockedParams ??= {} as Record<string, number>)

  function core() {
    return model()?.internalModel?.coreModel
  }
  function paramIndex(id: string): number {
    const ids = core()?._parameterIds
    return ids ? ids.indexOf(id) : -1
  }
  function paramRange(id: string) {
    const c = core()
    const i = paramIndex(id)
    if (!c || i < 0)
      return null
    return {
      min: c._parameterMinimumValues[i] as number,
      max: c._parameterMaximumValues[i] as number,
      now: c.getParameterValueByIndex(i) as number,
    }
  }
  function setParam(id: string, v: number, lock: boolean) {
    const c = core()
    const i = paramIndex(id)
    if (!c || i < 0)
      return
    c.setParameterValueByIndex(i, v)
    if (lock)
      locked[id] = v
  }

  // ---- 校准 ----
  // 作者包的命中区（隐形辅助网格）和可见美术是**错开**的：命中区整体偏右下。
  // 所以"点在画面上的位置"要先换算一次，才能拿去 hitTest。两个参考点：
  //   脸/头   画面 (385,330)（从当前截图像素量出来的） → 命中区 touch_head 中心 (758,610)
  //   小黄鸡  画面 (236,548)（同上）                        → 命中区 ArtMesh92  中心 (458,1092)
  // 每轴一个缩放 + 平移（指挥官在截图上圈的点，图片像素 ÷1.25 得窗口坐标）。
  // 校准是"画面 → 命中区"；画提示框/总览时要反着算回来（uncal*）。
  const CAL_DEFAULT = { sx: 2.0134, tx: -17.17, sy: 2.2110, ty: -119.63 }
  let CAL = { ...CAL_DEFAULT }
  try {
    const saved = JSON.parse(localStorage.getItem('settings/albion/calibration') || 'null')
    if (saved)
      CAL = { ...CAL, ...saved }
  }
  catch {}
  /** 画面坐标 → hitTest 输入（命中判定用这个） */
  const uncalX = (v: number) => CAL.sx * v + CAL.tx
  const uncalY = (v: number) => CAL.sy * v + CAL.ty
  /** hitTest 输入 → 画面坐标（画提示框/总览用这个） */
  const toScreenX = (v: number) => (v - CAL.tx) / CAL.sx
  const toScreenY = (v: number) => (v - CAL.ty) / CAL.sy

  // ---- 指挥官圈定的两个区域（画面坐标，量自他的标注图；其余区域仍用全局校准）----
  // 作者的网格彼此不成线性关系，个别区域对不齐时，就按"他确认为准"的画面范围直接登记。
  const AREA_FIX: Record<string, [number, number, number, number]> = {
    touch_head: [371, 271, 457, 358], // 黑圈：头部
    TouchDrag16: [486, 18, 587, 156], // 灰圈：孔明灯
  }
  function inFix(x: number, y: number): string[] {
    const out: string[] = []
    for (const [name, b] of Object.entries(AREA_FIX)) {
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])
        out.push(name)
    }
    return out
  }

  let down: { x: number, y: number, hits: string[] } | null = null
  let lastTapPoint = { x: 0, y: 0 }

  function hitsAt(x: number, y: number): string[] {
    const fixed = inFix(x, y) // 指挥官圈定的两处，直接按画面范围算
    try {
      const rect = canvas.getBoundingClientRect()
      // 登记过的区域"以指挥官圈的位置为准"：全局校准再命中它们也不算（否则会捎带出一大片）
      const hits = ((model()?.hitTest(uncalX(x - rect.left), uncalY(y - rect.top)) as string[]) ?? [])
        .filter(h => !(h in AREA_FIX))
      return fixed.length ? fixed : hits // 落在登记范围里就只算它自己
    }
    catch {
      return fixed
    }
  }

  // ---- 让人知道哪儿能点/能拖（这包的区域是看不见的，不给提示等于没法发现）----
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:99997;border:2px solid rgba(255,255,255,.9);border-radius:10px;'
    + 'box-shadow:0 0 10px rgba(0,0,0,.25);background:rgba(255,255,255,.10);display:none'
  document.body.append(box)
  hideHint()

  function hideHint() {
    box.style.display = 'none'
  }

  /** 命中区在**画面上**的矩形（先把命中区坐标反解回画面，尺寸也按同一比例换算） */
  function screenRect(drawableId: string) {
    for (const [name, b] of Object.entries(AREA_FIX)) {
      // 登记过的区域，直接用它自己的画面范围（名字可能传 id 也可能传 name）
      const ha = hitAreaMotion.get(name)
      if (name === drawableId || ha?.Id === drawableId)
        return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }
    }
    const im = model()?.internalModel
    const i = im?.coreModel?._drawableIds?.indexOf(drawableId) ?? -1
    if (i < 0)
      return null
    const b = im.getDrawableBounds(i)
    const t = model().worldTransform
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
      .map(([x, y]) => [t.a * x + t.c * y + t.tx, t.b * x + t.d * y + t.ty])
    const xs = pts.map(p => toScreenX(p[0] as number))
    const ys = pts.map(p => toScreenY(p[1] as number))
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }

  function showHint(name: string) {
    const ha = hitAreaMotion.get(name)
    const r = ha ? screenRect(ha.Id) : null
    if (!r)
      return
    box.style.left = `${Math.round(r.x - 3)}px`
    box.style.top = `${Math.round(r.y - 3)}px`
    box.style.width = `${Math.round(r.w + 6)}px`
    box.style.height = `${Math.round(r.h + 6)}px`
    box.style.display = 'block'
  }

  // ---- 应急退出：Esc = 把所有"拖动锁住的参数"恢复默认（相机模式卡住就按它）----
  function resetAllParams(reason: string) {
    const c = core()
    if (c) {
      for (const id of Object.keys(locked)) {
        const i = c._parameterIds.indexOf(id)
        if (i >= 0)
          c.setParameterValueByIndex(i, c._parameterDefaultValues?.[i] ?? 0)
      }
    }
    Object.keys(locked).forEach(k => delete locked[k])
    console.info(`[albion-interactions] 已复位所有互动参数（${reason}）`)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      resetAllParams('Esc')
  })

  // ---- 调试：把命中区画出来（H 键切换，或 __albionInteractions.areas(true)）----
  const NICE_NAME: Record<string, string> = {
    ArtMesh92: '小黄鸡（菜单）',
    ArtMesh311: '梅花枝',
    TouchDrag6: '闪光点（下滑唤出相机）',
    TouchDrag7: '快门',
    TouchDrag8: '聚焦（左右拖）',
  }
  let areaLayer: HTMLDivElement | null = null
  function toggleAreas(on?: boolean) {
    const want = on ?? !areaLayer
    if (!want) {
      areaLayer?.remove()
      areaLayer = null
      return false
    }
    if (!areaLayer) {
      areaLayer = document.createElement('div')
      areaLayer.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:99996'
      document.body.appendChild(areaLayer)
    }
    areaLayer.innerHTML = ''
    for (const ha of spec.HitAreas ?? []) {
      const r = screenRect(ha.Id)
      if (!r)
        continue
      const d = document.createElement('div')
      d.style.cssText = 'position:fixed;border:1px dashed rgba(255,110,160,.9);background:rgba(255,110,160,.12);'
        + 'font:10px/1.3 system-ui,sans-serif;color:#c2185b;padding:1px 3px'
      d.style.left = `${r.x}px`
      d.style.top = `${r.y}px`
      d.style.width = `${r.w}px`
      d.style.height = `${r.h}px`
      d.textContent = NICE_NAME[ha.Id] ?? ha.Name
      areaLayer.appendChild(d)
    }
    return true
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H')
      toggleAreas()
  })

  // ---- 视线跟随：作者 MouseTracking 里的眼珠两条（壳只驱动了头/身角度，眼珠一直是 0）----
  // 作者给的限值 ±0.8、平滑时间 0.404648453s；Input 1/2 = 鼠标 x/y，Axis 0/1 = 第几轴
  const EYE_MIN = -0.8
  const EYE_MAX = 0.8
  const EYE_SMOOTH = 0.404648453
  const eyeNow = { x: 0, y: 0 }
  let mouseNorm = { x: 0.5, y: 0.5 } // 画布内归一化位置
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect()
    mouseNorm = {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(r.width, 1))),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(r.height, 1))),
    }
  })
  {
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // 目标：鼠标位置 → [-1,1] → 作者限值；再按平滑时间做一阶低通
      const k = Math.min(1, dt / EYE_SMOOTH)
      const tx = (mouseNorm.x * 2 - 1) * EYE_MAX
      const ty = (mouseNorm.y * 2 - 1) * EYE_MAX
      eyeNow.x += (tx - eyeNow.x) * k
      eyeNow.y += (ty - eyeNow.y) * k
      const clamp = (v: number) => Math.min(EYE_MAX, Math.max(EYE_MIN, v))
      setParam('ParamEyeBallX', clamp(eyeNow.x), false)
      setParam('ParamEyeBallY', clamp(eyeNow.y), false)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // ---- 作者包里的"显示开关"（model0.json → Controllers.PartOpacity / ArtmeshOpacity）----
  // 部件透明度：SDK 有 setPartOpacityById，可以直接切；网格透明度：SDK 没有网格级 setter（保持 1.0）。
  const PART_SWITCHES: Array<{ label: string, ids: string[] }> = [
    { label: '披帛', ids: ['Part40'] },
    { label: '发壹', ids: ['Part37'] },
    { label: '发贰', ids: ['Part38'] },
  ]
  /** 作者列过、但 Web SDK 做不到的网格级开关（列在面板里说明，免得以为是漏了） */
  const MESH_SWITCHES: Array<{ label: string, ids: string[] }> = [
    { label: '梅发（网格级）', ids: ['ArtMesh97', 'ArtMesh763', 'ArtMesh98', 'ArtMesh312', 'ArtMesh311'] },
    { label: '栅栏·影（网格级）', ids: ['ArtMesh811'] },
    { label: '背景·壹（网格级）', ids: ['ArtMesh322', 'ArtMesh127', 'ArtMesh313'] },
    { label: '背景·贰（网格级）', ids: ['ArtMesh318', 'ArtMesh319', 'ArtMesh320', 'ArtMesh321', 'ArtMesh76', 'ArtMesh77', 'ArtMesh82', 'ArtMesh81', 'ArtMesh80', 'ArtMesh79', 'ArtMesh78', 'ArtMesh83', 'ArtMesh84', 'ArtMesh805', 'ArtMesh806', 'ArtMesh75', 'ArtMesh65', 'ArtMesh66', 'ArtMesh72', 'ArtMesh67', 'ArtMesh68', 'ArtMesh69', 'ArtMesh70', 'ArtMesh71', 'ArtMesh73', 'Ljio', 'Rjio'] },
  ]
  /** 隐藏的部件（label）→ 存 localStorage，重启也记得 */
  const hiddenParts = new Set<string>(JSON.parse(localStorage.getItem('settings/albion/hidden-parts') || '[]'))
  function applyPartSwitches() {
    const c = core()
    if (!c?.setPartOpacityById)
      return
    for (const sw of PART_SWITCHES) {
      const v = hiddenParts.has(sw.label) ? 0 : 1
      for (const id of sw.ids) {
        try {
          c.setPartOpacityById(id, v)
        }
        catch {}
      }
    }
  }
  function togglePartSwitch(label: string) {
    if (hiddenParts.has(label))
      hiddenParts.delete(label)
    else hiddenParts.add(label)
    localStorage.setItem('settings/albion/hidden-parts', JSON.stringify([...hiddenParts]))
    applyPartSwitches()
    refreshPanel()
    console.info(`[albion-interactions] ${label} → ${hiddenParts.has(label) ? '隐藏' : '显示'}`)
  }
  applyPartSwitches()

  // ---- 面板（按 O 开关）：列出作者的显示开关，能切的点一下就切 ----
  let panel: HTMLDivElement | null = null
  function refreshPanel() {
    if (!panel)
      return
    const rows = PART_SWITCHES.map(sw =>
      `<div data-label="${sw.label}" style="padding:4px 10px;border-radius:8px;cursor:pointer;background:${hiddenParts.has(sw.label) ? 'rgba(255,110,160,.35)' : 'rgba(255,255,255,.9)'}">`
      + `${hiddenParts.has(sw.label) ? '○ 已隐藏' : '● 显示中'}　${sw.label}</div>`)
    const mesh = MESH_SWITCHES.map(sw => `<div style="padding:4px 10px;color:#888">—　${sw.label}（SDK 无网格级接口，未接）</div>`)
    panel.innerHTML = `<div style="font-weight:600;margin-bottom:6px">显示开关（作者包里的）</div>${rows.join('')}${mesh.join('')}`
    for (const el of panel.querySelectorAll('div[data-label]'))
      (el as HTMLElement).onclick = () => togglePartSwitch((el as HTMLElement).dataset.label ?? '')
  }
  function togglePanel() {
    if (panel) {
      panel.remove()
      panel = null
      return false
    }
    panel = document.createElement('div')
    panel.style.cssText = 'position:fixed;right:10px;top:60px;z-index:99998;display:flex;flex-direction:column;gap:4px;padding:8px 10px;'
      + 'border-radius:12px;background:rgba(255,255,255,.86);box-shadow:0 6px 18px rgba(0,0,0,.18);font:13px/1.5 system-ui,sans-serif;color:#3a3a3a'
    document.body.appendChild(panel)
    refreshPanel()
    return true
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'o' || e.key === 'O')
      togglePanel()
  })

  // ---- 现场微调：Alt + 方向键整体挪区域（Shift = 10px），Alt+S 存下来 ----
  // 位置对不对只有眼睛能判，所以留个旋钮；调整时屏幕上会显示当前数值。
  const hud = document.createElement('div')
  hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99998;padding:4px 8px;border-radius:8px;display:none;'
    + 'background:rgba(0,0,0,.62);color:#fff;font:12px/1.5 monospace'
  document.body.appendChild(hud)
  let hudTimer: ReturnType<typeof setTimeout> | undefined
  function showCal() {
    hud.textContent = `校准 sx=${CAL.sx.toFixed(4)} tx=${CAL.tx.toFixed(2)} sy=${CAL.sy.toFixed(4)} ty=${CAL.ty.toFixed(2)}`
    hud.style.display = 'block'
    clearTimeout(hudTimer)
    hudTimer = setTimeout(() => {
      hud.style.display = 'none'
    }, 2500)
  }
  function saveCal() {
    localStorage.setItem('settings/albion/calibration', JSON.stringify(CAL))
    console.info('[albion-interactions] 校准已保存 =', CAL)
    hud.textContent = '校准已保存 ✓'
    hud.style.display = 'block'
    clearTimeout(hudTimer)
    hudTimer = setTimeout(() => {
      hud.style.display = 'none'
    }, 1500)
  }
  window.addEventListener('keydown', (e) => {
    if (!e.altKey)
      return
    if (e.key === 's' || e.key === 'S') {
      saveCal()
      e.preventDefault()
      return
    }
    const step = e.shiftKey ? 10 : 1
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const dd = d[e.key]
    if (!dd)
      return
    // 框 = (区域 - T)/S；要让框整体移动 dd，就 T -= S·dd
    CAL = { ...CAL, tx: CAL.tx - CAL.sx * dd[0], ty: CAL.ty - CAL.sy * dd[1] }
    console.info('[albion-interactions] 校准微调 =', CAL)
    showCal()
    e.preventDefault()
  })

  // ---- 事件留痕：用户说"点了没反应"时，读 __albionInteractions.trace() ----
  const trace: Array<Record<string, unknown>> = []
  function note(entry: Record<string, unknown>) {
    trace.push({ t: Date.now(), ...entry })
    if (trace.length > 40)
      trace.shift()
  }

  // ---- 小黄鸡菜单（包里 Mune 组的 Choices：登录/回港/誓约/追踪）----
  function showChoices(choices: SpecChoice[], at: { x: number, y: number }) {
    document.getElementById('__albion_menu')?.remove()
    const box = document.createElement('div')
    box.id = '__albion_menu'
    box.style.cssText = 'position:fixed;z-index:99998;display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:12px;'
      + 'background:rgba(255,255,255,.86);box-shadow:0 6px 18px rgba(0,0,0,.18);font:13px/1.4 system-ui,sans-serif;color:#3a3a3a'
    box.style.left = `${Math.max(6, Math.min(at.x, window.innerWidth - 120))}px`
    box.style.top = `${Math.max(6, Math.min(at.y, window.innerHeight - 150))}px`
    for (const c of choices) {
      const b = document.createElement('button')
      b.textContent = c.Text ?? ''
      b.style.cssText = 'border:none;border-radius:8px;padding:4px 12px;background:rgba(255,255,255,.9);cursor:pointer;text-align:left;color:#3a3a3a;font:inherit'
      b.addEventListener('mouseenter', () => {
        b.style.background = '#ffe9a8'
      })
      b.addEventListener('mouseleave', () => {
        b.style.background = 'rgba(255,255,255,.9)'
      })
      b.addEventListener('click', (ev) => {
        ev.stopPropagation()
        box.remove()
        pickChoice(c)
      })
      box.appendChild(b)
    }
    document.body.appendChild(box)
    setTimeout(() => box.remove(), 8000) // 8 秒不动就收起来
  }

  function pickChoice(c: SpecChoice) {
    if (!c.NextMtn) {
      console.info('[albion-interactions] 这个选项只有命令，还没接:', c.Command)
      return
    }
    const m = resolveMotion(c.NextMtn)
    if (!m) {
      console.info('[albion-interactions] 选项指向的动作组不存在:', c.NextMtn)
      return
    }
    if (hooks.playMotion) {
      if (!hooks.playMotion(m.group, m.index)) {
        console.info(`[albion-interactions] 菜单选了「${c.Text}」，但 Priority 仲裁没放行`)
        return
      }
    }
    else { live2d.currentMotion = { group: m.group, index: m.index } }
    console.info(`[albion-interactions] 菜单选了「${c.Text}」→ ${m.group}[${m.index}]`)
    if (m.sound)
      hooks.playWav(wavUrl(m.sound) ?? '')
  }

  // ---- 拖动会话 ----
  /**
   * 一次拖动里挂着的参数（**同一块命中区上的全部**：作者的手柄就是 4 条
   *  —— 视角-左右/上下 + 手柄-左右/上下，横拖驱动两条 X、竖拖驱动两条 Y、斜拖全动）
   */
  interface DragItem { spec: SpecParamHit, start: number, min: number, max: number }
  let drag: { items: DragItem[], x0: number, y0: number } | null = null

  function beginDrag(area: string, e: PointerEvent) {
    const specs = paramHits.filter(h => h.HitArea === area)
    const items: DragItem[] = []
    for (const spec of specs) {
      const rng = paramRange(spec.Id)
      if (!rng) {
        console.warn('[albion-interactions] 模型里没有这个参数:', spec.Id)
        continue
      }
      items.push({ spec, start: rng.now, min: rng.min, max: rng.max })
      if (spec.LockParam)
        locked[spec.Id] = rng.now
    }
    if (!items.length) {
      console.warn('[albion-interactions] 这块区域没有可拖的参数:', area)
      return false
    }
    drag = { items, x0: e.clientX, y0: e.clientY }
    console.info(`[albion-interactions] 开始拖动「${area}」→ ${items.map(i => `${i.spec.Name}(${i.spec.Id})`).join(' / ')}`)
    return true
  }

  function applyDrag(e: PointerEvent) {
    if (!drag)
      return
    const rect = canvas.getBoundingClientRect()
    for (const it of drag.items) {
      const isX = it.spec.Axis === 0
      const delta = isX ? e.clientX - drag.x0 : e.clientY - drag.y0
      const size = isX ? rect.width : rect.height
      const v = Math.min(it.max, Math.max(it.min, it.start + (delta / Math.max(size, 1)) * it.spec.Factor * DRAG_SCALE))
      setParam(it.spec.Id, v, true)
    }
  }

  function endDrag() {
    if (!drag)
      return
    const { items } = drag
    console.info(`[albion-interactions] 结束拖动（${items.length} 条参数）`)
    for (const it of items) {
      if (it.spec.ReleaseType === 2) {
        // 快出：松手弹回原值（快门那种"点一下"的参数）
        setParam(it.spec.Id, it.start, false)
        if (!it.spec.LockParam)
          delete locked[it.spec.Id]
      }
    }
    drag = null
  }

  function partFromHit(hits: string[]): string | undefined {
    for (const h of hits) {
      if (h === 'touch_head')
        return 'head'
      if (h === 'touch_body')
        return 'chest'
      if (h === 'touch_special')
        return 'special'
      if (h === 'touch_drag1')
        return 'leg'
      if (h === 'TouchDrag2' || h === 'touch_drag2')
        return 'thigh'
      if (h === 'touch_drag3' || h === 'touch_drag4')
        return 'waist'
    }
    return undefined
  }

  function tap(hits: string[]) {
    // 取第一个带动作的命中区
    let motion = null as ReturnType<typeof resolveMotion>
    for (const h of hits) {
      const entry = hitAreaMotion.get(h)
      if (entry?.Motion) {
        motion = resolveMotion(entry.Motion)
        if (motion)
          break
      }
    }
    if (motion) {
      if (hooks.playMotion) {
        if (!hooks.playMotion(motion.group, motion.index)) {
          console.info(`[albion-interactions] 点「${hits[0]}」→ Priority 仲裁没放行，跳过`)
          return
        }
      }
      else { live2d.currentMotion = { group: motion.group, index: motion.index } }
      hooks.onMotion?.(motion.group, motion.index) // 告诉壳：开始播这条了（它好提前接力下一条）
      console.info(`[albion-interactions] 点「${hits[0]}」→ 播 ${motion.group}[${motion.index}]`)
      if (motion.sound)
        hooks.playWav(wavUrl(motion.sound) ?? '')
      if (motion.choices?.length)
        showChoices(motion.choices, lastTapPoint)
    }
    else if (hits.length) {
      console.info(`[albion-interactions] 点「${hits[0]}」（这个命中区没配动作）`)
    }
    hooks.onTap(partFromHit(hits), wavUrl(motion?.sound))
  }

  // 按下时先只"挂号"：同一块区域既可能是点击（播动作）也可能是拖动（改参数，
  // 比如头饰/丝袜就压在触摸区上）。真正拖动要等指针先动起来再判定——不然点头也会被当成拖头饰。
  let pending: { area?: string, x: number, y: number } | null = null

  canvas.addEventListener('pointerdown', (e) => {
    const hits = hitsAt(e.clientX, e.clientY)
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    note({ type: 'down', x: e.clientX, y: e.clientY, hits, target: el ? `${el.tagName}.${el.className}`.slice(0, 40) : null })
    hideHint()
    const ph = paramHits.find(p => hits.includes(p.HitArea))
    pending = { area: ph?.HitArea, x: e.clientX, y: e.clientY }
    down = { x: e.clientX, y: e.clientY, hits }
    void pending
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drag && !pending) {
      const h = hitsAt(e.clientX, e.clientY)
      if (h.length)
        showHint(h[0])
      else hideHint()
    }
    if (!drag && pending?.area) {
      const moved = Math.hypot(e.clientX - pending.x, e.clientY - pending.y)
      if (moved > 6 && beginDrag(pending.area, { clientX: pending.x, clientY: pending.y } as PointerEvent)) {
        canvas.setPointerCapture(e.pointerId)
        down = null
      }
    }
    if (drag)
      applyDrag(e)
  })
  const finish = (e: PointerEvent) => {
    if (drag) {
      endDrag()
      note({ type: 'dragEnd', x: e.clientX, y: e.clientY })
      pending = null
      return
    }
    pending = null
    if (!down)
      return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    if (moved < 6) {
      lastTapPoint = { x: e.clientX, y: e.clientY }
      note({ type: 'tap', x: e.clientX, y: e.clientY, hits: down.hits })
      tap(down.hits)
    }
    else {
      note({ type: 'swipeIgnored', x: e.clientX, y: e.clientY, hits: down.hits, moved: Math.round(moved) })
    }
    down = null
  }
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', () => {
    drag = null
    down = null
  })

  const chip = document.createElement('div')
  chip.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99997;padding:3px 10px;border-radius:10px;'
    + 'background:rgba(255,255,255,.86);color:#3a3a3a;font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);display:none'
  chip.textContent = '相机模式：按 Esc 退出（或把"闪光点"往上拖回去）'
  document.body.appendChild(chip)
  setInterval(() => {
    chip.style.display = (locked.touch_drag6 ?? 0) > 0.5 ? 'block' : 'none'
  }, 700)

  const api = {
    spec,
    trace: () => trace.slice(),
    reset: () => resetAllParams('接口'),
    areas: (on?: boolean) => toggleAreas(on),
    /** 直接推一个参数（调试/验收用）：推 10 就是丝袜脱到底 */
    setParam: (id: string, v: number) => setParam(id, v, true),
    paramRange,
    hitsAt,
    locked: () => ({ ...locked }),
    unlock: (id?: string) => { id ? delete locked[id] : Object.keys(locked).forEach(k => delete locked[k]) },
    menu: (group = 'Mune') => showChoices(spec.FileReferences.Motions[group]?.[0]?.Choices ?? [], { x: 100, y: 300 }),
    /** 校准旋钮：给 { sx, sy, tx, ty } 就改（存 localStorage 并立即生效）；给 { reset: true } 恢复默认 */
    calibrate: (o: Partial<typeof CAL_DEFAULT> & { reset?: boolean }) => {
      if (o?.reset)
        CAL = { ...CAL_DEFAULT }
      else
        CAL = { ...CAL, ...o }
      localStorage.setItem('settings/albion/calibration', JSON.stringify(CAL))
      console.info('[albion-interactions] 校准 =', CAL)
      return { ...CAL }
    },
    calibration: () => ({ ...CAL, default: { ...CAL_DEFAULT } }),
    saveCalibration: () => saveCal(),
    parts: () => ({ hidden: [...hiddenParts], switches: PART_SWITCHES.map(s => s.label) }),
    togglePart: (label: string) => togglePartSwitch(label),
    panel: () => togglePanel(),
    nudge: (dx: number, dy: number) => {
      CAL = { ...CAL, tx: CAL.tx - CAL.sx * dx, ty: CAL.ty - CAL.sy * dy }
      return { ...CAL }
    },
  }
  ;(globalThis as any).__albionInteractions = api
  console.info(`[albion-interactions] 就绪：${paramHits.length} 条滑动交互 / ${(spec.HitAreas ?? []).length} 个命中区`)
}

async function waitCanvas(): Promise<HTMLCanvasElement> {
  for (let i = 0; i < 60; i++) {
    const c = document.querySelector('canvas')
    if (c)
      return c as HTMLCanvasElement
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('找不到 canvas')
}
