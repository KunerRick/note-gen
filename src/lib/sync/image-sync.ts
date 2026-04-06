import { Store } from '@tauri-apps/plugin-store'
import { readFile, stat, exists, writeFile, mkdir } from '@tauri-apps/plugin-fs'
import { getWorkspacePath, getFilePathOptions } from '@/lib/workspace'
import { getSyncRepoName } from './repo-utils'
import { getRemoteFileInfo } from './auto-sync'
import { fetch } from '@tauri-apps/plugin-http'
import { buildRepoContentPath, buildRepoContentsEndpoint } from './remote-file'
import type { S3Config, WebDAVConfig } from '@/types/sync'

/**
 * 图片同步模块
 * 负责解析 Markdown 中的本地图片路径，并上传到 Gitee
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

// ============== 图片同步状态缓存 ==============
// 用于记录已同步图片的远程 SHA，避免重复上传

const IMAGE_SYNC_CACHE_KEY = 'imageSyncCache'

interface ImageSyncCacheEntry {
  remoteSha: string      // 远程 Git blob SHA
  mtime: number          // 本地文件修改时间
  size: number           // 本地文件大小
  syncedAt: number       // 同步时间戳
}

/**
 * 获取图片同步缓存
 */
async function getImageSyncCache(): Promise<Record<string, ImageSyncCacheEntry>> {
  const store = await Store.load('store.json')
  return (await store.get<Record<string, ImageSyncCacheEntry>>(IMAGE_SYNC_CACHE_KEY)) || {}
}

/**
 * 设置图片同步缓存
 */
async function setImageSyncCache(cache: Record<string, ImageSyncCacheEntry>): Promise<void> {
  const store = await Store.load('store.json')
  await store.set(IMAGE_SYNC_CACHE_KEY, cache)
}

/**
 * 更新图片同步缓存
 */
async function updateImageSyncCache(
  imagePath: string,
  remoteSha: string,
  mtime: number,
  size: number
): Promise<void> {
  const cache = await getImageSyncCache()
  cache[imagePath] = {
    remoteSha,
    mtime,
    size,
    syncedAt: Date.now()
  }
  await setImageSyncCache(cache)
  console.log(`[ImageSync] Updated sync cache for ${imagePath}: ${remoteSha}`)
}

/**
 * 检查本地图片文件是否存在
 */
async function isLocalImageExists(imagePath: string): Promise<boolean> {
  try {
    const workspace = await getWorkspacePath()
    const pathOptions = await getFilePathOptions(imagePath)

    return workspace.isCustom
      ? await exists(pathOptions.path)
      : await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
  } catch (error) {
    console.error(`[ImageSync] Failed to check file existence for ${imagePath}:`, error)
    return false
  }
}

/**
 * 获取本地图片文件信息
 */
async function getLocalImageInfo(imagePath: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const workspace = await getWorkspacePath()
    const pathOptions = await getFilePathOptions(imagePath)

    const fileStat = workspace.isCustom
      ? await stat(pathOptions.path)
      : await stat(pathOptions.path, { baseDir: pathOptions.baseDir })

    return {
      mtime: fileStat.mtime?.getTime() || 0,
      size: fileStat.size || 0
    }
  } catch (error) {
    console.error(`[ImageSync] Failed to get local file info for ${imagePath}:`, error)
    return null
  }
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
 * 读取本地图片文件内容
 * @param relativePath 相对于工作区的图片路径
 * @returns 图片的 Uint8Array 内容
 */
export async function readLocalImage(relativePath: string): Promise<Uint8Array | null> {
  try {
    console.log(`[ImageSync] Reading local image: ${relativePath}`)
    const workspace = await getWorkspacePath()
    const pathOptions = await getFilePathOptions(relativePath)

    let content: Uint8Array

    if (workspace.isCustom) {
      console.log(`[ImageSync] Reading from custom workspace: ${pathOptions.path}`)
      content = await readFile(pathOptions.path)
    } else {
      console.log(`[ImageSync] Reading from default workspace: ${pathOptions.path} with baseDir: ${pathOptions.baseDir}`)
      content = await readFile(pathOptions.path, { baseDir: pathOptions.baseDir as any })
    }

    console.log(`[ImageSync] Image read successfully, size: ${content.byteLength} bytes`)
    return content
  } catch (error) {
    console.error(`[ImageSync] Failed to read image: ${relativePath}`, error)
    return null
  }
}

