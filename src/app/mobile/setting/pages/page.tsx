'use client'

import { useTranslations } from 'next-intl'

import { SettingTab } from '../components/setting-tab'

export default function MobileSettingsIndexPage() {
  const tSettings = useTranslations('settings')
  const tMe = useTranslations('mobile.me')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{tSettings('title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{tMe('settings.description')}</p>
      </div>
      <div className="rounded-3xl border border-border/60 bg-card shadow-sm">
        <SettingTab />
      </div>
    </div>
  )
}
