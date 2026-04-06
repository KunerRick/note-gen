'use client'

import { ArrowUpCircle, CheckCircle, Loader2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState, useRef } from 'react'
import { cn } from '@/lib/utils'
import useArticleStore from '@/stores/article'
import useSyncStore from '@/stores/sync'
import { Store } from '@tauri-apps/plugin-store'
import { getSyncRepoName } from '@/lib/sync/repo-utils'
import { getWorkspacePath, getFilePathOptions } from '@/lib/workspace'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { isSyncConfigured } from '@/lib/sync/sync-manager'
import { syncImagesForDocument } from '@/lib/sync/image-sync'
import emitter from '@/lib/emitter'

export function SyncButton() {
  const { activeFilePath } = useArticleStore()
  const [isLoading, setIsLoading] = useState(false)
  const [isConfigured, setIsConfigured] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showError, setShowError] = useState(false)
  const [lastPushTime, setLastPushTime] = useState<Date | null>(null)
  const [imageSyncInfo, setImageSyncInfo] = useState<{ total: number; success: number; failed: number } | null>(null)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Check if sync is configured
  useEffect(() => {
    isSyncConfigured().then(setIsConfigured)
  }, [])

  // 监听推送开始事件
  useEffect(() => {
    const handlePushStarted = (event: { path: string }) => {
      if (activeFilePath && event.path === activeFilePath) {
        setIsLoading(true)
      }
    }
    emitter.on('sync-push-started', handlePushStarted as any)
    return () => {
      emitter.off('sync-push-started', handlePushStarted as any)
    }
  }, [activeFilePath])

  // 监听推送完成事件
  useEffect(() => {
    const handlePushCompleted = (event: { path: string; success: boolean }) => {
      if (activeFilePath && event.path === activeFilePath) {
        setIsLoading(false)
        if (event.success) {
          // 显示成功状态
          setShowError(false)
          setShowSuccess(true)
          setLastPushTime(new Date())
          // 5秒后恢复
          if (successTimerRef.current) {
            clearTimeout(successTimerRef.current)
          }
          successTimerRef.current = setTimeout(() => {
            setShowSuccess(false)
          }, 5000)
        } else {
          // 显示失败状态
          setShowSuccess(false)
          setShowError(true)
          // 5秒后恢复
          if (errorTimerRef.current) {
            clearTimeout(errorTimerRef.current)
          }
          errorTimerRef.current = setTimeout(() => {
            setShowError(false)
          }, 5000)
        }
      }
    }
    emitter.on('sync-push-completed', handlePushCompleted as any)
    return () => {
      emitter.off('sync-push-completed', handlePushCompleted as any)
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current)
      }
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current)
      }
    }
  }, [activeFilePath])

  // 监听图片同步完成事件
  useEffect(() => {
    const handleImagesCompleted = (event: { path: string; totalImages: number; successCount: number; failedCount: number }) => {
      if (activeFilePath && event.path === activeFilePath) {
        setImageSyncInfo({
          total: event.totalImages,
          success: event.successCount,
          failed: event.failedCount
        })
        // 3秒后清除图片同步信息
        setTimeout(() => {
          setImageSyncInfo(null)
        }, 3000)
      }
    }
    emitter.on('sync-images-completed', handleImagesCompleted as any)
    return () => {
      emitter.off('sync-images-completed', handleImagesCompleted as any)
    }
  }, [activeFilePath])

  // Generate default commit message
  const generateCommitMessage = useCallback(async (_content: string): Promise<string> => {
    // 使用默认提交信息，不调用 AI
    return '默认提交信息'
  }, [])

  // Push to remote
  const handlePush = useCallback(async () => {
    if (!activeFilePath || isLoading) return

    setIsLoading(true)
    const startTime = performance.now()
    console.log(`[SyncButton] Push started at ${new Date().toISOString()}`)

    try {
      const store = await Store.load('store.json')
      const provider = (await store.get<string>('primaryBackupMethod') || 'github') as 'gitee' | 'github' | 'gitlab' | 'gitea' | 's3' | 'webdav'
      // S3 和 WebDAV 不需要 repo
      const repo = (provider === 's3' || provider === 'webdav') ? '' : await getSyncRepoName(provider)

      // 始终从磁盘读取最新内容
      const workspace = await getWorkspacePath()
      const pathOptions = await getFilePathOptions(activeFilePath)
      const content = workspace.isCustom
        ? await readTextFile(pathOptions.path)
        : await readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })

      console.log(`[SyncButton] File read took ${(performance.now() - startTime).toFixed(0)}ms`)

      const commitMessage = await generateCommitMessage(content)
      console.log(`[SyncButton] Commit message generated in ${(performance.now() - startTime).toFixed(0)}ms`)

      let success = false

      switch (provider) {
        case 's3': {
          const s3Module = await import('@/lib/sync/s3') as any
          const s3Config = await store.get<any>('s3SyncConfig')
          if (!s3Config) {
            throw new Error('S3 配置未找到')
          }
          // S3 上传文件
          const result = await s3Module.s3Upload(s3Config, activeFilePath, content)
          if (result) {
            // 更新 ETag 记录
            useSyncStore.getState().updateS3FileEtag(activeFilePath, result.etag)
            success = true
          }
          break
        }
        case 'github': {
          const githubModule = await import('@/lib/sync/github') as any
          const fileInfo = await githubModule.getFiles({ path: activeFilePath, repo })
          await githubModule.uploadFile({
            ext: activeFilePath.split('.').pop() || 'md',
            file: content,
            filename: activeFilePath.split('/').pop() || activeFilePath,
            sha: fileInfo?.sha,
            message: commitMessage,
            repo,
            path: activeFilePath
          })
          success = true
          break
        }
        case 'gitee': {
          const giteeModule = await import('@/lib/sync/gitee') as any
          const fileInfo = await giteeModule.getFiles({ path: activeFilePath, repo })
          await giteeModule.uploadFile({
            ext: activeFilePath.split('.').pop() || 'md',
            file: content,
            filename: activeFilePath.split('/').pop() || activeFilePath,
            sha: fileInfo?.sha,
            message: commitMessage,
            repo,
            path: activeFilePath
          })
          success = true
          break
        }
        case 'gitlab': {
          const gitlabModule = await import('@/lib/sync/gitlab') as any
          const fileInfo = await gitlabModule.getFiles({ path: activeFilePath, repo })
          await gitlabModule.uploadFile({
            file: content,
            filename: activeFilePath.split('/').pop() || activeFilePath,
            sha: fileInfo?.sha,
            message: commitMessage,
            repo,
            path: activeFilePath
          })
          success = true
          break
        }
        case 'gitea': {
          const giteaModule = await import('@/lib/sync/gitea') as any
          const fileInfo = await giteaModule.getFiles({ path: activeFilePath, repo })
          await giteaModule.uploadFile({
            file: content,
            filename: activeFilePath.split('/').pop() || activeFilePath,
            sha: fileInfo?.sha,
            message: commitMessage,
            repo,
            path: activeFilePath
          })
          success = true
          break
        }
        case 'webdav': {
          const webdavModule = await import('@/lib/sync/webdav') as any
          const webdavConfig = await store.get<any>('webdavSyncConfig')
          if (!webdavConfig) {
            throw new Error('WebDAV 配置未找到')
          }
          const result = await webdavModule.webdavUpload(webdavConfig, activeFilePath, content)
          if (result) {
            // 更新 ETag 记录
            useSyncStore.getState().updateWebDAVFileEtag(activeFilePath, result.etag)
            success = true
          }
          break
        }
      }

      console.log(`[SyncButton] Document upload took ${(performance.now() - startTime).toFixed(0)}ms`)

      if (success) {
        // 推送文档成功后，同步关联的图片（仅针对 Markdown 文件）
        const isMarkdown = activeFilePath.endsWith('.md') || activeFilePath.endsWith('.markdown')
        if (isMarkdown) {
          console.log(`[SyncButton] Starting image sync for ${activeFilePath} at ${(performance.now() - startTime).toFixed(0)}ms`)
          try {
            const imageResult = await syncImagesForDocument(activeFilePath, content)
            console.log(`[SyncButton] Image sync result: ${imageResult.totalImages} images found, ${imageResult.successCount} synced, ${imageResult.failedCount} failed`)
            // 发送图片同步完成事件
            emitter.emit('sync-images-completed', {
              path: activeFilePath,
              totalImages: imageResult.totalImages,
              successCount: imageResult.successCount,
              failedCount: imageResult.failedCount
            })
          } catch (error) {
            console.error(`[SyncButton] Image sync error for ${activeFilePath}:`, error)
            // 图片同步失败不影响文档同步的成功状态
            // 仍然发送图片同步完成事件，但标记失败
            emitter.emit('sync-images-completed', {
              path: activeFilePath,
              totalImages: 0,
              successCount: 0,
              failedCount: 1
            })
          }
        }
        emitter.emit('sync-push-completed', { path: activeFilePath, success: true })
      } else {
        throw new Error('File may not exist on remote')
      }
    } catch (error) {
      console.error('Push failed:', error)
      setIsLoading(false)
      emitter.emit('sync-push-completed', { path: activeFilePath, success: false })
    }
  }, [activeFilePath, isLoading, generateCommitMessage])

  // 如果没有配置同步，不显示按钮
  if (!isConfigured || !activeFilePath) return null

  // 格式化时间
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* 上传中显示文字 */}
      {isLoading && (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 size={12} className="animate-spin" />
          上传中
        </span>
      )}

      {/* 成功推送状态 */}
      {showSuccess && !isLoading && (
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-xs text-green-500 flex items-center gap-1 animate-pulse">
            <CheckCircle size={12} />
            {lastPushTime && formatTime(lastPushTime)}
          </span>
          {imageSyncInfo && imageSyncInfo.total > 0 && (
            <span className="text-xs text-muted-foreground">
              图片: {imageSyncInfo.success}/{imageSyncInfo.total}
              {imageSyncInfo.failed > 0 && <span className="text-red-500"> ({imageSyncInfo.failed}失败)</span>}
            </span>
          )}
        </div>
      )}

      {/* 失败推送状态 */}
      {showError && !isLoading && (
        <span className="text-xs text-red-500 flex items-center gap-1">
          <XCircle size={12} />
          上传失败
        </span>
      )}

      {/* 同步按钮 */}
      {!showSuccess && !showError && !isLoading && (
        <button
          onClick={handlePush}
          disabled={isLoading}
          className={cn(
            'p-0.5 rounded transition-colors flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted'
          )}
          title={isLoading ? '上传中...' : '点击推送'}
        >
          <ArrowUpCircle size={14} />
        </button>
      )}
    </div>
  )
}

export default SyncButton
