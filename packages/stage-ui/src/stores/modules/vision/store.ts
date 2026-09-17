import type {} from 'pinia-plugin-synced'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useProviderStore } from '../../providers/provider'
import { ALBION_VISION_MODEL, ALBION_VISION_PROVIDER_ID } from '../../../albion-defaults'

export const useVisionStore = defineStore('vision', () => {
  const providersStore = useProviderStore()

  // Pinia synchronization owns live cross-window state. localStorage only
  // loads and saves durable values for this synchronized store.
  const persistenceOptions = { listenToStorageChanges: false }

  // 阿尔比恩桌宠：默认接上本机 Qwen2.5-VL（视觉）
  const activeProvider = useLocalStorageManualReset('settings/vision/active-provider', ALBION_VISION_PROVIDER_ID, persistenceOptions)
  const activeModel = useLocalStorageManualReset('settings/vision/active-model', ALBION_VISION_MODEL, persistenceOptions)
  const activeCustomModelName = useLocalStorageManualReset('settings/vision/active-custom-model', ALBION_VISION_MODEL, persistenceOptions)
  const ollamaThinkingEnabled = useLocalStorageManualReset('settings/vision/ollama-thinking-enabled', false, persistenceOptions)
  const modelSearchQuery = refManualReset('')

  const supportsModelListing = computed(() => {
    return providersStore.supportsModelListing(activeProvider.value)
  })

  const providerModels = computed(() => {
    if (!activeProvider.value)
      return []

    return providersStore.getModelsForProvider(activeProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    if (!activeProvider.value)
      return false

    return providersStore.isLoadingModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    if (!activeProvider.value)
      return null

    return providersStore.modelLoadError[activeProvider.value] || null
  })

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    modelSearchQuery.reset()
  }

  async function loadModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
  }

  return {
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    ollamaThinkingEnabled,
    modelSearchQuery,

    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    configured,

    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
}, {
  synced: {
    state: true,
  },
})
