<script setup lang="ts">
import { Screen } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { onUnmounted, ref, watch } from 'vue'

import SpineCanvas from './spine/Canvas.vue'
import Spine38Model from './spine38/Model.vue'

// Spine 3.8 场景：结构与 4.x 的 scenes/Spine.vue 一致，便于 Stage 用同一种方式
// 接管（canvasElement / setEmotion / listAnimations）。Canvas 组件与渲染器无关，
// 直接复用；Model 换成 3.8 那份独立实现。

withDefaults(defineProps<{
  modelSrc?: string
  modelId?: string
  paused?: boolean
  premultipliedAlpha?: boolean
  idleAnimationEnabled?: boolean
}>(), {
  paused: false,
  premultipliedAlpha: true,
  idleAnimationEnabled: true,
})

// 分辨率：模块化 Pixi 的 canvas 默认是 1:1 像素比，在高分屏上会发虚。
// Live2D 那条路用 2 倍缓冲（实测它的 canvas 是 1894×1646，正好 2 倍），这里给
// 独立键、同样默认 2 倍 —— 不借用 4.x 的 settings/spine/render-scale。
const renderScale = useLocalStorage('settings/spine38/render-scale', 2)

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })
const componentStateCanvas = defineModel<'pending' | 'loading' | 'mounted'>('canvasState', { default: 'pending' })
const componentStateModel = defineModel<'pending' | 'loading' | 'mounted'>('modelState', { default: 'pending' })

const canvasRef = ref<InstanceType<typeof SpineCanvas>>()
const modelRef = ref<InstanceType<typeof Spine38Model>>()

// 作者交互的可见部分：台词气泡与选项菜单。
// 数据全部来自 modelN.json（motions[*].text / choices），这里只负责画出来。
const bubbleText = ref('')
const menuData = ref<{ title: string, choices: { text: string, next_mtn: string }[] }>()

watch(modelRef, () => {
  syncAuthorUi()
})

// defineExpose 暴露的 ref 会被 Vue 解包成普通值，所以每 120ms 同步一次状态。
// 比在子组件里 emit 简单，且不影响渲染性能（只是读两个字段）。
const authorUiTimer = setInterval(syncAuthorUi, 120)
onUnmounted(() => clearInterval(authorUiTimer))
syncAuthorUi()

function syncAuthorUi() {
  const exposed = modelRef.value as unknown as {
    bubble?: string
    menu?: { title: string, choices: { text: string, next_mtn: string }[] }
  } | undefined
  bubbleText.value = exposed?.bubble ?? ''
  menuData.value = exposed?.menu
}

function choose(index: number) {
  (modelRef.value as unknown as { choose?: (i: number) => void } | undefined)?.choose?.(index)
}

// immediate + flush:'post'：Canvas 的 initCanvas 是同步把状态推到 mounted 的，
// 不带 immediate 的 watch 会错过这次变化，外壳的 loading 遮罩就一直不消失。
watch([componentStateModel, componentStateCanvas], () => {
  componentState.value = (componentStateModel.value === 'mounted' && componentStateCanvas.value === 'mounted')
    ? 'mounted'
    : 'loading'
}, { immediate: true, flush: 'post' })

defineExpose({
  canvasElement: () => canvasRef.value?.canvasElement(),
  captureFrame: () => canvasRef.value?.captureFrame(),
  setEmotion: (emotion: string, intensity?: number) => modelRef.value?.setEmotion(emotion, intensity),
  listAnimations: () => modelRef.value?.listAnimations() ?? [],
  listSkins: () => modelRef.value?.listSkins() ?? [],
  skeletonVersion: () => modelRef.value?.skeletonVersion() ?? '',
})
</script>

<template>
  <Screen v-slot="{ width, height }" relative>
    <SpineCanvas
      ref="canvasRef"
      v-slot="{ canvas }"
      v-model:state="componentStateCanvas"
      :width="width"
      :height="height"
      :resolution="renderScale"
      max-h="100dvh"
    >
      <Spine38Model
        ref="modelRef"
        v-model:state="componentStateModel"
        :model-src="modelSrc"
        :model-id="modelId"
        :canvas="canvas"
        :width="width"
        :height="height"
        :resolution="renderScale"
        :paused="paused"
        :premultiplied-alpha="premultipliedAlpha"
        :idle-animation-enabled="idleAnimationEnabled"
      />
    </SpineCanvas>

    <!-- 台词气泡（作者 motions[*].text） -->
    <div
      v-if="bubbleText"
      class="pointer-events-none absolute bottom-8 left-1/2 max-w-[72%] rounded-2xl px-5 py-3 text-sm text-white leading-relaxed shadow-lg backdrop-blur-sm -translate-x-1/2"
      style="z-index: 30; background: rgba(0,0,0,0.62);"
    >
      {{ bubbleText }}
    </div>

    <!-- 选项菜单（作者 motions[*].choices → next_mtn） -->
    <div
      v-if="menuData"
      class="absolute right-6 top-6 max-h-[70dvh] w-56 flex flex-col gap-1 overflow-y-auto rounded-2xl p-3 shadow-xl backdrop-blur-sm"
      style="z-index: 30; background: rgba(0,0,0,0.72);"
    >
      <div class="mb-1 px-1 text-xs text-white/60">
        {{ menuData.title }}
      </div>
      <button
        v-for="(c, i) in menuData.choices"
        :key="i"
        class="rounded-lg px-3 py-2 text-left text-sm text-white/90 transition-colors hover:bg-white/15"
        @click="choose(i)"
      >
        {{ c.text }}
      </button>
    </div>
  </Screen>
</template>
