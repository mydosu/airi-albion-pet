import type { MaybeRefOrGetter } from 'vue'

import { isStageWeb } from '@proj-airi/stage-shared'
import { breakpointsTailwind, useBreakpoints } from '@vueuse/core'
import { computed, toValue } from 'vue'

const breakpoints = useBreakpoints(breakpointsTailwind)
const startingOffsetY = computed(() => {
  if (isStageWeb()) // showing upper half of the body in landscape, 3/4 in portrait, in web targets
    return breakpoints.smallerOrEqual('md').value ? 0.75 : 1
  return 1 // 桌面桌宠：原点（画布左下）贴窗口底边
})

/**
 * 放大倍数：web 端沿用上游 2×（只露上半身是那边的设计）；
 * **桌面桌宠端用 1×** —— 我们的模型是一整张插画（人物+背景同画布），
 * 2× 会把画布裁掉一半，怎么拖都只看到半身。1× = 整张画布刚好铺进窗口（≈全身）。
 */
const fitMultiplier = computed(() => (isStageWeb() ? 2 : 1))

/**
 *  Normalizes the model so that user `scale == 1` means the fitted size
 *  (web: twice the viewport height; desktop pet: exactly the viewport),
 *  and the model centered horizontally when `position.x == 0`
 */
export function useFitModel(
  canvasDim: MaybeRefOrGetter<{ width: number, height: number }>,
  modelDim: MaybeRefOrGetter<{ width: number, height: number }>,
) {
  const normalizedParam = computed(() => {
    const canvas = toValue(canvasDim)
    const model = toValue(modelDim)

    const heightScale = (canvas.height / model.height * fitMultiplier.value)
    const widthScale = (canvas.width / model.width * fitMultiplier.value)
    let minScale = Math.min(heightScale, widthScale)

    if (Number.isNaN(minScale) || minScale <= 0) {
      minScale = 1e-6
    }
    return {
      scale: minScale,
      x: canvas.width / 2,
      y: canvas.height * startingOffsetY.value,
    }
  })

  return normalizedParam
}
