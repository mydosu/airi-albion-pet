/**
 * 作者交互定义的运行时（Live2DViewerEX 的 modelN.json）。
 *
 * 这不是"仿照作者做一套交互"，而是**直接执行作者的字段**：
 *   hit_areas[].motion   → "<组>:<条目>" 引用（如 "选项:选项" / "tap摸头:1"）
 *   motions[组][]        → 每个条目带 file(动画名) / sound / text / command /
 *                          post_command / text_duration / motion_duration /
 *                          weight / choices / var_floats
 *   controllers          → key_trigger / eye_blink / lip_sync / mouse_tracking /
 *                          auto_breath / accelerometer / intimacy_system /
 *                          slot_opacity / extra_motion / slot_color
 *
 * 变量系统（var_floats）：
 *   type 1 = **条件**，"equal N" / "not_equal N"（不满足就不播这条）
 *   type 2 = **赋值**，"assign N"（播了就写变量）
 * 这套变量让作者实现了"同一组台词不连续重复"（触摸 not_equal N / assign N）
 * 与"待机按表情切动画"（表情 equal N → idleN）。
 */

export interface AuthorVarFloat {
  name: string
  type: number
  code: string
}

export interface AuthorChoice {
  text: string
  next_mtn: string
}

export interface AuthorMotionEntry {
  name: string
  file?: string
  /** 作者的循环标记：1 = 循环播放。 */
  wrap_mode?: number
  sound?: string
  text?: string
  command?: string
  post_command?: string
  text_duration?: number
  motion_duration?: number
  weight?: number
  choices?: AuthorChoice[]
  var_floats?: AuthorVarFloat[]
}

export interface AuthorHitArea {
  name: string
  id: string
  motion: string
  width: number
  height: number
  center_x?: number
  center_y?: number
}

export interface AuthorSpec {
  controllers?: Record<string, unknown>
  hit_areas?: AuthorHitArea[]
  motions?: Record<string, AuthorMotionEntry[]>
  options?: Record<string, unknown>
}

/** 解析 "<组>:<条目>"；没有冒号时组与条目同名（作者用 "选项" 指 选项:选项）。 */
export function parseRef(ref: string): [string, string] {
  const i = ref.indexOf(':')
  return i < 0 ? [ref, ref] : [ref.slice(0, i), ref.slice(i + 1)]
}

function parseCode(code: string): [string, number] | null {
  const parts = String(code ?? '').trim().split(/\s+/)
  if (parts.length !== 2)
    return null
  if (!['equal', 'not_equal', 'assign'].includes(parts[0]))
    return null
  const n = Number(parts[1])
  return Number.isFinite(n) ? [parts[0], n] : null
}

/** 条件：全部 type 1 的条目都满足才算通过（type 2 是赋值，永远通过）。 */
export function checkVarFloats(vfs: AuthorVarFloat[] | undefined, vars: Record<string, number>): boolean {
  for (const vf of vfs ?? []) {
    if (vf.type !== 1)
      continue
    const p = parseCode(vf.code)
    if (!p)
      continue
    const [op, n] = p
    const cur = vars[vf.name] ?? 0
    if (op === 'equal' && cur !== n)
      return false
    if (op === 'not_equal' && cur === n)
      return false
  }
  return true
}

/** 赋值：把 type 2 的条目写进变量表。 */
export function applyVarFloats(vfs: AuthorVarFloat[] | undefined, vars: Record<string, number>): void {
  for (const vf of vfs ?? []) {
    if (vf.type !== 2)
      continue
    const p = parseCode(vf.code)
    if (p && p[0] === 'assign')
      vars[vf.name] = p[1]
  }
}

/** 作者的 command / post_command：`motions disable A;B`、`change_cos x.json`、`start_mtn x`。 */
export interface AuthorCommand {
  enable: string[]
  disable: string[]
  changeCos?: string
  startMtn?: string
  /** `slot_opacities lock a,b,c 0` —— 作者的"锁掉某些槽"就是"脱衣服"的实际做法。 */
  slotOpacity: { ids: string[], value: number }[]
}