// ============== 平台特定配置 ==============

/**
 * 获取代理配置
 */
async function getProxyConfig(): Promise<{ all: string } | undefined> {
  const store = await Store.load('store.json')
  const proxyUrl = await store.get<string>('proxy')
  return proxyUrl ? { all: proxyUrl } : undefined
}

/**
 * 获取当前同步平台
 */
async function getCurrentPlatform(): Promise<'github' | 'gitee' | 'gitlab' | 'gitea' | 's3' | 'webdav'> {
  const store = await Store.load('store.json')
  return (await store.get<string>('primaryBackupMethod') || 'github') as any
}

/**
 * 获取 S3 配置
 */
async function getS3Config(): Promise<S3Config | null> {
  const store = await Store.load('store.json')
  const config = await store.get<S3Config>('s3SyncConfig')
  if (config && config.accessKeyId && config.secretAccessKey && config.region && config.bucket) {
    return config
  }
  return null
}

/**
 * 获取 WebDAV 配置
 */
async function getWebDAVConfig(): Promise<WebDAVConfig | null> {
  const store = await Store.load('store.json')
  const config = await store.get<WebDAVConfig>('webdavSyncConfig')
  if (config && config.url && config.username && config.password) {
    return config
  }
  return null
}

// ============== GitHub 图片上传 ==============

/**
 * 上传二进制文件到 GitHub
 */
async function uploadBinaryToGitHub(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('accessToken')
  const githubUsername = await store.get<string>('githubUsername')

  if (!accessToken || !githubUsername) {
    console.error('[ImageSync] GitHub: Missing accessToken or githubUsername')
    return null
  }

  const repo = await getSyncRepoName('github')
  const proxy = await getProxyConfig()

  try {
    // 先获取现有文件的 SHA
    let sha: string | undefined
    try {
      const { getFiles } = await import('./github')
      const fileInfo = await getFiles({ path: remotePath, repo })
      if (fileInfo && !Array.isArray(fileInfo)) {
        sha = fileInfo.sha
      }
    } catch {
      // 文件不存在
    }

    const base64Content = Buffer.from(content).toString('base64')

    const headers = new Headers()
    headers.append('Authorization', `Bearer ${accessToken}`)
    headers.append('Content-Type', 'application/json')

    const finalPath = buildRepoContentPath({ path: remotePath })
    const url = `https://api.github.com/repos/${githubUsername}/${repo}${buildRepoContentsEndpoint(finalPath)}`

    console.log(`[ImageSync] Uploading to GitHub: ${remotePath}`)

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
      const fileSha = data?.content?.sha
      if (fileSha) {
        console.log(`[ImageSync] GitHub upload success, SHA: ${fileSha}`)
        return { sha: fileSha }
      }
    }

    const errorData = await response.json().catch(() => ({}))
    console.error('[ImageSync] GitHub upload failed:', errorData.message || `HTTP ${response.status}`)
    return null
  } catch (error) {
    console.error('[ImageSync] GitHub upload exception:', error)
    return null
  }
}

// ============== GitLab 图片上传 ==============

/**
 * 获取 GitLab API 基础 URL
 */
async function getGitlabApiBaseUrl(): Promise<string> {
  const store = await Store.load('store.json')
  const gitlabUrl = await store.get<string>('gitlabUrl') || 'https://gitlab.com'
  return `${gitlabUrl}/api/v4`
}

/**
 * 上传二进制文件到 GitLab
 * 使用 Commits API 简化实现
 */
