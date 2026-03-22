import { Store } from '@tauri-apps/plugin-store'
import { readDir, readTextFile, DirEntry, BaseDirectory } from '@tauri-apps/plugin-fs'
import { getWorkspacePath, getFilePathOptions } from '@/lib/workspace'
import { getSyncRepoName } from './repo-utils'
import { getRemoteFileInfo, compareFileVersions, setLocalRecordedSha } from './auto-sync'
import { S3Config, WebDAVConfig } from '@/types/sync'
import { syncImagesForDocument, extractLocalImagePaths } from './image-sync'
import { pullRemoteFile, saveLocalFile } from './auto-sync'
import { shouldExclude } from '@/config/sync-exclusions'
import emitter from '@/lib/emitter'
import { join } from '@tauri-apps/api/path'

export interface SyncItem {
  path: string
  type: 'document' | 'image'
  status: 'local_newer' | 'remote_newer' | 'synced' | 'conflict' | 'new'
  size?: number
}

export interface SyncStats {
  totalFiles: number
  totalImages: number
  syncedFiles: number
  pendingUpload: number
  pendingDownload: number
  conflicts: number
  lastSyncTime: number
}

export interface FullSyncResult {
  success: boolean
  pushedFiles: number
  pulledFiles: number
  failedFiles: number
  conflicts: number
  totalProcessed: number
  errors: string[]
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.tif', '.avif', '.heic', '.heif']
const MARKDOWN_EXTENSIONS = ['.md', '.markdown']

function isImageFile(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() || ''
  return IMAGE_EXTENSIONS.includes(`.${ext}`)
}

function isMarkdownFile(path: string): boolean {
  const ext = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some(e => ext.endsWith(e))
}

async function getCurrentPlatform(): Promise<'github' | 'gitee' | 'gitlab' | 'gitea' | 's3' | 'webdav'> {
  const store = await Store.load('store.json')
  return (await store.get<string>('primaryBackupMethod') || 'github') as any
}

async function getProxyConfig(): Promise<{ all: string } | undefined> {
  const store = await Store.load('store.json')
  const proxyUrl = await store.get<string>('proxy')
  return proxyUrl ? { all: proxyUrl } : undefined
}

async function getS3Config(): Promise<S3Config | null> {
  const store = await Store.load('store.json')
  const config = await store.get<S3Config>('s3SyncConfig')
  if (config && config.accessKeyId && config.secretAccessKey && config.region && config.bucket) {
    return config
  }
  return null
}

async function getWebDAVConfig(): Promise<WebDAVConfig | null> {
  const store = await Store.load('store.json')
  const config = await store.get<WebDAVConfig>('webdavSyncConfig')
  if (config && config.url && config.username && config.password) {
    return config
  }
  return null
}

async function listFilesRecursively(dirPath: string, useCustom: boolean): Promise<string[]> {
  const files: string[] = []
  
  const processDir = async (currentDir: string, relativeDir: string) => {
    try {
      let entries: DirEntry[]
      if (useCustom) {
        entries = await readDir(currentDir)
      } else {
        entries = await readDir(currentDir, { baseDir: BaseDirectory.AppData })
      }
      
      for (const entry of entries) {
        const entryRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        
        if (entry.name.startsWith('.')) continue
        if (shouldExclude(entryRelative)) continue
        
        if (entry.isDirectory) {
          const fullPath = useCustom ? await join(currentDir, entry.name) : entry.name
          await processDir(fullPath, entryRelative)
        } else {
          files.push(entryRelative)
        }
      }
    } catch (error) {
      console.error(`[BatchSync] Failed to list files in ${currentDir}:`, error)
    }
  }
  
  await processDir(dirPath, '')
  return files
}

export async function scanWorkspace(): Promise<SyncItem[]> {
  const items: SyncItem[] = []
  const workspace = await getWorkspacePath()
  
  const dirPath = workspace.isCustom ? workspace.path : 'article'
  const files = await listFilesRecursively(
    dirPath,
    workspace.isCustom
  )
  
  for (const filePath of files) {
    if (shouldExclude(filePath)) continue
    
    const isImage = isImageFile(filePath)
    const isMarkdown = isMarkdownFile(filePath)
    
    if (!isImage && !isMarkdown) continue
    
    const type = isImage ? 'image' : 'document'
    
    try {
      const syncResult = await compareFileVersions(filePath)
      
      items.push({
        path: filePath,
        type,
        status: syncResult.action === 'none' ? 'synced' : 
                syncResult.action === 'push' ? 'local_newer' :
                syncResult.action === 'pull' ? 'remote_newer' :
                syncResult.action === 'conflict' ? 'conflict' : 'synced'
      })
    } catch {
      items.push({
        path: filePath,
        type,
        status: 'new'
      })
    }
  }
  
  return items
}

export async function getSyncStats(): Promise<SyncStats> {
  const items = await scanWorkspace()
  
  const docs = items.filter(i => i.type === 'document')
  const images = items.filter(i => i.type === 'image')
  
  const store = await Store.load('sync_logs.json')
  const logs = await store.get<Array<{ timestamp: number }>>('logs') || []
  const lastSyncTime = logs.length > 0 ? logs[0].timestamp : 0
  
  return {
    totalFiles: docs.length,
    totalImages: images.length,
    syncedFiles: items.filter(i => i.status === 'synced').length,
    pendingUpload: items.filter(i => i.status === 'local_newer' || i.status === 'new').length,
    pendingDownload: items.filter(i => i.status === 'remote_newer').length,
    conflicts: items.filter(i => i.status === 'conflict').length,
    lastSyncTime
  }
}

export async function fullSync(options?: {
  onProgress?: (phase: string, current: number, total: number, item: string) => void
  onConflict?: (path: string, local: string, remote: string) => Promise<'local' | 'remote' | 'skip'>
}): Promise<FullSyncResult> {
  const result: FullSyncResult = {
    success: true,
    pushedFiles: 0,
    pulledFiles: 0,
    failedFiles: 0,
    conflicts: 0,
    totalProcessed: 0,
    errors: []
  }
  
  const onProgress = options?.onProgress
  const onConflict = options?.onConflict
  
  emitter.emit('batch-sync-started', {})
  
  try {
    const items = await scanWorkspace()
    const pendingPush = items.filter(i => i.status === 'local_newer' || i.status === 'new')
    const pendingPull = items.filter(i => i.status === 'remote_newer')
    const conflictItems = items.filter(i => i.status === 'conflict')
    
    onProgress?.('pull', 0, pendingPull.length, 'Starting pull phase...')
    
    for (let i = 0; i < pendingPull.length; i++) {
      const item = pendingPull[i]
      onProgress?.('pull', i + 1, pendingPull.length, item.path)
      
      try {
        await pullSingleFile(item.path)
        result.pulledFiles++
      } catch (error) {
        result.failedFiles++
        result.errors.push(`Failed to pull ${item.path}: ${error}`)
      }
      result.totalProcessed++
    }
    
    onProgress?.('push', 0, pendingPush.length, 'Starting push phase...')
    
    for (let i = 0; i < pendingPush.length; i++) {
      const item = pendingPush[i]
      onProgress?.('push', i + 1, pendingPush.length, item.path)
      
      try {
        await pushSingleFile(item.path)
        result.pushedFiles++
        
        if (item.type === 'document') {
          const content = await readFileContent(item.path)
          await syncImagesForDocument(item.path, content)
        }
      } catch (error) {
        result.failedFiles++
        result.errors.push(`Failed to push ${item.path}: ${error}`)
      }
      result.totalProcessed++
    }
    
    onProgress?.('conflict', 0, conflictItems.length, 'Starting conflict resolution...')
    
    for (let i = 0; i < conflictItems.length; i++) {
      const item = conflictItems[i]
      onProgress?.('conflict', i + 1, conflictItems.length, item.path)
      
      if (onConflict) {
        try {
          const local = await readFileContent(item.path)
          const remote = await pullRemoteFile(item.path)
          const choice = await onConflict(item.path, local, remote)
          
          if (choice === 'local') {
            await pushSingleFile(item.path)
            result.pushedFiles++
          } else if (choice === 'remote') {
            await pullSingleFile(item.path)
            result.pulledFiles++
          }
        } catch (error) {
          result.failedFiles++
          result.errors.push(`Failed to resolve conflict for ${item.path}: ${error}`)
        }
      } else {
        result.conflicts++
      }
      result.totalProcessed++
    }
    
    result.success = result.failedFiles === 0
    emitter.emit('batch-sync-completed', result)
  } catch (error) {
    result.success = false
    result.errors.push(`Batch sync failed: ${error}`)
    emitter.emit('batch-sync-completed', result)
  }
  
  return result
}

async function readFileContent(path: string): Promise<string> {
  const workspace = await getWorkspacePath()
  const pathOptions = await getFilePathOptions(path)
  
  if (workspace.isCustom) {
    return await readTextFile(pathOptions.path)
  } else {
    return await readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir as any })
  }
}