export function parseCommand(cmd: string | undefined): AuthorCommand {
  const out: AuthorCommand = { enable: [], disable: [], slotOpacity: [] }
  // 用 startsWith/slice 而不是正则：`\s*...(.+)` 这种写法会被 lint 判为可回溯，
  // 而且这里本来就不需要正则。
  for (const part of (cmd ?? '').split(';')) {
    const t = part.trim()
    if (!t)
      continue
    const rest = (head: string) => (t.startsWith(head) ? t.slice(head.length).trim() : null)
    const motionsRest = rest('motions ')
    if (motionsRest) {
      const sp = motionsRest.indexOf(' ')
      if (sp < 0)
        continue
      const verb = motionsRest.slice(0, sp)
      const list = motionsRest.slice(sp + 1).split(',').map(s => s.trim()).filter(Boolean)
      const target = verb === 'enable' ? out.enable : out.disable
      for (const n of list)
        target.push(n)
      continue
    }
    const cos = rest('change_cos ')
    if (cos) {
      out.changeCos = cos
      continue
    }
    const mtn = rest('start_mtn ')
    if (mtn) {
      out.startMtn = mtn
      continue
    }
    const op = rest('slot_opacities ')
    if (op) {
      // 形如 "lock chenshan-4,chenshan-3 0"（动词可省略，取最后一段当数值）
      const parts = op.split(/\s+/)
      const value = Number(parts[parts.length - 1])
      const idPart = parts[parts.length - 2] ?? ''
      if (Number.isFinite(value) && idPart) {
        out.slotOpacity.push({
          ids: idPart.split(',').map(s => s.trim()).filter(Boolean),
          value,
        })
      }
    }
  }
  return out
}

/** 在组里挑一条：var_floats 条件必须满足；多条满足时按 weight 加权随机（作者只有触摸组用了 weight: 3）。 */
export function pickEntry(group: AuthorMotionEntry[] | undefined, vars: Record<string, number>, rng: () => number = Math.random): AuthorMotionEntry | undefined {
  const ok = (group ?? []).filter(e => checkVarFloats(e.var_floats, vars) && e.name !== '选项' && !e.choices)
  if (ok.length === 0)
    return undefined
  const total = ok.reduce((a, e) => a + (e.weight ?? 1), 0)
  let r = rng() * total
  for (const e of ok) {
    r -= (e.weight ?? 1)
    if (r <= 0)
      return e
  }
  return ok[ok.length - 1]
}

/**
 * 一次"播放"要执行的全部效果 —— 由适配层去动 Spine / 音频 / 气泡。
 * 之所以做成纯数据，是为了能在没有渲染器的环境里自检（见 selfTest）。
 */
export interface AuthorPlayEffect {
  animation?: string
  sound?: string
  text?: string
  holdMs: number
  textMs: number
  command: AuthorCommand
  postCommand: AuthorCommand
  choices?: AuthorChoice[]
  varsAfter: Record<string, number>
}

export class AuthorState {
  readonly vars: Record<string, number> = {}
  /** 被 command 关掉的组（作者用它防止台词被打断）。 */
  readonly disabled = new Set<string>()
  cos: string | undefined
  readonly spec: AuthorSpec

  constructor(spec: AuthorSpec) {
    this.spec = spec
    for (const [k, v] of Object.entries(spec.controllers ?? {})) {
      // 作者给每个 controller 一个 enabled 开关（key_trigger / slot_opacity 有）
      if (v && typeof v === 'object' && 'enabled' in v && (v as { enabled?: boolean }).enabled === false)
        this.disabled.add(`controller:${k}`)
    }
  }

  group(name: string): AuthorMotionEntry[] | undefined {
    return this.spec.motions?.[name]
  }

  /** 组是否被禁用（command 或作者 controller 的 enabled:false）。 */
  isDisabled(group: string): boolean {
    return this.disabled.has(group)
  }

  private setGroups(names: string[], off: boolean) {
    for (const n of names) {
      if (off)
        this.disabled.add(n)
      else
        this.disabled.delete(n)
    }
  }

