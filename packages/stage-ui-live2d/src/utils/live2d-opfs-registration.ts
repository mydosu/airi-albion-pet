import { Live2DFactory, ZipLoader } from 'pixi-live2d-display/cubism4'

import { OPFSCache } from './opfs-loader'

// 阿尔比恩桌宠（本 fork）：中间件**保留**（它负责把 `{id, url}` 解包成 zip 交给 pixi），
// 但 opfs-loader 里那条「命中缓存」路径已被改道（见 opfs-loader.ts 的说明）：
// 命中时它把整包解压结果当 `File[]` 交给下游，而 pixi 的 ZipLoader 只认
// 「长度 1 且文件名 .zip 结尾的 File」→ 直接透传到 jsonToSettings → `Unknown settings format`。
// 我们本地只有一个模型，走每次 fetch 的路径最稳。
const ENABLE_OPFS_CACHE = true

if (ENABLE_OPFS_CACHE) {
  const zipLoaderIndex = Live2DFactory.live2DModelMiddlewares.indexOf(ZipLoader.factory)

  if (Live2DFactory.live2DModelMiddlewares.includes(OPFSCache.checkMiddleware)) {
    // Middlewares already registered.
  }
  else if (zipLoaderIndex !== -1) {
    // Insert Check before ZipLoader
    Live2DFactory.live2DModelMiddlewares.splice(zipLoaderIndex, 0, OPFSCache.checkMiddleware)
    // Insert Save after ZipLoader
    Live2DFactory.live2DModelMiddlewares.splice(zipLoaderIndex + 2, 0, OPFSCache.saveMiddleware)
  }
  else {
    console.warn('[OPFS] ZipLoader not found in middlewares, caching disabled')
  }
}
