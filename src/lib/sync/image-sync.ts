import { Store } from '@tauri-apps/plugin-store'
import { readFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { getWorkspacePath, getFilePathOptions } from '@/lib/workspace'
import { getSyncRepoName } from './repo-utils'
import { getRemoteFileInfo } from './auto-sync'
import { S3Config, WebDAVConfig } from '@/types/sync'
import { fetch } from '@tauri-apps/plugin-http'

/**
 * 图片同步模块
 * 负责解析 Markdown 中的本地图片路径，并上传到远程同步平台
 */

// ============== 类型定义 ==============

export interface ImageSyncResult {
  success: boolean
  path: string
  remotePath: string
  sha?: string
  error?: string
}

export interface DocumentImageSyncResult {
  documentPath: string
  images: ImageSyncResult[]
  totalImages: number
  successCount: number
  failedCount: number
}

// ============== Markdown 图片路径解析 ==============

/**
 * 从 Markdown 内容中提取本地图片路径
 * @param content Markdown 文本内容
 * @returns 本地图片相对路径数组（排除外链）
 */
export function extractLocalImagePaths(content: string): string[] {
  const imagePaths: string[] = []
  
  // 正则匹配 Markdown 图片语法: ![alt](path)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  
  let match
  while ((match = imageRegex.exec(content)) !== null) {
    const imagePath = match[2].trim()
    
    // 跳过外链和绝对 URL
    if (
      imagePath.startsWith('http://') ||
      imagePath.startsWith('https://') ||
      imagePath.startsWith('data:') ||
      imagePath.startsWith('blob:')
    ) {
      continue
    }
    
    // 移除查询参数
    const cleanPath = imagePath.split('?')[0]
    
    if (!cleanPath) continue
    
    // 标准化路径分隔符
    const normalizedPath = cleanPath.replace(/\\/g, '/')
    
    if (!imagePaths.includes(normalizedPath)) {
      imagePaths.push(normalizedPath)
    }
  }
  
  console.log(`[ImageSync] Extracted ${imagePaths.length} image paths from content`)
  return imagePaths
}

/**
 * 获取图片的绝对路径
 * @param relativePath 相对于工作区的路径
 * @returns 包含完整路径和 baseDir 的选项
 */
export async function getImageFullPath(relativePath: string): Promise<{
  path: string
  baseDir?: BaseDirectory
} | null> {
  try {
    const pathOptions = await getFilePathOptions(relativePath)
    return pathOptions
  } catch {
    console.error(`[ImageSync] Failed to get full path for: ${relativePath}`)
    return null
  }
}

/**
 * 读取本地图片文件内容
 * @param relativePath 相对于工作区的图片路径
 * @returns 图片的 Uint8Array 内容
 */
export async function readLocalImage(relativePath: string): Promise<Uint8Array | null> {
  try {
    const workspace = await getWorkspacePath()
    const pathOptions = await getFilePathOptions(relativePath)
    
    let content: Uint8Array
    
    if (workspace.isCustom) {
      content = await readFile(pathOptions.path)
    } else {
      content = await readFile(pathOptions.path, { baseDir: pathOptions.baseDir as any })
    }
    
    return content
  } catch {
    console.error(`[ImageSync] Failed to read image: ${relativePath}`)
    return null
  }
}

// ============== 各平台图片上传 ==============

/**
 * 获取代理配置
 */
async function getProxyConfig(): Promise<{ all: string } | undefined> {
  const store = await Store.load('store.json')
  const proxyUrl = await store.get<string>('proxy')
  return proxyUrl ? { all: proxyUrl } : undefined
}

/**
 * 上传二进制文件到 GitHub
 */
async function uploadBinaryToGithub(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('accessToken')
  const username = await store.get<string>('githubUsername')
  
  if (!accessToken || !username) {
    console.error('[ImageSync] GitHub: Missing accessToken or username')
    return null
  }
  
  const repo = await getSyncRepoName('github')
  const proxy = await getProxyConfig()
  
  try {
    // 先获取现有文件的 SHA（如果存在）
    let sha: string | undefined
    try {
      const fileInfo = await getRemoteFileInfo(remotePath)
      sha = fileInfo.sha
    } catch {
      // 文件不存在，不需要 SHA
    }
    
    // 将二进制内容转为 Base64
    const base64Content = uint8ArrayToBase64(content)
    
    const headers = new Headers()
    headers.append('Authorization', `Bearer ${accessToken}`)
    headers.append('Accept', 'application/vnd.github+json')
    headers.append('X-GitHub-Api-Version', '2022-11-28')
    headers.append('Content-Type', 'application/json')
    
    const url = `https://api.github.com/repos/${username}/${repo}/contents/${remotePath.replace(/\s/g, '_').split('/').map(encodeURIComponent).join('/')}`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message,
        content: base64Content,
        sha
      }),
      proxy
    })
    
    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      return { sha: data.content.sha }
    }
    
    const errorData = await response.json()
    console.error('[ImageSync] GitHub upload failed:', errorData.message)
    return null
  } catch (error) {
    console.error('[ImageSync] GitHub upload error:', error)
    return null
  }
}

