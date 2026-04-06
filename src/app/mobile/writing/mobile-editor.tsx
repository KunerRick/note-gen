'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TipTapEditor } from '@/app/core/main/editor/markdown/tiptap-editor'
import type { Editor } from '@tiptap/react'
import { Loader2 } from 'lucide-react'
import useArticleStore from '@/stores/article'
import emitter from '@/lib/emitter'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { getFilePathOptions, getWorkspacePath } from '@/lib/workspace'

interface MobileEditorProps {
  onEditorReady?: (editor: Editor | null) => void
}

export function MobileEditor({ onEditorReady }: MobileEditorProps) {
  const tEditor = useTranslations('editor')
  const { setCurrentArticle, activeFilePath, currentArticle, loading } = useArticleStore()

  const [content, setContent] = useState('')
  const [isEditorReady, setIsEditorReady] = useState(false)

  const activePathRef = useRef<string>('')
  const contentRef = useRef<string>('')
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isSavingRef = useRef(false)

  // 监听 activeFilePath 变化
  useEffect(() => {
    if (activeFilePath && activeFilePath !== activePathRef.current) {
      activePathRef.current = activeFilePath
      // 重置内容，等待 store 加载
      setContent('')
      contentRef.current = ''
    } else if (!activeFilePath && activePathRef.current) {
      activePathRef.current = ''
      setContent('')
      contentRef.current = ''
      setIsEditorReady(false)
    }
  }, [activeFilePath])

  // 监听 store 中的 currentArticle 变化
  useEffect(() => {
    if (currentArticle !== contentRef.current) {
      setContent(currentArticle)
      contentRef.current = currentArticle
    }
  }, [currentArticle])

  // 保存文件
  const doSave = useCallback(async () => {
    const path = activePathRef.current
    const newContent = contentRef.current

    if (!path || isSavingRef.current || !isEditorReady) {
      return
    }

    isSavingRef.current = true
    try {
      const workspace = await getWorkspacePath()
      const pathOptions = await getFilePathOptions(path)

      if (workspace.isCustom) {
        await writeTextFile(pathOptions.path, newContent)
      } else {
        await writeTextFile(pathOptions.path, newContent, { baseDir: pathOptions.baseDir })
      }

      setCurrentArticle(newContent)
    } finally {
      isSavingRef.current = false
    }
  }, [setCurrentArticle, isEditorReady])

  // 处理内容变化
  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent)
    contentRef.current = newContent

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      doSave()
    }, 500)
  }, [doSave])

  // 处理编辑器就绪
  const handleEditorReady = useCallback(() => {
    setIsEditorReady(true)
  }, [])

  // 处理引用到聊天
  const handleQuoteToChat = useCallback(() => {
    emitter.emit('get-quote-from-editor')
  }, [])

  // 清理定时器
  useEffect(() => {
    return () => {
      onEditorReady?.(null)
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [onEditorReady])

  // 显示加载状态
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex-1 relative w-full h-full flex flex-col">
      <TipTapEditor
        initialContent={content}
        onChange={handleContentChange}
        placeholder={tEditor('placeholder')}
        activeFilePath={activeFilePath}
        onQuoteToChat={handleQuoteToChat}
        onReady={handleEditorReady}
        onEditorReady={onEditorReady as ((editor: any) => void) | undefined}
      />
    </div>
  )
}

export default MobileEditor
