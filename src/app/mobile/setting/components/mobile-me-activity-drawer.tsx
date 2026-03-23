'use client'

import { ActivityDayDetail } from '@/components/activity/activity-day-detail'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import type { ActivityDaySummary } from '@/lib/activity/types'

interface MobileMeActivityDrawerProps {
  day?: ActivityDaySummary
  open: boolean
  onOpenChange: (open: boolean) => void
  summaryText: string
  labels: {
    title: string
    description: string
    empty: string
    records: string
    writing: string
    chats: string
  }
}

export function MobileMeActivityDrawer({
  day,
  open,
  onOpenChange,
  summaryText,
  labels,
}: MobileMeActivityDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[82vh] rounded-t-[24px]">
        <DrawerHeader className="pb-3 text-left">
          <DrawerTitle>{day?.day || labels.title}</DrawerTitle>
          <DrawerDescription>{day ? summaryText : labels.description}</DrawerDescription>
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-6">
          <ActivityDayDetail
            day={day}
            compact
            labels={{
              empty: labels.empty,
              records: labels.records,
              writing: labels.writing,
              chats: labels.chats,
            }}
          />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
