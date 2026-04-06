/**
 * Base64 编码/解码工具函数
 * 兼容浏览器和 Node.js 环境
 */

/**
 * 将 Uint8Array 转换为 Base64 字符串
 */
export function uint8ArrayToBase64(array: Uint8Array): string {
  // 使用浏览器原生的 btoa 函数
  const binary = Array.from(array)
    .map(byte => String.fromCharCode(byte))
    .join('')
  return btoa(binary)
}

/**
 * 将 Base64 字符串转换为 Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // 移除可能的换行符和空格
  const cleanBase64 = base64.replace(/\s/g, '')
  // 使用浏览器原生的 atob 函数
  const binary = atob(cleanBase64)
  const array = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i)
  }
  return array
}

/**
 * 将字符串转换为 Base64
 */
export function stringToBase64(str: string): string {
  // 先转换为 Uint8Array，再转换为 Base64
  const encoder = new TextEncoder()
  const array = encoder.encode(str)
  return uint8ArrayToBase64(array)
}

/**
 * 将 Base64 转换为字符串
 */
export function base64ToString(base64: string): string {
  const array = base64ToUint8Array(base64)
  const decoder = new TextDecoder('utf-8')
  return decoder.decode(array)
}

/**
 * 将 ArrayBuffer 转换为 Base64
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return uint8ArrayToBase64(new Uint8Array(buffer))
}

/**
 * 将 Base64 转换为 ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer
}