/**
 * 上传二进制文件到 Gitee
 */
async function uploadBinaryToGitee(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('giteeAccessToken')
  
  if (!accessToken) {
    console.error('[ImageSync] Gitee: Missing accessToken')
    return null
  }
  
  const repo = await getSyncRepoName('gitee')
  const proxy = await getProxyConfig()
  
  try {
    // 先获取现有文件的 SHA
    let sha: string | undefined
    try {
      const fileInfo = await getRemoteFileInfo(remotePath)
      sha = fileInfo.sha
    } catch {
      // 文件不存在
    }
    
    const base64Content = uint8ArrayToBase64(content)
    
    const headers = new Headers()
    headers.append('Content-Type', 'application/json')
    
    const url = `https://gitee.com/api/v5/repos/${repo}/contents/${remotePath.replace(/\s/g, '_').split('/').map(encodeURIComponent).join('/')}`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        access_token: accessToken,
        message,
        content: base64Content,
        sha
      }),
      proxy
    })
    
    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      return { sha: data.sha }
    }
    
    const errorData = await response.json()
    console.error('[ImageSync] Gitee upload failed:', errorData.message)
    return null
  } catch (error) {
    console.error('[ImageSync] Gitee upload error:', error)
    return null
  }
}

/**
 * 上传二进制文件到 GitLab
 */