async function uploadBinaryToGitLab(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('gitlabAccessToken')
  const branch = await store.get<string>('gitlabBranch') || 'main'

  if (!accessToken) {
    console.error('[ImageSync] GitLab: Missing accessToken')
    return null
  }

  const repo = await getSyncRepoName('gitlab')
  const proxy = await getProxyConfig()

  try {
    const base64Content = Buffer.from(content).toString('base64')

    // 获取 GitLab API 基础 URL
    const baseUrl = await getGitlabApiBaseUrl()

    // 获取项目 ID
    const projectId = await store.get<string>(`gitlab_${repo}_project_id`)
    if (!projectId) {
      console.error('[ImageSync] GitLab: Missing project ID')
      return null
    }

    const headers = new Headers()
    headers.append('PRIVATE-TOKEN', accessToken)
    headers.append('Content-Type', 'application/json')

    // 标准化路径（将空格转为下划线）
    const normalizedPath = remotePath.replace(/\s/g, '_')

    console.log(`[ImageSync] Uploading to GitLab: ${remotePath}`)

    // 使用 Commits API 创建/更新文件
    const commitsApiUrl = `${baseUrl}/projects/${projectId}/repository/commits`

    // 先尝试获取文件信息来确定是创建还是更新
    let action: 'create' | 'update' = 'create'
    try {
      const fileUrl = `${baseUrl}/projects/${projectId}/repository/files/${encodeURIComponent(normalizedPath)}?ref=${branch}`
      const fileResponse = await fetch(fileUrl, {
        method: 'GET',
        headers,
        proxy
      })
      if (fileResponse.ok) {
        action = 'update'
      }
    } catch {
      // 文件不存在，使用 create
    }

    const commitBody = {
      branch,
      commit_message: message || `Upload image: ${remotePath}`,
      actions: [{
        action,
        file_path: normalizedPath,
        content: base64Content,
        encoding: 'base64'
      }]
    }

    const response = await fetch(commitsApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(commitBody),
      proxy
    })

    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      const fileSha = data?.id || data?.sha
      if (fileSha) {
        console.log(`[ImageSync] GitLab upload success, SHA: ${fileSha}`)
        return { sha: fileSha }
      }
    }

    const errorData = await response.json().catch(() => ({}))
    console.error('[ImageSync] GitLab upload failed:', errorData.message || `HTTP ${response.status}`)
    return null
  } catch (error) {
    console.error('[ImageSync] GitLab upload exception:', error)
    return null
  }
}

// ============== Gitea 图片上传 ==============

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
  const giteaUrl = await store.get<string>('giteaUrl')
  const branch = await store.get<string>('giteaBranch') || 'main'

  if (!accessToken || !giteaUrl) {
    console.error('[ImageSync] Gitea: Missing accessToken or giteaUrl')
    return null
  }

  const repo = await getSyncRepoName('gitea')
  const proxy = await getProxyConfig()

  try {
    // 先获取现有文件的 SHA
    let sha: string | undefined
    try {
      const { getFileContent } = await import('./gitea')
      const fileInfo = await getFileContent({ path: remotePath, ref: branch, repo })
      if (fileInfo && !Array.isArray(fileInfo) && 'sha' in fileInfo) {
        sha = (fileInfo as { sha: string }).sha
      }
    } catch {
      // 文件不存在
    }

    const base64Content = Buffer.from(content).toString('base64')

    const headers = new Headers()
    headers.append('Authorization', `token ${accessToken}`)
    headers.append('Content-Type', 'application/json')

    const finalPath = buildRepoContentPath({ path: remotePath })
    const url = `${giteaUrl}/api/v1/repos/${repo}${buildRepoContentsEndpoint(finalPath)}`

    console.log(`[ImageSync] Uploading to Gitea: ${remotePath}`)

    // 构建请求体
    const requestBody: Record<string, string> = {
      message,
      content: base64Content,
      branch
    }
    // 只有在更新时才添加 sha
    if (sha) {
      requestBody.sha = sha
    }

    const response = await fetch(url, {
      method: sha ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(requestBody),
      proxy
    })

    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      const fileSha = data?.content?.sha || data?.sha
      if (fileSha) {
        console.log(`[ImageSync] Gitea upload success, SHA: ${fileSha}`)
        return { sha: fileSha }
      }
    }

    const errorData = await response.json().catch(() => ({}))
    console.error('[ImageSync] Gitea upload failed:', errorData.message || `HTTP ${response.status}`)
    return null
  } catch (error) {
    console.error('[ImageSync] Gitea upload exception:', error)
    return null
  }
}

