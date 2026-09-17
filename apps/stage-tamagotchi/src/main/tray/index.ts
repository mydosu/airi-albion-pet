import type { LocaleDetector } from '@intlify/core'
import type { BrowserWindow, Rectangle } from 'electron'

import type { I18n } from '../libs/i18n'
import type { ServerChannel } from '../services/airi/channel-server'
import type { setupBeatSync } from '../windows/beat-sync'
import type { setupCaptionWindowManager } from '../windows/caption'
import type { ChatboxWindowManager } from '../windows/chatbox'
import type { SettingsWindowManager } from '../windows/settings'
import type { WidgetsWindowManager } from '../windows/widgets'

import { readFileSync, writeFileSync } from 'node:fs'
import { env } from 'node:process'

import { is } from '@electron-toolkit/utils'
import { isRendererUnavailable } from '@proj-airi/electron-vueuse/main'
import { effect } from 'alien-signals'
import { app, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { debounce, once } from 'es-toolkit'
import { isMacOS } from 'std-env'

import icon from '../../../resources/icon.png?asset'
import macOSTrayIcon from '../../../resources/tray-icon-macos.png?asset'

import { findDominantDisplayArea } from '../../shared/utils/electron/display'
import { onAppBeforeQuit } from '../libs/bootkit/lifecycle'
import { sidecarConfigPath, sidecarStatus, startAlbionSidecars, writeSidecarConfig } from '../services/airi/albion-sidecars'
import { setupInlayWindow } from '../windows/inlay'
import { Animator } from '../windows/shared/animator'
import { computeResizedBoundsAnchoredToDominantDisplay } from '../windows/shared/display'
import { toggleWindowShow } from '../windows/shared/window'

// 指挥官 2026-09-17 定稿的窗口大小（托盘的"推荐"用它）
/** 语音服务（sidecar）最近一次探测到的状态，菜单构建时同步读取 */
let sidecarUp: Record<number, boolean> = {}

/** Live2D 阿尔比恩（命中区校准就是按它的推荐尺寸来的） */
const LIVE2D_ALBION_MODEL_ID = 'preset-live2d-albion'

const RECOMMENDED_WIDTH = 964
const RECOMMENDED_HEIGHT = 799
/** 推荐窗口的屏幕位置（"对齐到 → 推荐"用） */
const RECOMMENDED_X = 1
const RECOMMENDED_Y = 6

/** 推荐布局的默认值（指挥官定稿那一刻）；托盘点「把当前布局存为推荐」后以存下来的为准 */
const RECOMMENDED_DEFAULT = {
  width: RECOMMENDED_WIDTH,
  height: RECOMMENDED_HEIGHT,
  x: RECOMMENDED_X,
  y: RECOMMENDED_Y,
  scale: '1.3',
  position: '{"x":-1,"y":46}',
}
interface RecommendedView { width: number, height: number, x: number, y: number, scale: string, position: string }

/** Spine 3.8 阿尔比恩（晨光）：它自己的一套推荐布局，跟 Live2D 那套分开存（指挥官 2026-09-17） */
const SPINE_ALBION_MODEL_ID = 'preset-spine38-albion'
type RecommendedKind = 'live2d' | 'spine'
const RECOMMENDED_SPINE_DEFAULT: RecommendedView = {
  width: 963,
  height: 803,
  x: -2,
  y: 2,
  scale: '0.7026',
  position: '{"x":788.5999755859375,"y":1635.8000793457031}',
}
/** 顺高 / 半高 这两个选项沿用原来的竖版比例（450:600），不要跟着推荐尺寸变大 */
const ASPECT_RATIO = 450 / 600

function applyWindowSize(window: BrowserWindow, width: number, height: number, x?: number, y?: number): void {
  if (isRendererUnavailable(window)) {
    return
  }

  window.setResizable(true)

  const bounds = x !== undefined && y !== undefined
    ? {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      }
    : computeResizedBoundsAnchoredToDominantDisplay({
        currentBounds: window.getBounds(),
        targetSize: { width, height },
        displays: screen.getAllDisplays(),
      })

  window.setBounds(bounds)
  window.show()
}

function resolveAlignedWindowBounds(
  window: BrowserWindow,
  workArea: Rectangle,
  position: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
): Rectangle {
  const { width: windowWidth, height: windowHeight } = window.getBounds()
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = workArea

  let x = areaX
  let y = areaY

  switch (position) {
    case 'center':
      x = areaX + Math.floor((areaWidth - windowWidth) / 2)
      y = areaY + Math.floor((areaHeight - windowHeight) / 2)
      break
    case 'top-left':
      break
    case 'top-right':
      x = areaX + areaWidth - windowWidth
      break
    case 'bottom-left':
      y = areaY + areaHeight - windowHeight
      break
    case 'bottom-right':
      x = areaX + areaWidth - windowWidth
      y = areaY + areaHeight - windowHeight
      break
  }

  return { x, y, width: windowWidth, height: windowHeight }
}

function isSizeMatch(window: BrowserWindow, targetWidth: number, targetHeight: number): boolean {
  const { width, height } = window.getBounds()
  return Math.abs(width - Math.round(targetWidth)) <= 2 && Math.abs(height - Math.round(targetHeight)) <= 2
}

function isPositionMatch(window: BrowserWindow, targetX: number, targetY: number): boolean {
  const { x, y } = window.getBounds()
  return Math.abs(x - targetX) <= 5 && Math.abs(y - targetY) <= 5
}

export function setupTray(params: {
  mainWindow: BrowserWindow
  settingsWindow: SettingsWindowManager
  captionWindow: ReturnType<typeof setupCaptionWindowManager>
  chatboxWindow: ChatboxWindowManager
  widgetsWindow: WidgetsWindowManager
  beatSyncBgWindow: Awaited<ReturnType<typeof setupBeatSync>>
  aboutWindow: () => Promise<BrowserWindow>
  serverChannel: ServerChannel
  i18n: I18n
}): void {
  once(() => {
    const mainWindowAnimator = new Animator(params.mainWindow)

    function animateMainWindowTo(workArea: Rectangle, position: Parameters<typeof resolveAlignedWindowBounds>[2]) {
      const bounds = resolveAlignedWindowBounds(params.mainWindow, workArea, position)
      mainWindowAnimator.windowBoundsAnimateTo(bounds)
      params.mainWindow.show()
    }

    function applyMainWindowSize(width: number, height: number, x?: number, y?: number) {
      mainWindowAnimator.stop()
      applyWindowSize(params.mainWindow, width, height, x, y)
    }

    /** 模型视图要写哪几个 localStorage 键：live2d 用 scale+position，spine（晨光）用 scale+x/y */
    function recommendedModelPairs(kind: RecommendedKind, scale: string, position: string): Array<[string, string]> {
      if (kind === 'spine') {
        let p: { x?: number, y?: number } = {}
        try {
          p = JSON.parse(position || '{}')
        }
        catch {}
        return [
          ['settings/spine38/scale', String(scale)],
          ['settings/spine38/x', String(p.x ?? 0)],
          ['settings/spine38/y', String(p.y ?? 0)],
        ]
      }
      return [['settings/live2d/scale', String(scale)], ['settings/live2d/position', String(position)]]
    }

    function applyRecommendedModelView(scale = RECOMMENDED_DEFAULT.scale, position = RECOMMENDED_DEFAULT.position, kind: RecommendedKind = 'live2d') {
      const pairs = recommendedModelPairs(kind, scale, position)
      params.mainWindow.webContents
        .executeJavaScript(`(() => {
          try {
            const pairs = ${JSON.stringify(pairs)}
            for (const [k, v] of pairs)
              localStorage.setItem(k, v)
            // vueuse 的 useLocalStorage 监听 storage 事件，同窗口写入不会自动触发 → 手工派发一次
            for (const [k, v] of pairs)
              window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: v, storageArea: localStorage }))
          }
          catch {}
        })()`)
        .catch(() => {})
    }

    /**
     * 推荐布局存这儿（userData 下）；没存过就用内置默认。
     *  两套分开：live2d = recommended-view.json，spine（晨光）= recommended-view-spine.json
     */
    const recommendedFileOf = (kind: RecommendedKind) =>
      `${app.getPath('userData')}/recommended-view${kind === 'spine' ? '-spine' : ''}.json`
    const recommendedDefaultOf = (kind: RecommendedKind) =>
      (kind === 'spine' ? RECOMMENDED_SPINE_DEFAULT : RECOMMENDED_DEFAULT)
    function readRecommended(kind: RecommendedKind = 'live2d'): RecommendedView {
      try {
        const raw = JSON.parse(readFileSync(recommendedFileOf(kind), 'utf8')) as Partial<RecommendedView>
        return { ...recommendedDefaultOf(kind), ...raw }
      }
      catch {
        return { ...recommendedDefaultOf(kind) }
      }
    }

    /**
     * 把"此刻的布局"存为推荐：窗口大小/位置取窗口实际值，模型缩放/位置取渲染进程的 localStorage。
     *  kind='spine' 时存的是 Spine（晨光）那一套：settings/spine38/scale 与 spine38/x|y。
     */
    async function saveCurrentAsRecommended(kind: RecommendedKind = 'live2d') {
      const b = params.mainWindow.getBounds()
      const dft = recommendedDefaultOf(kind)
      let scale = dft.scale
      let position = dft.position
      try {
        const js = kind === 'spine'
          ? `({ scale: localStorage.getItem('settings/spine38/scale'), x: localStorage.getItem('settings/spine38/x'), y: localStorage.getItem('settings/spine38/y') })`
          : `({ scale: localStorage.getItem('settings/live2d/scale'), position: localStorage.getItem('settings/live2d/position') })`
        const v = await params.mainWindow.webContents.executeJavaScript(js) as Record<string, string | null> | null
        if (v?.scale)
          scale = String(v.scale)
        if (kind === 'spine')
          position = JSON.stringify({ x: Number(v?.x ?? 0), y: Number(v?.y ?? 0) })
        else if (v?.position)
          position = String(v.position)
      }
      catch {}
      const view: RecommendedView = { width: b.width, height: b.height, x: b.x, y: b.y, scale, position }
      try {
        writeFileSync(recommendedFileOf(kind), JSON.stringify(view, null, 2), 'utf8')
      }
      catch (e) {
        console.warn('[tray] 写推荐布局失败', e)
        return
      }
      const text = `${kind === 'spine' ? '（晨光）' : ''}${b.width}×${b.height} @ (${b.x}, ${b.y})　模型 ${scale} / ${position}`
      console.info('[tray] 已存为推荐：', text)
      try {
        // eslint-disable-next-line ts/no-use-before-define -- 定义在后面，但这段只在菜单点击后执行
        appTray.displayBalloon({ title: kind === 'spine' ? '推荐布局（晨光）已保存' : '推荐布局已保存', content: text })
      }
      catch {}
      // eslint-disable-next-line ts/no-use-before-define -- 同上，此刻菜单早已构建完成
      rebuildContextMenu()
    }

    /** 推荐：窗口大小 + 屏幕位置 + 模型缩放/位置 一起恢复（按模型种类取各自那套） */
    function applyRecommendedView(withPosition = false, kind: RecommendedKind = 'live2d') {
      const rec = readRecommended(kind)
      if (withPosition)
        applyMainWindowSize(rec.width, rec.height, rec.x, rec.y)
      else
        applyMainWindowSize(rec.width, rec.height)
      applyRecommendedModelView(rec.scale, rec.position, kind)
    }

    // 指挥官 2026-09-17：Live2D 那个模型一开启就自动套用「推荐」布局。
    // 交互命中区是按推荐尺寸校准的，窗口大小一变就会偏，所以模型切到它时把窗口拉回推荐尺寸。
    let lastStageModelId: string | null = null
    setInterval(async () => {
      if (isRendererUnavailable(params.mainWindow))
        return
      try {
        const id = await params.mainWindow.webContents.executeJavaScript(
          `localStorage.getItem('settings/stage/model')`,
        ) as string | null
        if (id === lastStageModelId)
          return
        lastStageModelId = id
        if (id === LIVE2D_ALBION_MODEL_ID) {
          console.info('[tray] 检测到 Live2D 模型已开启，自动套用推荐布局')
          applyRecommendedView(true, 'live2d')
        }
        else if (id === SPINE_ALBION_MODEL_ID) {
          console.info('[tray] 检测到 Spine（晨光）模型已开启，自动套用推荐布局（晨光）')
          applyRecommendedView(true, 'spine')
        }
      }
      catch {}
    }, 2000)

    const trayImage = nativeImage.createFromPath(isMacOS ? macOSTrayIcon : icon).resize({ width: 16 })
    trayImage.setTemplateImage(isMacOS)

    const appTray = new Tray(trayImage)

    const rebuildContextMenu = debounce((): void => {
      if (isRendererUnavailable(params.mainWindow)) {
        return
      }

      const mainWindowBounds = params.mainWindow.getBounds()
      const rec = readRecommended('live2d')
      const recSpine = readRecommended('spine')
      const currentDisplay = findDominantDisplayArea(mainWindowBounds, screen.getAllDisplays()) ?? screen.getDisplayMatching(mainWindowBounds)
      const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = currentDisplay.workArea
      const { width: windowWidth, height: windowHeight } = mainWindowBounds

      const fullHeightTarget = areaHeight
      const fullWidthTarget = Math.floor(areaHeight * ASPECT_RATIO)
      const halfHeightTarget = Math.floor(areaHeight / 2)
      const halfWidthTarget = Math.floor(halfHeightTarget * ASPECT_RATIO)

      const contextMenu = Menu.buildFromTemplate([
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.show'), click: () => toggleWindowShow(params.mainWindow) },
        { type: 'separator' },
        {
          label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.adjust_sizes'),
          submenu: [
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.recommended_size'),
              type: 'checkbox',
              checked: isSizeMatch(params.mainWindow, rec.width, rec.height),
              click: () => applyRecommendedView(false, 'live2d'),
            },
            {
              label: '推荐（晨光）',
              type: 'checkbox',
              checked: isSizeMatch(params.mainWindow, recSpine.width, recSpine.height),
              click: () => applyRecommendedView(false, 'spine'),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.full_height'),
              type: 'checkbox',
              checked: isSizeMatch(params.mainWindow, fullWidthTarget, fullHeightTarget),
              click: () => applyMainWindowSize(fullWidthTarget, fullHeightTarget),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.half_height'),
              type: 'checkbox',
              checked: isSizeMatch(params.mainWindow, halfWidthTarget, halfHeightTarget),
              click: () => applyMainWindowSize(halfWidthTarget, halfHeightTarget),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.full_screen'),
              type: 'checkbox',
              checked: isSizeMatch(params.mainWindow, areaWidth, areaHeight),
              click: () => applyMainWindowSize(areaWidth, areaHeight, areaX, areaY),
            },
          ],
        },
        {
          label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.align_to'),
          submenu: [
            {
              label: '推荐',
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, rec.x, rec.y),
              click: () => applyRecommendedView(true, 'live2d'),
            },
            {
              label: '推荐（晨光）',
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, recSpine.x, recSpine.y),
              click: () => applyRecommendedView(true, 'spine'),
            },
            { type: 'separator' },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.center'),
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, areaX + Math.floor((areaWidth - windowWidth) / 2), areaY + Math.floor((areaHeight - windowHeight) / 2)),
              click: () => animateMainWindowTo(currentDisplay.workArea, 'center'),
            },
            { type: 'separator' },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.top_left'),
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, areaX, areaY),
              click: () => animateMainWindowTo(currentDisplay.workArea, 'top-left'),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.top_right'),
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, areaX + areaWidth - windowWidth, areaY),
              click: () => animateMainWindowTo(currentDisplay.workArea, 'top-right'),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.bottom_left'),
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, areaX, areaY + areaHeight - windowHeight),
              click: () => animateMainWindowTo(currentDisplay.workArea, 'bottom-left'),
            },
            {
              label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.bottom_right'),
              type: 'checkbox',
              checked: isPositionMatch(params.mainWindow, areaX + areaWidth - windowWidth, areaY + areaHeight - windowHeight),
              click: () => animateMainWindowTo(currentDisplay.workArea, 'bottom-right'),
            },
          ],
        },
        { type: 'separator' },
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.settings'), click: () => void params.settingsWindow.openWindow('/settings') },
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.about'), click: () => params.aboutWindow().then(window => toggleWindowShow(window)) },
        { type: 'separator' },
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.open_inlay'), click: () => setupInlayWindow({ i18n: params.i18n, serverChannel: params.serverChannel }) },
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.open_widgets'), click: () => params.widgetsWindow.getWindow().then(window => toggleWindowShow(window)) },
        {
          label: params.i18n.t(params.captionWindow.isVisible()
            ? 'tamagotchi.electron.tray.menu.labels.label.close_caption'
            : 'tamagotchi.electron.tray.menu.labels.label.open_caption'),
          click: () => {
            void params.captionWindow.toggleVisibility().then(() => rebuildContextMenu())
          },
        },
        {
          type: 'submenu',
          label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.caption_overlay'),
          submenu: Menu.buildFromTemplate([
            { type: 'checkbox', label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.follow_window'), checked: params.captionWindow.getIsFollowingWindow(), click: async menuItem => await params.captionWindow.setFollowWindow(Boolean(menuItem.checked)) },
            { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.reset_position'), click: async () => await params.captionWindow.resetToSide() },
          ]),
        },
        {
          // fork 新增：消息框（i18n 词典先不动，只有中文界面用得上）
          label: '消息框',
          click: () => {
            void params.chatboxWindow.toggleVisibility().then(() => rebuildContextMenu())
          },
        },
        { type: 'separator' },
        { label: '把当前布局存为推荐', click: () => { void saveCurrentAsRecommended('live2d') } },
        { label: '把当前布局存为推荐（晨光）', click: () => { void saveCurrentAsRecommended('spine') } },
        {
          label: '语音服务',
          submenu: [
            { label: `Irodori 后端 :9889  ${sidecarUp[9889] ? '就绪' : '未就绪'}`, enabled: false },
            { label: `TTS 桥 :9881  ${sidecarUp[9881] ? '就绪' : '未就绪'}`, enabled: false },
            { label: `耳·STT :9882  ${sidecarUp[9882] ? '就绪' : '未就绪'}`, enabled: false },
            { type: 'separator' },
            { label: '重新拉起语音服务', click: () => { void startAlbionSidecars() } },
            {
              label: '打开 sidecar 配置（模型目录）',
              click: () => {
                writeSidecarConfig({})
                void shell.openPath(sidecarConfigPath())
              },
            },
          ],
        },
        ...is.dev || env.MAIN_APP_DEBUG || env.APP_DEBUG
          ? [
              { type: 'header', label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.devtools') },
              { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.troubleshoot_beatsync'), click: () => params.beatSyncBgWindow.webContents.openDevTools({ mode: 'detach' }) },
              { type: 'separator' },
            ] as const
          : [],
        { label: params.i18n.t('tamagotchi.electron.tray.menu.labels.label.quit'), click: () => app.quit() },
      ])

      appTray.setContextMenu(contextMenu)
    }, 50)

    params.mainWindow.on('resize', rebuildContextMenu)
    params.mainWindow.on('move', rebuildContextMenu)
    const visibilityChangeUnListener = params.captionWindow.onVisibilityChanged(rebuildContextMenu)

    // 语音服务状态：每 5 秒探一次端口，状态变了重建菜单（托盘菜单是静态的，只能重建）
    const refreshSidecar = async (): Promise<void> => {
      const next: Record<number, boolean> = {}
      for (const s of await sidecarStatus())
        next[s.port] = s.up
      const changed = JSON.stringify(next) !== JSON.stringify(sidecarUp)
      sidecarUp = next
      if (changed)
        rebuildContextMenu()
    }
    const sidecarTimer = setInterval(() => void refreshSidecar(), 5000)
    void refreshSidecar()

    rebuildContextMenu()

    // 指挥官 2026-09-17：壳一启动就把字幕窗打开，不用再手动点托盘。
    // 之后想关还是从托盘那一项关（关掉后这次运行不会再自动弹回来）。
    if (!params.captionWindow.isVisible())
      params.captionWindow.toggleVisibility()

    // 指挥官 2026-09-17：消息框（我们自己写的那条小对话条）也一起开。
    void params.chatboxWindow.isVisible().then((visible) => {
      if (!visible)
        void params.chatboxWindow.toggleVisibility()
    })

    const stopLocaleEffect = effect(() => {
      const locale = params.i18n.locale as (() => string | LocaleDetector<any[]> | undefined)
      locale()
      rebuildContextMenu()
    })

    onAppBeforeQuit(() => {
      // Stop every menu rebuild source before canceling its pending trailing call.
      // The tray must remain alive until no callback can reach it.
      params.mainWindow.off('resize', rebuildContextMenu)
      params.mainWindow.off('move', rebuildContextMenu)

      visibilityChangeUnListener()
      stopLocaleEffect()

      clearInterval(sidecarTimer)
      rebuildContextMenu.cancel()
      mainWindowAnimator.stop()

      appTray.destroy()
    })

    appTray.setToolTip('Project AIRI')
    appTray.addListener('click', () => toggleWindowShow(params.mainWindow))

    // On macOS, there's a special double-click event
    if (isMacOS) {
      appTray.addListener('double-click', () => toggleWindowShow(params.mainWindow))
    }
  })()
}
