'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, RefreshCw, CheckCircle, XCircle, AlertCircle, Upload, Download, Image } from 'lucide-react'
import { fullSync, getSyncStats, SyncStats } from '@/lib/sync/batch-sync'
import { isSyncConfigured } from '@/lib/sync/sync-manager'
import emitter from '@/lib/emitter'

interface BatchSyncButtonProps {
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  showLabel?: boolean
}

export function BatchSyncButton({ variant = 'outline', size = 'default', showLabel = true }: BatchSyncButtonProps) {
  const [isConfigured, setIsConfigured] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [stats, setStats] = useState<SyncStats | null>(null)
  const [currentPhase, setCurrentPhase] = useState('')
  const [currentItem, setCurrentItem] = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [result, setResult] = useState<{
    success: boolean
    pushedFiles: number
    pulledFiles: number
    failedFiles: number
    errors: string[]
  } | null>(null)

  useEffect(() => {
    isSyncConfigured().then(setIsConfigured)
  }, [])

  useEffect(() => {
    if (isOpen && !isSyncing) {
      loadStats()
    }
  }, [isOpen, isSyncing])

  useEffect(() => {
    const handleBatchSyncStarted = () => {
      setIsSyncing(true)
      setResult(null)
    }

    const handleBatchSyncCompleted = (result: any) => {
      setIsSyncing(false)
      setResult(result)
    }

    emitter.on('batch-sync-started', handleBatchSyncStarted)
    emitter.on('batch-sync-completed', handleBatchSyncCompleted)

    return () => {
      emitter.off('batch-sync-started', handleBatchSyncStarted)
      emitter.off('batch-sync-completed', handleBatchSyncCompleted)
    }
  }, [])

  const loadStats = async () => {
    try {
      const syncStats = await getSyncStats()
      setStats(syncStats)
    } catch (error) {
      console.error('Failed to load sync stats:', error)
    }
  }

  const handleSync = async () => {
    setIsSyncing(true)
    setResult(null)

    try {
      await fullSync({
        onProgress: (phase, current, total, item) => {
          setCurrentPhase(phase)
          setCurrentItem(item)
          setProgress({ current, total })
        }
      })
    } catch (error) {
      console.error('Batch sync failed:', error)
      setResult({
        success: false,
        pushedFiles: 0,
        pulledFiles: 0,
        failedFiles: 0,
        errors: [String(error)]
      })
    }
  }

  if (!isConfigured) {
    return null
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setIsOpen(true)}
        disabled={isSyncing}
      >
        {isSyncing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        {showLabel && <span className="ml-2">全量同步</span>}
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>全量同步</DialogTitle>
            <DialogDescription>
              同步工作区中的所有文档和图片到远程
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {!result ? (
              <>
                {stats && (
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Upload className="size-4 text-blue-500" />
                      <span>待上传: {stats.pendingUpload}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Download className="size-4 text-green-500" />
                      <span>待下载: {stats.pendingDownload}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Image className="size-4 text-purple-500" />
                      <span>图片: {stats.totalImages}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <AlertCircle className="size-4 text-orange-500" />
                      <span>冲突: {stats.conflicts}</span>
                    </div>
                  </div>
                )}

                {isSyncing && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize">{currentPhase}</span>
                      <span>{progress.current} / {progress.total}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 truncate">{currentItem}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <div className={`flex items-center gap-2 ${result.success ? 'text-green-500' : 'text-red-500'}`}>
                  {result.success ? (
                    <CheckCircle className="size-6" />
                  ) : (
                    <XCircle className="size-6" />
                  )}
                  <span className="font-medium">
                    {result.success ? '同步完成' : '同步失败'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-500">{result.pushedFiles}</div>
                    <div className="text-gray-500">上传</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-500">{result.pulledFiles}</div>
                    <div className="text-gray-500">下载</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-500">{result.failedFiles}</div>
                    <div className="text-gray-500">失败</div>
                  </div>
                </div>

                {result.errors.length > 0 && (
                  <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-600 max-h-24 overflow-auto">
                    {result.errors.map((error, i) => (
                      <div key={i}>{error}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-4">
            {!result && (
              <>
                <Button variant="outline" onClick={() => setIsOpen(false)} disabled={isSyncing} className="flex-1">
                  取消
                </Button>
                <Button onClick={handleSync} disabled={isSyncing || (stats?.pendingUpload ?? 0) === 0} className="flex-1 mt-0">
                  {isSyncing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      同步中...
                    </>
                  ) : (
                    '开始同步'
                  )}
                </Button>
              </>
            )}
            {result && (
              <Button onClick={() => setIsOpen(false)} className="flex-1">
                关闭
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