// ============== S3 图片上传 ==============

/**
 * 上传二进制文件到 S3
 */
async function uploadBinaryToS3(
  content: Uint8Array,
  remotePath: string
): Promise<{ sha: string } | null> {
  const s3Config = await getS3Config()
  if (!s3Config) {
    console.error('[ImageSync] S3: Missing configuration')
    return null
  }

  const proxy = await getProxyConfig()

  try {
    console.log(`[ImageSync] Uploading to S3: ${remotePath}`)

    const { s3Upload } = await import('./s3')

    // S3 需要字符串内容，将 Uint8Array 转换为 base64 字符串
    const base64Content = Buffer.from(content).toString('base64')

    const result = await s3Upload(s3Config, remotePath, base64Content, proxy)

    if (result && result.etag) {
      console.log(`[ImageSync] S3 upload success, ETag: ${result.etag}`)
      return { sha: result.etag }
    }

    console.error('[ImageSync] S3 upload failed: no ETag in response')
    return null
  } catch (error) {
    console.error('[ImageSync] S3 upload exception:', error)
    return null
  }
}

// ============== WebDAV 图片上传 ==============

/**
 * 上传二进制文件到 WebDAV
 */
async function uploadBinaryToWebDAV(
  content: Uint8Array,
  remotePath: string
): Promise<{ sha: string } | null> {
  const webdavConfig = await getWebDAVConfig()
  if (!webdavConfig) {
    console.error('[ImageSync] WebDAV: Missing configuration')
    return null
  }

  const proxy = await getProxyConfig()

  try {
    console.log(`[ImageSync] Uploading to WebDAV: ${remotePath}`)

    const { webdavUpload } = await import('./webdav')

    // WebDAV 需要字符串内容
    const base64Content = Buffer.from(content).toString('base64')

    const result = await webdavUpload(webdavConfig, remotePath, base64Content, proxy)

    if (result) {
      const etag = result.etag || 'uploaded'
      console.log(`[ImageSync] WebDAV upload success, ETag: ${etag}`)
      return { sha: etag }
    }

    console.error('[ImageSync] WebDAV upload failed')
    return null
  } catch (error) {
    console.error('[ImageSync] WebDAV upload exception:', error)
    return null
  }
}

// ============== Gitee 图片上传 ==============

/**
 * 上传二进制文件到 Gitee
 * 使用与 gitee.ts 相同的逻辑确保一致性
 */
