'use client'
import { MobileMarkHeader } from './mobile-mark-header'
import { MobileRecordStream } from './mobile-record-stream'

export default function Record() {
  return (
    <div id="mobile-record" className="flex h-full min-h-0 w-full flex-col bg-background">
      <MobileMarkHeader />
      <MobileRecordStream />
    </div>
  )
}
