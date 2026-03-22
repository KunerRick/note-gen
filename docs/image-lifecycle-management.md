# 文档删除时图片生命周期管理方案

## 一、核心挑战

当用户删除包含本地图片引用的文档时，系统面临两个关键问题：

1. **孤立图片识别**：哪些图片仅被当前文档引用？
2. **删除策略选择**：应该彻底删除、保留还是暂存？

## 二、推荐方案：智能回收站机制

### 核心策略：立即扫描 + 引用计数 + 回收站暂存

---

## 三、关键实现流程

### 流程1：删除文档时的图片处理

```typescript
async function deleteDocument(docPath: string) {
  // 步骤1：解析文档引用的所有本地图片
  const imagePaths = extractLocalImagePaths(docPath)
  
  // 步骤2：查询图片引用计数（从索引数据库）
  const referenceCounts = await getImageReferenceCounts(imagePaths)
  
  // 步骤3：分类处理
  for (const imagePath of imagePaths) {
    if (referenceCounts[imagePath] === 1) {
      // 仅被当前文档引用：移动到回收站
      await moveImageToTrash(imagePath)
    } else {
      // 被多个文档引用：保留图片
      console.log(`图片 ${imagePath} 被其他文档引用，保留`)
    }
  }
  
  // 步骤4：删除文档并更新索引
  await deleteFile(docPath)
  await updateImageReferenceIndex()
}
```

**关键要点**：
- 通过引用计数避免误删共享图片
- 所有删除操作先进入回收站，提供恢复机会
- 自动更新图片引用索引

---

### 流程2：引用计数索引维护

```typescript
interface ImageReferenceIndex {
  imagePath: string              // 图片绝对路径
  referencingDocs: string[]      // 引用文档路径列表
  lastReferenced: number         // 最后引用时间戳
  referenceCount: number         // 引用计数（冗余字段）
}

// 文档保存时更新索引
async function updateImageReferenceIndex(docPath: string, content: string) {
  // 1. 提取文档中的图片路径
  const imagePaths = extractLocalImagePaths(content)
  
  // 2. 更新数据库索引
  for (const imagePath of imagePaths) {
    await db.execute(`
      INSERT OR REPLACE INTO image_references 
      (image_path, referencing_docs, last_referenced)
      VALUES (?, ?, ?)
    `, [imagePath, JSON.stringify([docPath]), Date.now()])
  }
  
  // 3. 清理已移除的引用
  await cleanupStaleReferences(docPath, imagePaths)
}
```

**性能优化**：
- 使用 SQLite 索引加速查询
- 增量更新，避免全量扫描
- 后台任务定期重建索引

---

### 流程3：回收站机制

```typescript
const TRASH_DIR = '.note-gen-trash/images'

interface TrashedImage {
  originalPath: string
  trashPath: string
  deletedAt: number
  fileSize: number
  referencedBy: string[]  // 删除时的引用文档列表
}

// 移动图片到回收站
async function moveImageToTrash(imagePath: string) {
  const trashPath = path.join(TRASH_DIR, generateTrashName(imagePath))
  
  // 1. 移动文件
  await moveFile(imagePath, trashPath)
  
  // 2. 记录元数据
  await recordTrashMetadata({
    originalPath: imagePath,
    trashPath,
    deletedAt: Date.now(),
    fileSize: await getFileSize(trashPath),
    referencedBy: await getReferencingDocs(imagePath)
  })
  
  // 3. 同步到远程（如果启用）
  if (syncEnabled) {
    await syncManager.deleteRemoteFile(imagePath)
  }
}

// 回收站管理
class TrashManager {
  async list(): Promise<TrashedImage[]>
  async restore(trashPath: string): Promise<void>
  async empty(): Promise<void>  // 清空30天前的文件
}
```

**安全机制**：
- 回收站目录默认排除在 Git 同步之外
- 30 天后自动永久删除（可配置）
- 记录删除时的引用信息，便于审计

---

### 流程4：定期清理任务

```typescript
// 每周执行一次
async function cleanupUnusedImages() {
  // 1. 全量扫描（作为索引的校验）
  const allImages = await scanWorkspaceImages()
  const referencedImages = await scanAllDocumentReferences()
  
  // 2. 找出真正未使用的图片
  const unusedImages = allImages.filter(img => !referencedImages.has(img))
  
  // 3. 移入回收站并通知用户
  if (unusedImages.length > 0) {
    for (const imagePath of unusedImages) {
      await moveImageToTrash(imagePath)
    }
    
    await showNotification({
      title: `发现 ${unusedImages.length} 张未使用的图片`,
      message: `已移动到回收站，可释放 ${calculateTotalSize(unusedImages)} 空间`,
      actions: ['查看详情', '立即清理']
    })
  }
}
```