  /** 解析 "<组>:<条目>" 并产出一条可执行的播放效果。 */
  play(ref: string, rng: () => number = Math.random): AuthorPlayEffect | undefined {
    const [g, n] = parseRef(ref)
    if (this.isDisabled(g))
      return undefined
    const group = this.group(g)
    if (!group)
      return undefined
    // 指名条目：优先精确匹配 name；找不到就当作"播放整组"（作者的 motion 有时只给组名）
    const named = group.find(e => e.name === n)
    let entry: AuthorMotionEntry | undefined
    if (named && checkVarFloats(named.var_floats, this.vars))
      entry = named
    else if (g === n)
      entry = pickEntry(group, this.vars, rng)
    else
      entry = named ?? undefined
    if (!entry)
      return undefined
    return this.effect(entry)
  }

  /** 直接按组挑一条播放（点击部位时用，作者行为就是这样）。 */
  playGroup(groupName: string, rng: () => number = Math.random): AuthorPlayEffect | undefined {
    if (this.isDisabled(groupName))
      return undefined
    const entry = pickEntry(this.group(groupName), this.vars, rng)
    return entry ? this.effect(entry) : undefined
  }

  private effect(entry: AuthorMotionEntry): AuthorPlayEffect {
    applyVarFloats(entry.var_floats, this.vars)
    const command = parseCommand(entry.command)
    const postCommand = parseCommand(entry.post_command)
    this.setGroups(command.disable, true)
    this.setGroups(command.enable, false) // 作者的"开启闲置语音"靠 command 里的 enable 把组重新打开
    if (command.changeCos)
      this.cos = command.changeCos
    return {
      animation: entry.file,
      sound: entry.sound,
      text: entry.text,
      holdMs: entry.motion_duration ?? entry.text_duration ?? 3000,
      textMs: entry.text_duration ?? entry.motion_duration ?? 3000,
      command,
      postCommand,
      choices: entry.choices,
      varsAfter: { ...this.vars },
    }
  }

  /**
   * 一次播放结束后执行 post_command（作者用它把交互重新打开）。
   * 其中 `start_mtn 组名` 要**接着播那个组** —— 作者只有一处用到它：
   * 「闲置语音开关:开」的 post_command = `start_mtn leave_30_20_30`，
   * 也就是"打开闲置语音"后，leave 组开始自己播。返回要接着播的效果，调用方接力即可。
   */
  finish(effect: AuthorPlayEffect): AuthorPlayEffect | undefined {
    this.setGroups(effect.postCommand.disable, true)
    this.setGroups(effect.postCommand.enable, false)
    for (const v of Object.keys(this.vars)) {
      if (!(v in effect.varsAfter))
        delete this.vars[v]
    }
    const start = effect.postCommand.startMtn
    return start ? this.playGroup(start) : undefined
  }

  /**
   * 待机是**分层**的：组名 `idle` = 第 0 层、`idle#1` = 第 1 层 ……（层号就是轨道号）。
   * 本模型：第 0 层按 `表情` 变量在 normal / '1'..'11' 之间切（脸），第 1 层恒为 normal（身体）。
   * 只播第 0 层的话，一旦选了表情（'1'..'11' 全是 0 秒动画）就再没人写身体骨骼 ⇒ 全身静止、
   * 只剩我们自己叠的头跟随还在动。所以必须把每层都推上对应轨道。
   */
  idleLayers(): string[] {
    const out: string[] = []
    for (let i = 0; i < 8; i++) {
      const group = this.group(i === 0 ? 'idle' : `idle#${i}`)
      if (!group)
        break
      const entry = group.find(e => !e.choices && e.name !== '选项' && checkVarFloats(e.var_floats, this.vars))
        ?? group.find(e => !e.choices && e.name !== '选项')
      if (!entry?.file)
        break
      out.push(entry.file)
    }
    return out
  }

  /** 菜单：把一个含 choices 的条目转成可点选项。 */
  menu(ref: string): { title: string, choices: AuthorChoice[] } | undefined {
    const [g, n] = parseRef(ref)
    const entry = this.group(g)?.find(e => e.name === n)
    return entry?.choices ? { title: entry.text ?? n, choices: entry.choices } : undefined
  }
}