async function pushSingleFile(path: string): Promise<void> {
  const platform = await getCurrentPlatform()
  const content = await readFileContent(path)
  const repo = (platform !== 's3' && platform !== 'webdav') ? await getSyncRepoName(platform) : undefined
  
  switch (platform) {
    case 'github': {
      const platformModule = await import('./github') as any
      const fileInfo = await platformModule.getFiles({ path, repo })
      const result = await platformModule.uploadFile({
        file: content,
        sha: fileInfo?.sha,
        message: `Sync: ${path}`,
        repo,
        path
      })
      if (result?.data?.content?.sha) {
        await setLocalRecordedSha(path, result.data.content.sha)
      }
      break
    }
    case 'gitee': {
      const platformModule = await import('./gitee') as any
      const fileInfo = await platformModule.getFiles({ path, repo })
      const result = await platformModule.uploadFile({
        file: content,
        sha: fileInfo?.sha,
        message: `Sync: ${path}`,
        repo,
        path
      })
      if (result?.data?.content?.sha) {
        await setLocalRecordedSha(path, result.data.content.sha)
      }
      break
    }
    case 'gitlab': {
      const platformModule = await import('./gitlab') as any
      const fileInfo = await platformModule.getFiles({ path, repo })
      await platformModule.uploadFile({
        file: content,
        sha: fileInfo?.sha,
        message: `Sync: ${path}`,
        repo,
        path
      })
      const sha = await getRemoteFileInfo(path)
      if (sha?.sha) {
        await setLocalRecordedSha(path, sha.sha)
      }
      break
    }
    case 'gitea': {
      const platformModule = await import('./gitea') as any
      const fileInfo = await platformModule.getFiles({ path, repo })
      await platformModule.uploadFile({
        file: content,
        sha: fileInfo?.sha,
        message: `Sync: ${path}`,
        repo,
        path
      })
      const sha = await getRemoteFileInfo(path)
      if (sha?.sha) {
        await setLocalRecordedSha(path, sha.sha)
      }
      break
    }
    case 's3': {
      const platformModule = await import('./s3') as any
      const s3Config = await getS3Config()
      if (s3Config) {
        const proxy = await getProxyConfig()
        const result = await platformModule.s3Upload(s3Config, path, content, proxy)
        if (result?.etag) {
          const syncStore = (await import('@/stores/sync')).default
          syncStore.getState().updateS3FileEtag(path, result.etag)
        }
      }
      break
    }
    case 'webdav': {
      const platformModule = await import('./webdav') as any
      const webdavConfig = await getWebDAVConfig()
      if (webdavConfig) {
        const proxy = await getProxyConfig()
        const result = await platformModule.webdavUpload(webdavConfig, path, content, proxy)
        if (result?.etag) {
          const syncStore = (await import('@/stores/sync')).default
          syncStore.getState().updateWebDAVFileEtag(path, result.etag)
        }
      }
      break
    }
  }
}