**触发时机**：
- 应用启动后 24 小时
- 每周固定时间（如周日凌晨）
- 磁盘空间低于阈值时

---

## 四、跨平台适配要点

### 移动端（iOS/Android）

**特殊考虑**：
- **存储空间有限**：图片占用大，清理策略更激进
- **后台任务限制**：使用 WorkManager（Android）/ Background Tasks（iOS）
- **权限敏感**：访问相册需要明确用户授权
- **性能优化**：
  - 扫描操作分批进行，避免 ANR/Watchdog
  - 使用 `requestIdleCallback` 执行非紧急任务
  - 索引数据库存储在 `Library/` 目录（iOS）

**UI 适配**：
- 回收站入口：设置 → 存储管理 → 图片回收站
- 清理通知：使用本地通知，避免频繁打扰
- 空间统计：显示「文档」和「图片」分别占用

---

### PC 端（Windows/macOS/Linux）

**特殊考虑**：
- **存储空间充足**：清理策略相对宽松
- **后台任务自由**：可使用定时任务或常驻进程
- **性能强**：支持全量扫描和实时索引
- **文件系统特性**：支持硬链接、符号链接（高级功能）

**UI 适配**：
- 回收站入口：设置页面独立卡片
- 右键菜单：图片文件增加「查找引用文档」
- 状态栏图标：同步/清理时显示进度
- 任务栏提醒：长时间操作显示进度条

---

## 五、用户交互设计

### 场景1：删除文档时的确认

**检测到孤立图片时显示**：

```
┌──────────────────────────────────┐
│  删除文档                        │
├──────────────────────────────────┤
│  该文档包含 3 张本地图片，       │
│  这些图片未被其他文档使用。      │
│                                  │
│  您希望如何处理这些图片？        │
│                                  │
│  ○ 移动到回收站（推荐）          │
│     30天后自动清理，可恢复       │
│                                  │
│  ○ 保留图片                      │
│     文档内链接将失效，图片保留   │
│                                  │
│  [查看图片详情]                  │
│                                  │
│                    [取消] [删除] │
└──────────────────────────────────┘
```

**默认选项**：移动到回收站（最安全）

---

### 场景2：定期清理通知

```
┌──────────────────────────────────┐
│  存储空间优化                    │
├──────────────────────────────────┤
│  发现 12 张未使用的图片          │
│                                  │
│  这些图片占用 23.5 MB 空间，     │
│  已被移动到回收站。              │
│                                  │
│  30 天后将自动彻底删除。         │
│                                  │
│  [查看详情]  [立即清理]  [忽略]  │
└──────────────────────────────────┘
```

**行为**：
- 点击「查看详情」→ 打开回收站页面
- 点击「立即清理」→ 永久删除所有回收站图片
- 点击「忽略」→ 关闭通知，7 天内不再提醒

---

### 场景3：图片回收站界面

**移动端**：
- 列表项显示：缩略图 + 原始路径 + 删除时间 + 文件大小
- 点击项：预览图片 + 显示删除时的引用文档列表
- 长按：多选模式（恢复/删除）
- 顶部：「清空回收站」按钮（仅保留 30 天内）

**PC 端**：
- 左侧：图片缩略图网格
- 右侧：选中图片的详细信息
  - 原始路径
  - 删除时间
  - 文件大小
  - 引用文档列表（删除时）
  - 恢复按钮
- 工具栏：批量恢复 / 永久删除 / 清空回收站
- 搜索框：按文件名/路径搜索

---

## 六、数据一致性保障

### 1. 远程同步时的处理

**本地删除文档**：
```typescript
// 1. 本地执行删除流程（图片移入回收站）
// 2. 同步时标记远程文档和图片为已删除
// 3. 远程同样移入回收站（如果远程支持）
```

**远程删除文档**：
```typescript
// 1. 同步拉取时检测到远程删除
// 2. 本地执行相同的图片扫描流程
// 3. 图片移入回收站
```

**关键点**：本地和远程采用相同的逻辑，保持一致性

---

### 2. 索引数据一致性

**异常处理**：
- 索引损坏时 → 触发全量重建
- 文档读取失败时 → 跳过该文档，记录日志
- 图片移动失败时 → 事务回滚，保持原子性

