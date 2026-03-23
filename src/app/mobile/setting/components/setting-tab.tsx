"use client";

import { useRouter } from "next/navigation";
import baseConfig from '@/app/core/setting/config'
import { useTranslations } from 'next-intl'
import { ChevronRight } from "lucide-react";

const MOBILE_ME_SCROLL_KEY = 'mobile-me-scroll-top'

export function SettingTab() {
  const router = useRouter()
  const t = useTranslations('settings')
  const notMobilePages = ['about', 'file', 'shortcuts']
  
  // Add translations to the config, keep separators
  const config = baseConfig.map(item => {
    if (typeof item === 'string') return item
    return {
      ...item,
      title: t(`${item.anchor}.title`)
    }
  }).filter(item => {
    // 过滤掉不支持的移动端页面，但保留分隔符
    if (typeof item === 'string') return true
    return !notMobilePages.includes(item.anchor)
  })

  function handleNavigation(anchor: string) {
    const mePage = document.getElementById('mobile-me')
    if (mePage) {
      window.sessionStorage.setItem(MOBILE_ME_SCROLL_KEY, String(mePage.scrollTop))
    }
    router.push(`/mobile/setting/pages/${anchor}`)
  }

  return (
    <ul className="flex flex-col w-full">
      {
        config.map((item, index) => {
          // 如果是分隔符字符串，渲染分隔线
          if (typeof item === 'string') {
            return (
              <li key={`separator-${index}`}>
                <div className="h-0.5 bg-muted my-2" />
              </li>
            )
          }
          
          return (
            <li
              className="flex items-center gap-2 p-4 w-full justify-between active:bg-accent"
              key={item.anchor}
              onClick={() => handleNavigation(item.anchor)}
            >
              <div className="flex items-center gap-4">
                {item.icon}
                <span className="text-sm">{item.title}</span>
              </div>
              <ChevronRight className="size-4" />
            </li>
          )
        })
      }
    </ul>
  )
}
