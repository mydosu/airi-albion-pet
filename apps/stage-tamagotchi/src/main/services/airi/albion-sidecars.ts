// 阿尔比恩桌宠 · 本机语音模块（模块A）随壳自启
//
// 壳起来时顺手把三个本机服务拉起来（端口已在跑就跳过 → 和用户自己双击的 bat 幂等共存）：
//   :9889 Irodori 后端（5 船 TTS）   :9881 TTS 桥（含中文→日语翻译层）   :9882 耳朵（paraformer-zh）
// 退出时只杀「本进程拉起来的」那些，用户在别的窗口里跑的实例一律不碰。
//
// 路径可用环境变量覆盖（打包时要用）：ALBION_IRODORI_DIR / ALBION_EAR_DIR / ALBION_SIDECARS=0 关掉整套。

import type { ChildProcess } from 'node:child_process'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

import { app } from 'electron'

interface Sidecar {
  name: string
  port: number
  exe: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

/**
 * 目录解析顺序（先到先用）：
 *   1. 环境变量 ALBION_IRODORI_DIR / ALBION_EAR_DIR / ALBION_GSV_PYTHON
 *   2. 用户设置文件 <userData>/albion-sidecars.json（托盘「语音服务 → 打开配置文件」）
 *   3. 打包约定：<安装目录>/resources/sidecars/{irodori,ear}（绿色包把模型放这儿）
 *   4. 开发机默认路径
 * 模型体积太大（Irodori 12G + 耳朵 4G + runtime 7G）没法塞进安装包，所以走「约定目录 + 可配」。
 */
export interface SidecarDirs {
  irodoriDir: string
  earDir: string
  pythonExe: string
}

export function sidecarConfigPath(): string {
  return join(app.getPath('userData'), 'albion-sidecars.json')
}

export function readSidecarConfig(): Partial<SidecarDirs> {
  try {
    return JSON.parse(readFileSync(sidecarConfigPath(), 'utf8'))
  }
  catch {
    return {}
  }
}

export function writeSidecarConfig(patch: Partial<SidecarDirs>): string {
  const merged = { ...readSidecarConfig(), ...patch }
  const p = sidecarConfigPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8')
  return p
}

function bundledRoot(): string | undefined {
  if (!app.isPackaged)
    return undefined
  const root = join(process.resourcesPath, 'sidecars')
  return existsSync(root) ? root : undefined
}

export function sidecarDirs(): SidecarDirs {
  const cfg = readSidecarConfig()
  const bundled = bundledRoot()
  return {
    irodoriDir: process.env.ALBION_IRODORI_DIR || cfg.irodoriDir
      || (bundled && existsSync(join(bundled, 'irodori')) ? join(bundled, 'irodori') : 'D:/AI/Wife/tts/irodori'),
    earDir: process.env.ALBION_EAR_DIR || cfg.earDir
      || (bundled && existsSync(join(bundled, 'ear')) ? join(bundled, 'ear') : 'D:/AI/Wife/pet'),
    pythonExe: process.env.ALBION_GSV_PYTHON || cfg.pythonExe
      || 'D:/AI/Wife/tts/denia/runtime/python.exe',
  }
}

function sidecars(): Sidecar[] {
  const { irodoriDir: IRODORI_DIR, earDir: EAR_DIR, pythonExe: GSV_PY } = sidecarDirs()
  return [
    {
      name: 'Irodori 后端',
      port: 9889,
      exe: `${IRODORI_DIR}/.venv/Scripts/python.exe`,
      args: ['-u', 'irodori_serve.py'],
      cwd: IRODORI_DIR,
    },
    {
      name: 'TTS 桥',
      port: 9881,
      exe: `${IRODORI_DIR}/.venv/Scripts/python.exe`,
      args: ['-u', 'bridge.py'],
      cwd: IRODORI_DIR,
    },
    {
      name: '耳朵',
      port: 9882,
      exe: GSV_PY,
      args: ['whisper_serve.py'],
      cwd: EAR_DIR,
      env: {
        ALBION_STT_ENGINE: 'paraformer',
        ALBION_FUNASR_ROOT: `${EAR_DIR}/models/modelscope/iic`,
        ALBION_STT_PORT: '9882',
      },
    },
  ]
}

function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

const spawned: ChildProcess[] = []

export async function startAlbionSidecars(log: Console = console): Promise<void> {
  if (process.env.ALBION_SIDECARS === '0')
    return

  for (const s of sidecars()) {
    if (await portOpen(s.port)) {
      log.info(`[albion-sidecars] ${s.name} 已在跑（:${s.port}），跳过`)
      continue
    }
    if (!existsSync(s.exe)) {
      log.warn(`[albion-sidecars] ${s.name} 起不来：找不到解释器 ${s.exe}（可用 ALBION_IRODORI_DIR / ALBION_EAR_DIR 覆盖）`)
      continue
    }
    try {
      const child = spawn(s.exe, s.args, {
        cwd: s.cwd,
        env: { ...process.env, ...s.env },
        windowsHide: true,
        stdio: 'ignore',
      })
      child.on('exit', code => log.info(`[albion-sidecars] ${s.name} 退出 code=${code}`))
      spawned.push(child)
      log.info(`[albion-sidecars] 启动 ${s.name}（:${s.port}）pid=${child.pid}`)
    }
    catch (err) {
      log.warn(`[albion-sidecars] ${s.name} 启动失败：${err}`)
    }
  }
}

/** 三个服务的在跑状态（端口在听就算就绪）——给托盘菜单显示用 */
export async function sidecarStatus(): Promise<Array<{ name: string, port: number, up: boolean }>> {
  const out: Array<{ name: string, port: number, up: boolean }> = []
  for (const s of sidecars())
    out.push({ name: s.name, port: s.port, up: await portOpen(s.port) })
  return out
}

export function stopAlbionSidecars(): void {
  for (const child of spawned) {
    try {
      child.kill()
    }
    catch {}
  }
  spawned.length = 0
}