**重建策略**：
```typescript
async function rebuildImageIndex() {
  // 1. 清空现有索引
  await db.execute('DELETE FROM image_references')
  
  // 2. 扫描所有文档
  const allDocs = await scanAllDocuments()
  
  // 3. 并行处理（限制并发数）
  const batchSize = 10
  for (let i = 0; i < allDocs.length; i += batchSize) {
    const batch = allDocs.slice(i, i + batchSize)
    await Promise.all(batch.map(doc => updateImageReferenceIndex(doc)))
  }
}
```

---

## 七、性能优化策略

### 1. 索引查询优化

```sql
-- 创建索引
CREATE INDEX idx_image_path ON image_references(image_path);
CREATE INDEX idx_reference_count ON image_references(reference_count);

-- 查询优化：使用引用计数冗余字段
SELECT image_path FROM image_references 
WHERE reference_count = 1 
AND image_path IN (?, ?, ?);
```

### 2. 扫描性能优化

- **增量扫描**：只扫描修改时间 > 最后扫描时间的文档
- **缓存机制**：缓存文件内容 Hash，避免重复解析
- **后台任务**：
  - PC 端使用 Web Worker
  - 移动端使用后台任务 API
- **分批处理**：避免单次扫描过多文件导致卡顿

### 3. 存储空间优化

- **回收站配额**：可配置最大回收站空间（如 1GB）
- **自动清理**：空间不足时，优先删除最旧的图片
- **压缩选项**：回收站图片使用更低质量压缩（可选）

---

## 八、错误处理与边界情况

### 1. 特殊场景处理

**场景：图片被多个文档引用**
- 删除文档 A 时，图片引用计数从 2 → 1，**保留图片**
- 删除文档 B 时，引用计数从 1 → 0，**移入回收站**

**场景：文档恢复**
- 从回收站恢复文档时，检查其引用的图片
- 如果图片仍在回收站，**自动恢复图片**
- 如果图片已被永久删除，**提示用户图片丢失**

**场景：移动文档**
- 文档从 `/docs/a.md` 移动到 `/docs/sub/a.md`
- 图片保持相对路径不变（`images/xxx.png`）
- **无需移动图片**（因为相对路径仍然有效）

**场景：重命名文档**
- 仅文档文件名改变
- 图片不受影响

**场景：图片被手动删除**
- 扫描时发现图片文件不存在
- 从索引中移除该图片记录
- 文档中的链接成为死链（下次编辑时提示）

---

### 2. 并发冲突处理

**问题**：文档 A 和 B 同时引用一张图片，同时删除 A 和 B

**解决方案**：
```typescript
// 使用数据库事务
await db.transaction(async () => {
  const count = await getReferenceCountWithLock(imagePath)
  if (count === 0) {
    await moveImageToTrash(imagePath)
  }
})
```

---

## 九、配置选项

建议提供以下配置项：

```typescript
interface ImageLifecycleConfig {
  // 回收站设置
  enableTrash: boolean              // 默认：true
  trashRetentionDays: number        // 默认：30 天
  maxTrashSizeMB: number            // 默认：1024 MB
  
  // 自动清理
  enableAutoCleanup: boolean        // 默认：true
  autoCleanupIntervalDays: number   // 默认：7 天
  notifyBeforeCleanup: boolean      // 默认：true
  
  // 删除确认
  confirmBeforeDelete: boolean      // 默认：true
  showImageDetails: boolean         // 默认：true
}
```

---

## 十、推荐实现优先级

### 第一阶段（基础保障）
- [ ] 图片引用索引数据库设计
- [ ] 文档保存时更新索引
- [ ] 删除文档时的扫描和分类逻辑
- [ ] 回收站基础功能（移动文件、记录元数据）

### 第二阶段（用户界面）
- [ ] 删除确认对话框
- [ ] 回收站管理界面（移动端）
- [ ] 回收站管理界面（PC 端）
- [ ] 定期清理通知

### 第三阶段（优化完善）
- [ ] 后台定期清理任务
- [ ] 索引重建工具
- [ ] 性能优化（增量扫描、并发控制）
- [ ] 配置选项界面

---

## 十一、总结

**核心设计原则**：
1. **安全优先**：删除的图片必须可恢复
2. **智能处理**：用户无需手动管理图片依赖
3. **空间友好**：自动清理无用图片，释放存储
4. **跨平台一致**：移动端和 PC 端逻辑统一，UI 适配

**用户价值**：
- 删除文档无后顾之忧
- 存储空间自动优化
- 跨设备同步更完整
- 误删可恢复，数据更安全