async function uploadBinaryToGitee(
  content: Uint8Array,
  remotePath: string,
  message: string = 'Upload image'
): Promise<{ sha: string } | null> {
  const store = await Store.load('store.json')
  const accessToken = await store.get<string>('giteeAccessToken')
  const giteeUsername = await store.get<string>('giteeUsername')

  if (!accessToken || !giteeUsername) {
    console.error('[ImageSync] Gitee: Missing accessToken or giteeUsername')
    return null
  }

  const repo = await getSyncRepoName('gitee')
  const proxy = await getProxyConfig()

  try {
    // 先获取现有文件的 SHA（复用 gitee.ts 的逻辑）
    let sha: string | undefined
    let targetPath = remotePath
    let resolvedExistingFile: { path?: string; sha?: string } | null = null

    try {
      const fileInfo = await getRemoteFileInfo(remotePath)
      if (fileInfo && fileInfo.sha) {
        resolvedExistingFile = fileInfo
        sha = fileInfo.sha
      }
    } catch {
      // 文件不存在，继续创建新文件
    }

    // 使用 Buffer 进行 Base64 编码（与 gitee.ts 一致）
    const base64Content = Buffer.from(content).toString('base64')

    const headers = new Headers()
    headers.append('Content-Type', 'application/json')

    // 构建目标路径（与 gitee.ts 逻辑一致）
    if (resolvedExistingFile?.path) {
      targetPath = resolvedExistingFile.path
    }

    const finalPath = buildRepoContentPath({ path: targetPath })
    const url = `https://gitee.com/api/v5/repos/${giteeUsername}/${repo}${buildRepoContentsEndpoint(finalPath)}`

    console.log(`[ImageSync] Uploading to Gitee: ${url}`)

    // 根据是否有 sha 决定使用 PUT（更新）还是 POST（创建）
    const requestOptions = {
      method: sha ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify({
        access_token: accessToken,
        content: base64Content,
        message: message || `Upload image: ${remotePath}`,
        branch: 'master',
        sha
      }),
      proxy
    }

    const response = await fetch(url, requestOptions)

    if (response.status >= 200 && response.status < 300) {
      const data = await response.json()
      // Gitee API 返回的是 data.content.sha
      const fileSha = data?.content?.sha || data?.sha
      if (fileSha) {
        console.log(`[ImageSync] Gitee upload success, SHA: ${fileSha}`)
        return { sha: fileSha }
      }
      console.error('[ImageSync] Gitee upload response missing SHA:', data)
      return null
    }

    // 处理 404 错误：文件不存在，尝试用 POST 创建
    if (response.status === 404 && sha) {
      console.log('[ImageSync] File not found with SHA, trying POST to create new file')
      const postOptions = {
        method: 'POST',
        headers,
        body: JSON.stringify({
          access_token: accessToken,
          content: base64Content,
          message: message || `Upload image: ${remotePath}`,
          branch: 'master'
        }),
        proxy
      }
      const postResponse = await fetch(url, postOptions)
      if (postResponse.status >= 200 && postResponse.status < 300) {
        const data = await postResponse.json()
        const fileSha = data?.content?.sha || data?.sha
        if (fileSha) {
          console.log(`[ImageSync] Gitee POST upload success, SHA: ${fileSha}`)
          return { sha: fileSha }
        }
      }
      const errorData = await postResponse.json()
      console.error('[ImageSync] Gitee POST upload failed:', errorData)
      return null
    }

    // 处理其他错误
    let errorMessage = `HTTP ${response.status}`
    try {
      const errorData = await response.json()
      errorMessage = errorData.message || errorMessage
      console.error('[ImageSync] Gitee upload failed:', errorData)
    } catch {
      const errorText = await response.text()
      console.error('[ImageSync] Gitee upload failed (non-JSON):', errorText)
    }
    console.error('[ImageSync] Gitee upload error:', errorMessage)
    return null
  } catch (error) {
    console.error('[ImageSync] Gitee upload exception:', error)
    return null
  }
}

// ============== 核心导出函数 ==============

/**
 * 从远程下载图片到本地
 * @param remotePath 远程图片路径（相对路径）
 * @returns 下载结果
 */
