<script setup lang="ts">
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { onMounted, ref, useTemplateRef } from 'vue'

/**
 * 消息框（我们 fork 新增）：一条半透明小横条。
 * 只管打字 + 发送，字幕/回话显示都在别的窗口，互不干扰。
 */
const chat = useChatStore()
const session = useChatSessionStore()
const draft = ref('')
const sending = ref(false)
const input = useTemplateRef<HTMLInputElement>('input')

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value)
    return
  draft.value = ''
  sending.value = true
  try {
    await session.initialize()
    await chat.send({ sessionId: session.activeSessionId, text })
  }
  catch (err) {
    console.warn('[chatbox] 发送失败', err)
  }
  finally {
    sending.value = false
    input.value?.focus()
  }
}

onMounted(() => {
  input.value?.focus()
})
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-1">
    <form
      class="[-webkit-app-region:drag] h-full w-full flex cursor-move items-center gap-2 rounded-2xl bg-white/55 px-3 ring-1 ring-white/50 backdrop-blur-md"
      @submit.prevent="send"
    >
      <!-- 整条框都是拖拽区，除了输入框和按钮（见下面的 no-drag） -->
      <div class="h-4 w-[3px] shrink-0 rounded-full bg-neutral-500/45" title="拖我移动" />

      <input
        ref="input"
        v-model="draft"
        class="[-webkit-app-region:no-drag] min-w-0 flex-1 bg-transparent text-[0.9rem] text-neutral-800 outline-none placeholder:text-neutral-500"
        placeholder="和阿尔比恩说句话…"
      >

      <button
        type="submit"
        class="[-webkit-app-region:no-drag] shrink-0 rounded-lg bg-neutral-800/75 px-3 py-1 text-[0.8rem] text-neutral-50 disabled:opacity-40"
        :disabled="!draft.trim() || sending"
      >
        发送
      </button>
    </form>
  </div>
</template>

<style scoped>
</style>

<route lang="yaml">
meta:
  layout: stage
</route>
