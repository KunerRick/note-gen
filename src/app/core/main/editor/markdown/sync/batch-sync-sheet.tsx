'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Loader2, RefreshCw, CheckCircle, XCircle, Upload, Download, Image, AlertCircle } from 'lucide-react'
import { fullSync, getSyncStats, SyncStats } from '@/lib/sync/batch-sync'
import { isSyncConfigured } from '@/lib/sync/sync-manager'
import emitter from '@/lib/emitter'
import { cn } from '@/lib/utils'

interface BatchSyncSheetProps {
  className?: string
  trigger?: React.ReactNode
}

export function BatchSyncSheet({ className, trigger }: BatchSyncSheetProps) {
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

    const handleBatchSyncCompleted = (res: any) => {
      setIsSyncing(false)
      setResult(res)
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

  const defaultTrigger = (
    <Button variant="ghost" size="sm" className={cn('gap-2', className)}>
      <RefreshCw className="size-4" />
      <span>全量同步</span>
    </Button>
  )

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        {trigger || defaultTrigger}
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[70vh]">
        <SheetHeader>
          <SheetTitle>全量同步</SheetTitle>
          <SheetDescription>
            同步工作区中的所有文档和图片到远程
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col h-full pt-4">
          {!result ? (
            <>
              {stats && (
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                    <Upload className="size-5 text-blue-500" />
                    <div>
                      <div className="text-sm font-medium">{stats.pendingUpload}</div>
                      <div className="text-xs text-gray-500">待上传</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg">
                    <Download className="size-5 text-green-500" />
                    <div>
                      <div className="text-sm font-medium">{stats.pendingDownload}</div>
                      <div className="text-xs text-gray-500">待下载</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg">
                    <Image className="size-5 text-purple-500" />
                    <div>
                      <div className="text-sm font-medium">{stats.totalImages}</div>
                      <div className="text-xs text-gray-500">图片</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-orange-50 rounded-lg">
                    <AlertCircle className="size-5 text-orange-500" />
                    <div>
                      <div className="text-sm font-medium">{stats.conflicts}</div>
                      <div className="text-xs text-gray-500">冲突</div>
                    </div>
                  </div>
                </div>
              )}

              {isSyncing && (
                <div className="flex-1 flex flex-col justify-center">
                  <div className="space-y-4">
                    <div className="flex items-center justify-center">
                      <Loader2 className="size-8 animate-spin text-blue-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="capitalize font-medium">{currentPhase}</span>
                        <span>{progress.current} / {progress.total}</span>
                      </div>
                      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 transition-all duration-300"
                          style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-500 truncate text-center">{currentItem}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-auto pt-4">
                <Button
                  className="w-full"
                  size="lg"
                  onClick={handleSync}
                  disabled={isSyncing || (stats?.pendingUpload ?? 0) === 0}
                >
                  {isSyncing ? (
                    <>
                      <Loader2 className="size-5 animate-spin mr-2" />
                      同步中...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="size-5 mr-2" />
                      开始同步
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col justify-center">
              <div className={`flex flex-col items-center gap-4 ${result.success ? 'text-green-500' : 'text-red-500'}`}>
                {result.success ? (
                  <CheckCircle className="size-12" />
                ) : (
                  <XCircle className="size-12" />
                )}
                <span className="text-xl font-medium">
                  {result.success ? '同步完成' : '同步失败'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4 mt-6">
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-500">{result.pushedFiles}</div>
                  <div className="text-sm text-gray-500">上传</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-500">{result.pulledFiles}</div>
                  <div className="text-sm text-gray-500">下载</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-red-500">{result.failedFiles}</div>
                  <div className="text-sm text-gray-500">失败</div>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="mt-4 p-3 bg-red-50 rounded-lg text-sm text-red-600 max-h-32 overflow-auto">
                  {result.errors.slice(0, 5).map((error, i) => (
                    <div key={i} className="truncate">{error}</div>
                  ))}
                  {result.errors.length > 5 && (
                    <div className="mt-1 text-xs">...还有 {result.errors.length - 5} 个错误</div>
                  )}
                </div>
              )}

              <Button
                className="w-full mt-6"
                variant="outline"
                onClick={() => {
                  setResult(null)
                  loadStats()
                }}
              >
                再次同步
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
