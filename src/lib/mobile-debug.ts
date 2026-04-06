/**
 * 移动端调试工具
 * 用于在 Android WebView 中显示调试信息
 */

interface LogEntry {
  timestamp: string
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  data?: unknown
}

class MobileDebugger {
  private logs: LogEntry[] = []
  private maxLogs = 100
  private debugPanel: HTMLElement | null = null
  private isVisible = false

  constructor() {
    // 只在移动端初始化
    if (this.isMobile()) {
      this.init()
    }
  }

  private isMobile(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  }

  private init() {
    // 拦截原始 console 方法
    this.interceptConsole()

    // 添加手势触发（三指点击显示调试面板）
    document.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: true })

    // 创建调试面板
    this.createDebugPanel()
  }

  private interceptConsole() {
    const originalLog = console.log
    const originalInfo = console.info
    const originalWarn = console.warn
    const originalError = console.error

    console.log = (...args: unknown[]) => {
      this.addLog('log', args)
      originalLog.apply(console, args)
    }

    console.info = (...args: unknown[]) => {
      this.addLog('info', args)
      originalInfo.apply(console, args)
    }

    console.warn = (...args: unknown[]) => {
      this.addLog('warn', args)
      originalWarn.apply(console, args)
    }

    console.error = (...args: unknown[]) => {
      this.addLog('error', args)
      originalError.apply(console, args)
    }
  }

  private addLog(level: LogEntry['level'], args: unknown[]) {
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    }).join(' ')

    const entry: LogEntry = {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      data: args.length > 1 ? args : args[0]
    }

    this.logs.push(entry)

    // 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs.shift()
    }

    // 更新面板显示
    if (this.isVisible) {
      this.updatePanel()
    }
  }

  private createDebugPanel() {
    const panel = document.createElement('div')
    panel.id = 'mobile-debug-panel'
    panel.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.95);
      color: #fff;
      font-family: monospace;
      font-size: 12px;
      z-index: 999999;
      display: none;
      flex-direction: column;
      padding: 10px;
      overflow: hidden;
    `

    const header = document.createElement('div')
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #444;
      margin-bottom: 10px;
    `

    const title = document.createElement('span')
    title.textContent = 'Debug Console'
    title.style.fontWeight = 'bold'

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '✕'
    closeBtn.style.cssText = `
      background: #444;
      border: none;
      color: #fff;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 16px;
    `
    closeBtn.onclick = () => this.hide()

    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear'
    clearBtn.style.cssText = `
      background: #444;
      border: none;
      color: #fff;
      padding: 5px 10px;
      cursor: pointer;
      margin-right: 10px;
    `
    clearBtn.onclick = () => {
      this.logs = []
      this.updatePanel()
    }

    header.appendChild(title)
    header.appendChild(clearBtn)
    header.appendChild(closeBtn)

    const content = document.createElement('div')
    content.id = 'mobile-debug-content'
    content.style.cssText = `
      flex: 1;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    `

    panel.appendChild(header)
    panel.appendChild(content)

    document.body.appendChild(panel)
    this.debugPanel = panel
  }

  private updatePanel() {
    if (!this.debugPanel) return

    const content = this.debugPanel.querySelector('#mobile-debug-content')
    if (!content) return

    const html = this.logs.map(log => {
      const color = {
        log: '#fff',
        info: '#4fc3f7',
        warn: '#ffb74d',
        error: '#e57373'
      }[log.level]

      return `<div style="margin-bottom: 5px; border-left: 3px solid ${color}; padding-left: 8px;">
        <span style="color: #888; font-size: 10px;">[${log.timestamp}]</span>
        <span style="color: ${color};">${this.escapeHtml(log.message)}</span>
      </div>`
    }).join('')

    content.innerHTML = html
    content.scrollTop = content.scrollHeight
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  private handleTouchStart(e: TouchEvent) {
    // 三指点击显示调试面板
    if (e.touches.length === 3) {
      e.preventDefault()
      this.toggle()
    }
  }

  show() {
    if (this.debugPanel) {
      this.debugPanel.style.display = 'flex'
      this.isVisible = true
      this.updatePanel()
    }
  }

  hide() {
    if (this.debugPanel) {
      this.debugPanel.style.display = 'none'
      this.isVisible = false
    }
  }

  toggle() {
    if (this.isVisible) {
      this.hide()
    } else {
      this.show()
    }
  }

  // 手动添加日志
  log(...args: unknown[]) {
    this.addLog('log', args)
  }

  info(...args: unknown[]) {
    this.addLog('info', args)
  }

  warn(...args: unknown[]) {
    this.addLog('warn', args)
  }

  error(...args: unknown[]) {
    this.addLog('error', args)
  }
}

// 单例模式
let mobileDebugger: MobileDebugger | null = null

export function initMobileDebugger() {
  if (!mobileDebugger) {
    mobileDebugger = new MobileDebugger()
  }
  return mobileDebugger
}

export function getMobileDebugger() {
  return mobileDebugger
}

// 默认导出
export default MobileDebugger