async function pullSingleFile(path: string): Promise<void> {
  const content = await pullRemoteFile(path)
  await saveLocalFile(path, content)
}

export async function scanWorkspaceImages(): Promise<string[]> {
  const workspace = await getWorkspacePath()
  const dirPath = workspace.isCustom ? workspace.path : 'article'
  const allFiles = await listFilesRecursively(
    dirPath,
    workspace.isCustom
  )
  
  const imageSet = new Set<string>()
  
  for (const filePath of allFiles) {
    if (shouldExclude(filePath)) continue
    
    if (isImageFile(filePath)) {
      imageSet.add(filePath)
    } else if (isMarkdownFile(filePath)) {
      try {
        const content = await readFileContent(filePath)
        const imagePaths = extractLocalImagePaths(content)
        for (const imgPath of imagePaths) {
          if (!imgPath.startsWith('http') && !imgPath.startsWith('data:')) {
            imageSet.add(imgPath)
          }
        }
      } catch {
      }
    }
  }
  
  return Array.from(imageSet)
}

export async function syncAllImages(onProgress?: (current: number, total: number, path: string) => void): Promise<{
  total: number
  success: number
  failed: number
}> {
  const imagePaths = await scanWorkspaceImages()
  
  let success = 0
  let failed = 0
  
  for (let i = 0; i < imagePaths.length; i++) {
    const path = imagePaths[i]
    onProgress?.(i + 1, imagePaths.length, path)
    
    try {
      const { uploadImageForSync } = await import('./image-sync')
      const result = await uploadImageForSync(path)
      if (result.success) {
        success++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }
  
  return { total: imagePaths.length, success, failed }
}