export async function downloadImageFromRemote(remotePath: string): Promise<ImageSyncResult> {
  const result: ImageSyncResult = {
    success: false,
    path: remotePath,
    remotePath: remotePath
  }

  console.log(`[ImageSync] Starting download for: ${remotePath}`)

  try {
    // 从远程获取图片内容
    const { pullRemoteImage } = await import('./auto-sync')
    const content = await pullRemoteImage(remotePath)

    if (!content) {
      result.error = 'Failed to fetch remote image'
      console.error(`[ImageSync] Failed to download image: ${remotePath}`)
      return result
    }

    console.log(`[ImageSync] Image downloaded, size: ${content.byteLength} bytes`)

    // 确保目录存在
    const dirPath = remotePath.includes('/') ? remotePath.split('/').slice(0, -1).join('/') : ''
    if (dirPath) {
      const workspace = await getWorkspacePath()
      const pathOptions = await getFilePathOptions(dirPath)

      try {
        let dirExists = false
        if (workspace.isCustom) {
          dirExists = await exists(pathOptions.path)
        } else {
          dirExists = await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
        }

        if (!dirExists) {
          console.log(`[ImageSync] Creating directory: ${dirPath}`)
          if (workspace.isCustom) {
            await mkdir(pathOptions.path, { recursive: true })
          } else {
            await mkdir(pathOptions.path, { baseDir: pathOptions.baseDir, recursive: true })
          }
        }
      } catch (error) {
        console.error(`[ImageSync] Failed to create directory ${dirPath}:`, error)
      }
    }

    // 写入本地文件
    const workspace = await getWorkspacePath()
    const pathOptions = await getFilePathOptions(remotePath)

    if (workspace.isCustom) {
      await writeFile(pathOptions.path, content)
    } else {
      await writeFile(pathOptions.path, content, { baseDir: pathOptions.baseDir })
    }

    console.log(`[ImageSync] Image saved to local: ${remotePath}`)

    // 获取文件信息并更新缓存
    const localInfo = await getLocalImageInfo(remotePath)
    if (localInfo) {
      // 获取远程 SHA 用于缓存
      const { getRemoteFileInfo } = await import('./auto-sync')
      const remoteInfo = await getRemoteFileInfo(remotePath)
      if (remoteInfo.sha) {
        await updateImageSyncCache(remotePath, remoteInfo.sha, localInfo.mtime, localInfo.size)
      }
    }

    result.success = true
    console.log(`[ImageSync] Download success: ${remotePath}`)
  } catch (error) {
    result.error = String(error)
    console.error(`[ImageSync] Error during download:`, error)
  }

  return result
}

/**
 * 上传单张本地图片到当前配置的同步平台
 * @param localPath 本地图片相对路径
 * @returns 上传结果
 */
export async function uploadImageForSync(localPath: string): Promise<ImageSyncResult> {
  const result: ImageSyncResult = {
    success: false,
    path: localPath,
    remotePath: localPath
  }

  console.log(`[ImageSync] Starting upload for: ${localPath}`)

  // 读取本地图片
  const content = await readLocalImage(localPath)
  if (!content) {
    result.error = 'Failed to read local image'
    console.error(`[ImageSync] Failed to read image: ${localPath}`)
    return result
  }

  console.log(`[ImageSync] Image read successfully, size: ${content.byteLength} bytes`)

  const message = `Upload image: ${localPath}`

  try {
    // 获取当前平台并调用对应的上传函数
    const platform = await getCurrentPlatform()
    console.log(`[ImageSync] Uploading to ${platform}: ${localPath}`)

    let uploadResult: { sha: string } | null = null

    switch (platform) {
      case 'github':
        uploadResult = await uploadBinaryToGitHub(content, localPath, message)
        break
      case 'gitee':
        uploadResult = await uploadBinaryToGitee(content, localPath, message)
        break
      case 'gitlab':
        uploadResult = await uploadBinaryToGitLab(content, localPath, message)
        break
      case 'gitea':
        uploadResult = await uploadBinaryToGitea(content, localPath, message)
        break
      case 's3':
        uploadResult = await uploadBinaryToS3(content, localPath)
        break
      case 'webdav':
        uploadResult = await uploadBinaryToWebDAV(content, localPath)
        break
      default:
        result.error = `Unsupported platform: ${platform}`
        console.error(`[ImageSync] Unsupported platform: ${platform}`)
        return result
    }

    if (uploadResult) {
      result.sha = uploadResult.sha
      result.success = true
      console.log(`[ImageSync] ${platform} upload success, SHA: ${uploadResult.sha}`)

      // 更新同步缓存
      const localInfo = await getLocalImageInfo(localPath)
      if (localInfo) {
        await updateImageSyncCache(localPath, uploadResult.sha, localInfo.mtime, localInfo.size)
      }
    } else {
      result.error = `Upload failed for platform: ${platform}`
      console.error(`[ImageSync] ${platform} upload failed`)
    }
  } catch (error) {
    result.error = String(error)
    console.error(`[ImageSync] Error during upload:`, error)
  }

  console.log(`[ImageSync] Upload result:`, result)
  return result
}

