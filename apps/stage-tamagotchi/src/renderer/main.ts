import type { Plugin } from 'vue'
import type { RouteRecordRaw } from 'vue-router'

import Tres from '@tresjs/core'

import { autoAnimatePlugin } from '@formkit/auto-animate/vue'
import { PiniaColada } from '@pinia/colada'
import { applyAlbionDefaults } from '@proj-airi/stage-ui/albion-defaults'
import { startAlbionPetInteractions } from '@proj-airi/stage-ui/albion-pet'
import { trackButtonPlugin } from '@proj-airi/stage-ui/directives/track-button'
import { configureAnalyticsAdapter } from '@proj-airi/stage-ui/libs/analytics'
import { browserAuthorizationHandler, registerAuthorizationHandler } from '@proj-airi/stage-ui/libs/auth'
import { piniaPluginTracing, setupSynced } from '@proj-airi/stage-ui/libs/pinia'
import { MotionPlugin } from '@vueuse/motion'
import { createPinia } from 'pinia'
import { setupLayouts } from 'virtual:generated-layouts'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { handleHotUpdate, routes } from 'vue-router/auto-routes'

import App from './App.vue'

import { i18n } from './modules/i18n'
import { resolveRendererWindowContext } from './window-context'

import '@unocss/reset/tailwind.css'
import 'splitpanes/dist/splitpanes.css'
import 'vue-sonner/style.css'
import './styles/main.css'
import 'uno.css'
// Fonts
import '@proj-airi/font-cjkfonts-allseto/index.css'
import '@proj-airi/font-xiaolai/index.css'
import '@fontsource-variable/dm-sans/index.css'
import '@fontsource-variable/jura/index.css'
import '@fontsource-variable/quicksand/index.css'
import '@fontsource-variable/urbanist/index.css'
import '@fontsource-variable/comfortaa/index.css'
import '@fontsource/dm-mono/index.css'
import '@fontsource/dm-serif-display/index.css'
import '@fontsource/gugi/index.css'
import '@fontsource/kiwi-maru/index.css'
import '@fontsource/m-plus-rounded-1c/index.css'
import '@fontsource-variable/nunito/index.css'

configureAnalyticsAdapter(async (options) => {
  const { createPosthogAdapter } = await import('@proj-airi/stage-ui/libs/analytics/posthog')
  return createPosthogAdapter(options)
})
registerAuthorizationHandler(browserAuthorizationHandler)

// 本机默认配置（Hermes 脑子 / Irodori 嘴 / 阿尔比恩形象），必须在 Pinia store 首次读取前写入
applyAlbionDefaults()

const pinia = createPinia()
const synced = setupSynced({
  leadership: resolveRendererWindowContext().leadership,
})
pinia.use(synced.pinia)
if (import.meta.env.DEV)
  pinia.use(piniaPluginTracing)

const router = createRouter({
  history: createWebHashHistory(),
  // TODO: vite-plugin-vue-layouts is long deprecated, replace with another layout solution
  routes: setupLayouts(routes as RouteRecordRaw[]),
})

if (import.meta.hot) {
  handleHotUpdate(router, (updatedRoutes) => {
    router.clearRoutes()
    for (const route of setupLayouts(updatedRoutes))
      router.addRoute(route)
  })
}

createApp(App)
  .use(synced.vue)
  .use(MotionPlugin)
  // TODO: Fix autoAnimatePlugin type error
  .use(autoAnimatePlugin as unknown as Plugin)
  .use(router)
  .use(pinia)
  .use(PiniaColada)
  .use(i18n)
  .use(Tres)
  .use(trackButtonPlugin)
  .mount('#app')

// 阿尔比恩互动层：触摸反馈 / 情绪表情 / 主动说话
// 只有 leader 窗口跑：这个函数里带"主动开口 / 取画面"这类**对外副作用**，
// 而所有窗口共用同一个远端会话 —— 每个窗口各跑一份会各取一张画面（一次 [[LOOK]] 变三张，
// 2026-09-18 实测：主窗 + 字幕窗 + minimal 三个实例各发一张，被单线程 VLM 排队成三张）。
// ponytail: 只在启动时判一次 leader，不做换届跟随；多窗口换届是罕见路径，真遇到再补 onLeadershipChange。
// 直接读 query，不走 resolveRendererWindowContext —— 它在缺参数时会 throw，挂在这里会连累渲染进程。
if (new URLSearchParams(window.location.search).get('synced-leader') === 'true')
  startAlbionPetInteractions()
