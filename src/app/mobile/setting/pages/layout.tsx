'use client'

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SwipeBack } from "@/components/ui/swipe-back";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const router = useRouter()
  return (
    <SwipeBack>
      <div className="flex h-full w-full flex-col overflow-y-auto bg-background pt-14">
        <div className="fixed top-0 left-0 right-0 z-10 flex items-center border-b bg-background p-2">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft />
          </Button>
        </div>
        <div className="flex-1 w-full p-3">
          {children}
        </div>
      </div>
    </SwipeBack>
  )
}