/**
 * 同步文档关联的所有本地图片（双向同步）
 * @param docPath 文档路径
 * @param content 文档内容
 * @param onProgress 进度回调 (current, total, imagePath, action)
 * @returns 同步结果
 */
export async function syncImagesForDocument(
  docPath: string,
  content: string,
  onProgress?: (current: number, total: number, imagePath: string, action: string) => void
): Promise<DocumentImageSyncResult> {
  const startTime = performance.now()
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
    console.log(`[ImageSync] No images found in ${docPath}, took ${(performance.now() - startTime).toFixed(0)}ms`)
    return result
  }

  console.log(`[ImageSync] Found ${imagePaths.length} images in ${docPath}, starting bidirectional sync...`)

  // 同步每张图片
  for (let i = 0; i < imagePaths.length; i++) {
    const imagePath = imagePaths[i]
    const imgStartTime = performance.now()

    try {
      // 决定同步方向
      const decision = await resolveImageSyncDirection(imagePath)
      console.log(`[ImageSync] ${imagePath}: ${decision.direction} (${decision.reason})`)

      let imageResult: ImageSyncResult

      switch (decision.direction) {
        case 'download':
          onProgress?.(i + 1, imagePaths.length, imagePath, 'downloading')
          imageResult = await downloadImageFromRemote(imagePath)
          break

        case 'upload':
          onProgress?.(i + 1, imagePaths.length, imagePath, 'uploading')
          imageResult = await uploadImageForSync(imagePath)
          break

        case 'skip':
          onProgress?.(i + 1, imagePaths.length, imagePath, 'skipped')
          imageResult = {
            success: true,
            path: imagePath,
            remotePath: imagePath,
            sha: 'unchanged'
          }
          break

        case 'conflict':
        default:
          onProgress?.(i + 1, imagePaths.length, imagePath, 'conflict')
          imageResult = {
            success: false,
            path: imagePath,
            remotePath: imagePath,
            error: 'Conflict detected, manual resolution needed'
          }
          break
      }

      result.images.push(imageResult)

      if (imageResult.success) {
        result.successCount++
      } else {
        result.failedCount++
      }

      console.log(`[ImageSync] Image ${imagePath} ${decision.direction} in ${(performance.now() - imgStartTime).toFixed(0)}ms`)
    } catch (error) {
      console.error(`[ImageSync] Error processing ${imagePath}:`, error)
      result.images.push({
        success: false,
        path: imagePath,
        remotePath: imagePath,
        error: String(error)
      })
      result.failedCount++
    }
  }

  console.log(`[ImageSync] Synced ${result.successCount}/${result.totalImages} images for ${docPath} in ${(performance.now() - startTime).toFixed(0)}ms`)

  return result
}

/**
 * 检查图片是否需要上传（基于缓存和远程 SHA 比较）
 * 优化：先检查本地文件是否存在，再检查本地缓存，避免不必要的网络请求
 * @param localPath 本地图片路径
 * @returns 是否需要上传
 */