async function uploadBinaryToGitlab(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('gitlabAccessToken')
  
  if (!accessToken) {
    console.error('[ImageSync] GitLab: Missing accessToken')
    return null
  }
  
  const repo = await getSyncRepoName('gitlab')
  const proxy = await getProxyConfig()
  
  try {
    const base64Content = uint8ArrayToBase64(content)
    
    const headers = new Headers()
    headers.append('PRIVATE-TOKEN', accessToken)
    headers.append('Content-Type', 'application/json')
    
    const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${remotePath.replace(/\s/g, '_').split('/').map(encodeURIComponent).join('/')}`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        branch: 'main',
        content: base64Content,
        commit_message: message
      }),
      proxy
    })
    
    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      return { sha: data.blob_id }
    }
    
    const errorData = await response.json()
    console.error('[ImageSync] GitLab upload failed:', errorData.message)
    return null
  } catch (error) {
    console.error('[ImageSync] GitLab upload error:', error)
    return null
  }
}

/**
 * 上传二进制文件到 Gitea
 */
async function uploadBinaryToGitea(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('giteaAccessToken')
  
  if (!accessToken) {
    console.error('[ImageSync] Gitea: Missing accessToken')
    return null
  }
  
  const repo = await getSyncRepoName('gitea')
  const giteaUrl = await store.get<string>('giteaUrl') || 'https://gitea.com'
  const proxy = await getProxyConfig()
  
  try {
    // 先获取现有文件的 SHA
    let sha: string | undefined
    try {
      const fileInfo = await getRemoteFileInfo(remotePath)
      sha = fileInfo.sha
    } catch {
      // 文件不存在
    }
    
    const base64Content = uint8ArrayToBase64(content)
    
    const headers = new Headers()
    headers.append('Authorization', `Bearer ${accessToken}`)
    headers.append('Content-Type', 'application/json')
    
    const url = `${giteaUrl}/api/v1/repos/${repo}/contents/${remotePath.replace(/\s/g, '_').split('/').map(encodeURIComponent).join('/')}`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message,
        content: base64Content,
        sha
      }),
      proxy
    })
    
    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      return { sha: data.sha }
    }
    
    const errorData = await response.json()
    console.error('[ImageSync] Gitea upload failed:', errorData.message)
    return null
  } catch (error) {
    console.error('[ImageSync] Gitea upload error:', error)
    return null
  }
}

/**
 * 上传二进制文件到 S3
 */
async function uploadBinaryToS3(
  content: Uint8Array,
  remotePath: string
): Promise<{ etag: string } | null> {
  const store = await Store.load('store.json')
  const config = await store.get<S3Config>('s3SyncConfig')
  
  if (!config || !config.accessKeyId || !config.secretAccessKey || !config.region || !config.bucket) {
    console.error('[ImageSync] S3: Config not found or incomplete')
    return null
  }
  
  const proxy = await getProxyConfig()
  
  try {
    // S3 上传二进制内容
    const url = buildS3Url(config, remotePath)
    
    const headers = {
      Host: new URL(url).host,
      'Content-Type': getMimeType(remotePath),
      'Content-Length': content.byteLength.toString()
    }
    
    const { authorization, amzDate, payloadHashHex } = await generateS3Signature(
      'PUT',
      url,
      headers,
      content,
      config
    )
    
    const requestHeaders = new Headers()
    requestHeaders.append('Authorization', authorization)
    requestHeaders.append('X-Amz-Date', amzDate)
    requestHeaders.append('Content-Type', getMimeType(remotePath))
    requestHeaders.append('X-Amz-Content-Sha256', payloadHashHex)
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: requestHeaders,
      body: content,
      proxy
    })
    
    if (response.status === 200 || response.status === 204) {
      const etag = response.headers.get('ETag') || ''
      return { etag }
    }
    
    console.error('[ImageSync] S3 upload failed:', response.status)
    return null
  } catch (error) {
    console.error('[ImageSync] S3 upload error:', error)
    return null
  }
}

/**
 * 上传二进制文件到 WebDAV
 */
async function uploadBinaryToWebDAV(
  content: Uint8Array,
  remotePath: string
): Promise<{ etag: string } | null> {
  const store = await Store.load('store.json')
  const config = await store.get<WebDAVConfig>('webdavSyncConfig')
  
  if (!config || !config.url || !config.username || !config.password) {
    console.error('[ImageSync] WebDAV: Config not found or incomplete')
    return null
  }
  
  const proxy = await getProxyConfig()
  
  try {
    // 确保父目录存在
    await ensureWebDAVDirsExist(config, remotePath, proxy)
    
    const baseUrl = config.url.replace(/\/$/, '')
    const prefix = config.pathPrefix ? config.pathPrefix.trim().replace(/\/+$/, '') : ''
    const fullPath = prefix ? `${prefix}/${remotePath}` : remotePath
    const url = `${baseUrl}/${fullPath}`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${btoa(`${config.username}:${config.password}`)}`,
        'Content-Type': getMimeType(remotePath),
        'Content-Length': content.byteLength.toString()
      },
      body: content,
      proxy
    })
    
    if (response.status === 201 || response.status === 204) {
      const etag = response.headers.get('ETag') || ''
      return { etag }
    }
    
    console.error('[ImageSync] WebDAV upload failed:', response.status)
    return null
  } catch (error) {
    console.error('[ImageSync] WebDAV upload error:', error)
    return null
  }
}

/**
 * 获取当前同步平台
 */
async function getCurrentPlatform(): Promise<'github' | 'gitee' | 'gitlab' | 'gitea' | 's3' | 'webdav'> {
  const store = await Store.load('store.json')
  return (await store.get<string>('primaryBackupMethod') || 'github') as any
}

// ============== 辅助函数 ==============

/**
 * Uint8Array 转 Base64
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ''
  const len = data.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const mimeTypes: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
    'avif': 'image/avif',
    'heic': 'image/heic',
    'heif': 'image/heif'
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * S3 URL 构建
 */