/** 自检：不依赖渲染器，纯逻辑。跑在开发态（见 Model.vue）。 */
export function selfTest(): string[] {
  const errs: string[] = []
  const eq = (cond: unknown, msg: string) => {
    if (!cond)
      errs.push(msg)
  }

  eq(JSON.stringify(parseRef('选项:选项')) === JSON.stringify(['选项', '选项']), 'parseRef 带冒号')
  eq(JSON.stringify(parseRef('选项')) === JSON.stringify(['选项', '选项']), 'parseRef 不带冒号')

  const vars: Record<string, number> = { 触摸: 1 }
  eq(checkVarFloats([{ name: '触摸', type: 1, code: 'not_equal 1' }], vars) === false, 'not_equal 命中')
  eq(checkVarFloats([{ name: '触摸', type: 1, code: 'not_equal 2' }], vars) === true, 'not_equal 未命中')

  const cmd = parseCommand('motions disable tap触摸;motions enable tap摸头;change_cos model1.json')
  eq(cmd.disable.includes('tap触摸') && cmd.enable.includes('tap摸头') && cmd.changeCos === 'model1.json', 'parseCommand')

  const layered = new AuthorState({
    motions: {
      'idle': [
        { name: 'idle0', file: 'normal', var_floats: [{ name: '表情', type: 1, code: 'equal 0' }] },
        { name: 'idle8', file: '8', var_floats: [{ name: '表情', type: 1, code: 'equal 8' }] },
      ],
      'idle#1': [{ name: 'idle', file: 'normal' }],
      '切换表情': [{ name: '1', file: '1', var_floats: [{ name: '表情', type: 2, code: 'assign 8' }] }],
    },
  } as unknown as AuthorSpec)
  eq(JSON.stringify(layered.idleLayers()) === JSON.stringify(['normal', 'normal']), 'idleLayers 层0=normal 层1=normal')
  layered.play('切换表情:1')
  eq(JSON.stringify(layered.idleLayers()) === JSON.stringify(['8', 'normal']), '切表情后层0=8 层1=normal（身体不能没）')

  const cmd3 = parseCommand('motions enable leave_30_20_30')
  eq(cmd3.enable.length === 1 && cmd3.enable[0] === 'leave_30_20_30', 'parseCommand enable')
  const cmd4 = parseCommand('start_mtn leave_30_20_30')
  eq(cmd4.startMtn === 'leave_30_20_30', 'parseCommand start_mtn')

  const cmd2 = parseCommand('slot_opacities lock chenshan-4,chenshan-3,chenshan-2,chenshan-1 0')
  eq(cmd2.slotOpacity.length === 1 && cmd2.slotOpacity[0].ids.length === 4 && cmd2.slotOpacity[0].value === 0, 'parseCommand slot_opacities')

  const spec: AuthorSpec = {
    motions: {
      tap触摸: [
        { name: 'a', file: '5', text: 'A', motion_duration: 100, var_floats: [{ name: '触摸', type: 1, code: 'not_equal 1' }, { name: '触摸', type: 2, code: 'assign 1' }] },
        { name: 'b', file: '8', text: 'B', motion_duration: 200, var_floats: [{ name: '触摸', type: 1, code: 'not_equal 2' }, { name: '触摸', type: 2, code: 'assign 2' }] },
      ],
      idle: [{ name: 'idle0', file: 'normal', wrap_mode: 1 }, { name: 'idle1', file: '1', var_floats: [{ name: '表情', type: 1, code: 'equal 1' }] }],
      选项: [{ name: '选项', text: '选项', choices: [{ text: '台词鉴赏', next_mtn: '台词鉴赏:选项' }] }],
    },
  }
  const st = new AuthorState(spec)
  eq(JSON.stringify(st.idleLayers()) === JSON.stringify(['normal']), '待机默认 normal（单层）')
  const first = st.playGroup('tap触摸', () => 0)
  eq(first?.animation === '5', '第一条按 var 过滤后选中 a')
  eq(st.vars.触摸 === 1, 'assign 生效')
  const second = st.playGroup('tap触摸', () => 0)
  eq(second?.animation === '8', '不重复：轮到 b')
  const blocked = st.playGroup('选项')
  eq(blocked === undefined, '未实现的组不误触发')
  eq(st.menu('选项:选项')?.choices.length === 1, 'menu 解析')

  return errs
}