export async function isImageNeedUpload(localPath: string): Promise<boolean> {
  const startTime = performance.now()
  try {
    // 先检查本地文件是否存在
    const fileExists = await isLocalImageExists(localPath)
    if (!fileExists) {
      console.log(`[ImageSync] Local file not found, skip upload: ${localPath} (${(performance.now() - startTime).toFixed(0)}ms)`)
      return false
    }

    // 获取本地文件信息
    const localInfo = await getLocalImageInfo(localPath)
    if (!localInfo) {
      console.log(`[ImageSync] Cannot get local file info, need upload: ${localPath} (${(performance.now() - startTime).toFixed(0)}ms)`)
      return true
    }

    // 先检查缓存：如果本地文件未修改，直接跳过（无需网络请求）
    const cache = await getImageSyncCache()
    const cached = cache[localPath]

    if (cached &&
        cached.mtime === localInfo.mtime &&
        cached.size === localInfo.size) {
      // 本地文件未修改，假设远程也没变化，直接跳过
      console.log(`[ImageSync] Local file unchanged, skip upload: ${localPath} (${(performance.now() - startTime).toFixed(0)}ms)`)
      return false
    }

    // 本地文件已修改，需要查询远程文件信息
    console.log(`[ImageSync] Local file changed, checking remote: ${localPath}`)
    const remoteInfo = await getRemoteFileInfo(localPath)

    // 如果远程文件不存在，需要上传
    if (!remoteInfo.sha) {
      console.log(`[ImageSync] Remote file not found, need upload: ${localPath} (${(performance.now() - startTime).toFixed(0)}ms)`)
      return true
    }

    // 本地文件已修改或远程文件已更新，需要重新上传
    console.log(`[ImageSync] File changed or remote updated, need upload: ${localPath} (${(performance.now() - startTime).toFixed(0)}ms)`)
    return true
  } catch (error) {
    console.error(`[ImageSync] Error checking need upload for ${localPath}:`, error)
    // 出错时默认需要上传
    return true
  }
}

/**
 * 图片同步方向
 */
export type ImageSyncDirection = 'upload' | 'download' | 'skip' | 'conflict'

export interface ImageSyncDecision {
  direction: ImageSyncDirection
  reason: string
  localInfo?: { mtime: number; size: number } | null
  remoteInfo?: { sha?: string; lastModified?: number }
}

/**
 * 决定图片同步方向
 * @param imagePath 图片路径
 * @returns 同步决策
 */
export async function resolveImageSyncDirection(imagePath: string): Promise<ImageSyncDecision> {
  // 检查本地文件是否存在
  const localExists = await isLocalImageExists(imagePath)
  const localInfo = localExists ? await getLocalImageInfo(imagePath) : null

  // 获取远程文件信息
  const remoteInfo = await getRemoteFileInfo(imagePath)
  const remoteExists = !!remoteInfo.sha

  // 决策逻辑
  if (!localExists && !remoteExists) {
    return {
      direction: 'skip',
      reason: 'Neither local nor remote file exists',
      localInfo,
      remoteInfo
    }
  }

  if (!localExists && remoteExists) {
    return {
      direction: 'download',
      reason: 'Local missing, remote exists',
      localInfo,
      remoteInfo
    }
  }

  if (localExists && !remoteExists) {
    return {
      direction: 'upload',
      reason: 'Local exists, remote missing',
      localInfo,
      remoteInfo
    }
  }

  // 两者都存在，需要比较
  if (localInfo && remoteInfo.lastModified) {
    // 如果本地文件较新，上传
    if (localInfo.mtime > remoteInfo.lastModified) {
      return {
        direction: 'upload',
        reason: 'Local file is newer',
        localInfo,
        remoteInfo
      }
    }

    // 如果远程文件较新，下载
    if (remoteInfo.lastModified > localInfo.mtime) {
      return {
        direction: 'download',
        reason: 'Remote file is newer',
        localInfo,
        remoteInfo
      }
    }
  }

  // 检查缓存，如果本地未修改则跳过
  const cache = await getImageSyncCache()
  const cached = cache[imagePath]
  if (cached && localInfo &&
      cached.mtime === localInfo.mtime &&
      cached.size === localInfo.size &&
      cached.remoteSha === remoteInfo.sha) {
    return {
      direction: 'skip',
      reason: 'File unchanged (cache hit)',
      localInfo,
      remoteInfo
    }
  }

  // 默认：本地优先（避免覆盖用户数据）
  return {
    direction: 'upload',
    reason: 'Both exist, default to local priority',
    localInfo,
    remoteInfo
  }
}

/**
 * 批量同步工作区中的所有图片到 Gitee
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