function buildS3Url(config: S3Config, key: string): string {
  const endpoint = (config.endpoint || `https://s3.${config.region}.amazonaws.com`).trim()
  const bucket = config.bucket.trim()
  const cleanEndpoint = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint
  const prefix = config.pathPrefix ? config.pathPrefix.trim().replace(/\/+$/, '') : ''
  const fullKey = prefix ? `${prefix}/${key}` : key
  
  const isAliyun = cleanEndpoint.includes('aliyuncs.com')
  const isAWS = cleanEndpoint.includes('amazonaws.com')
  
  if (isAliyun || isAWS) {
    try {
      const urlObj = new URL(cleanEndpoint)
      urlObj.hostname = `${bucket}.${urlObj.hostname}`
      return `${urlObj.toString()}/${fullKey}`.replace(/([^:]\/)\/+/g, '$1')
    } catch {
      return `${cleanEndpoint}/${bucket}/${fullKey}`
    }
  }
  
  return `${cleanEndpoint}/${bucket}/${fullKey}`
}

/**
 * S3 签名生成（简化版，用于二进制上传）
 */
async function generateS3Signature(
  method: string,
  url: string,
  headers: Record<string, string>,
  payload: Uint8Array,
  config: S3Config
): Promise<{ authorization: string; amzDate: string; payloadHashHex: string }> {
  const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '')
  headers['x-amz-date'] = amzDate
  
  const urlObj = new URL(url)
  const canonicalUri = urlObj.pathname
  const canonicalQuerystring = ''
  
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(key => `${key.toLowerCase()}:${headers[key].trim()}\n`)
    .join('')
  
  const signedHeaders = Object.keys(headers).sort().map(key => key.toLowerCase()).join(';')
  
  const payloadHash = await crypto.subtle.digest('SHA-256', payload)
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHashHex
  ].join('\n')
  
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n')
  
  const signingKey = await getS3SigningKey(config.secretAccessKey, dateStamp, config.region, 's3')
  const signature = await hmacSha256Hex(signingKey, stringToSign)
  
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHashHex
  }
}

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getS3SigningKey(key: string, dateStamp: string, region: string, service: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const kSecret = await crypto.subtle.importKey('raw', encoder.encode('AWS4' + key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kDate = await crypto.subtle.sign('HMAC', kSecret, encoder.encode(dateStamp))
  const kDateKey = await crypto.subtle.importKey('raw', kDate, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kRegion = await crypto.subtle.sign('HMAC', kDateKey, encoder.encode(region))
  const kRegionKey = await crypto.subtle.importKey('raw', kRegion, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kService = await crypto.subtle.sign('HMAC', kRegionKey, encoder.encode(service))
  const kServiceKey = await crypto.subtle.importKey('raw', kService, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const kSigning = await crypto.subtle.sign('HMAC', kServiceKey, encoder.encode('aws4_request'))
  return crypto.subtle.importKey('raw', kSigning, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function hmacSha256Hex(key: CryptoKey, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 确保 WebDAV 父目录存在
 */
async function ensureWebDAVDirsExist(config: WebDAVConfig, key: string, proxy?: { all: string } | undefined): Promise<void> {
  const baseUrl = config.url.replace(/\/$/, '')
  const pathPrefix = config.pathPrefix ? config.pathPrefix.trim().replace(/\/+$/, '') : ''
  const parts = key.split('/').filter(p => p)
  
  for (let i = 1; i < parts.length; i++) {
    const subPath = parts.slice(0, i).join('/')
    const fullSubPath = pathPrefix ? `${pathPrefix}/${subPath}` : subPath
    
    await fetch(`${baseUrl}/${fullSubPath}`, {
      method: 'MKCOL',
      headers: {
        'Authorization': `Basic ${btoa(`${config.username}:${config.password}`)}`
      },
      proxy
    })
  }
}

// ============== 核心导出函数 ==============

/**
 * 上传单张本地图片到远程
 * @param localPath 本地图片相对路径
 * @returns 上传结果
 */
export async function uploadImageForSync(localPath: string): Promise<ImageSyncResult> {
  const result: ImageSyncResult = {
    success: false,
    path: localPath,
    remotePath: localPath
  }
  
  // 读取本地图片
  const content = await readLocalImage(localPath)
  if (!content) {
    result.error = 'Failed to read local image'
    return result
  }
  
  const platform = await getCurrentPlatform()
  const message = `Upload image: ${localPath}`
  
  try {
    let uploadResult: { sha?: string; etag?: string } | null = null
    
    switch (platform) {
      case 'github':
        uploadResult = await uploadBinaryToGithub(content, localPath, message)
        if (uploadResult) {
          result.sha = uploadResult.sha
        }
        break
      case 'gitee':
        uploadResult = await uploadBinaryToGitee(content, localPath, message)
        if (uploadResult) {
          result.sha = uploadResult.sha
        }
        break
      case 'gitlab':
        uploadResult = await uploadBinaryToGitlab(content, localPath, message)
        if (uploadResult) {
          result.sha = uploadResult.sha
        }
        break
      case 'gitea':
        uploadResult = await uploadBinaryToGitea(content, localPath, message)
        if (uploadResult) {
          result.sha = uploadResult.sha
        }
        break
      case 's3':
        uploadResult = await uploadBinaryToS3(content, localPath)
        if (uploadResult) {
          result.sha = uploadResult.etag
        }
        break
      case 'webdav':
        uploadResult = await uploadBinaryToWebDAV(content, localPath)
        if (uploadResult) {
          result.sha = uploadResult.etag
        }
        break
    }
    
    result.success = uploadResult !== null
    if (!result.success) {
      result.error = `Upload failed for platform: ${platform}`
    }
  } catch (error) {
    result.error = String(error)
  }
  
  return result
}

/**
 * 同步文档关联的所有本地图片
 * @param docPath 文档路径
 * @param content 文档内容
 * @param onProgress 进度回调 (current, total, imagePath)
 * @returns 同步结果
 */
export async function syncImagesForDocument(
  docPath: string,
  content: string,
  onProgress?: (current: number, total: number, imagePath: string) => void
): Promise<DocumentImageSyncResult> {
  const result: DocumentImageSyncResult = {
    documentPath: docPath,
    images: [],
    totalImages: 0,
    successCount: 0,
    failedCount: 0
  }
  
  // 提取本地图片路径
  const imagePaths = extractLocalImagePaths(content)
  result.totalImages = imagePaths.length
  
  if (imagePaths.length === 0) {
    return result
  }
  
  console.log(`[ImageSync] Found ${imagePaths.length} images in ${docPath}`)
  
  // 上传每张图片
  for (let i = 0; i < imagePaths.length; i++) {
    const imagePath = imagePaths[i]
    
    onProgress?.(i + 1, imagePaths.length, imagePath)
    
    const imageResult = await uploadImageForSync(imagePath)
    result.images.push(imageResult)
    
    if (imageResult.success) {
      result.successCount++
    } else {
      result.failedCount++
    }
  }
  
  console.log(`[ImageSync] Synced ${result.successCount}/${result.totalImages} images for ${docPath}`)
  
  return result
}

/**
 * 检查图片是否需要上传（基于 SHA 比较）
 * @param localPath 本地图片路径
 * @returns 是否需要上传
 */
export async function isImageNeedUpload(localPath: string): Promise<boolean> {
  try {
    const info = await getRemoteFileInfo(localPath)
    // 如果远程文件存在，需要上传
    return !info.sha
  } catch {
    // 文件不存在，需要上传
    return true
  }
}

/**
 * 批量同步工作区中的所有图片
 * @param imagePaths 图片路径数组
 * @param onProgress 进度回调
 * @returns 同步结果
 */
export async function syncMultipleImages(
  imagePaths: string[],
  onProgress?: (current: number, total: number, imagePath: string) => void
): Promise<{
  total: number
  success: number
  failed: number
  results: ImageSyncResult[]
}> {
  const results: ImageSyncResult[] = []
  let success = 0
  let failed = 0
  
  for (let i = 0; i < imagePaths.length; i++) {
    const path = imagePaths[i]
    
    onProgress?.(i + 1, imagePaths.length, path)
    
    const result = await uploadImageForSync(path)
    results.push(result)
    
    if (result.success) {
      success++
    } else {
      failed++
    }
  }
  
  return { total: imagePaths.length, success, failed, results }
}
