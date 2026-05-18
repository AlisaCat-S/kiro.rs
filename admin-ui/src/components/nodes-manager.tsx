import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, RefreshCw, Download, Upload, FlaskConical, Globe, Server, ArrowUpDown, Wallet, Power, Send, Activity, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { storage } from '@/lib/storage'
import {
  exportCredentials,
  exportRemoteCredentials,
  importCredentials,
  importRemoteCredentials,
  testCredential,
  testRemoteCredential,
  checkRemoteNode,
  getCredentials,
  getRemoteCredentials,
  getCredentialBalance,
  setCredentialDisabled,
  resetCredentialFailure,
  getRemoteCredentialBalance,
  setRemoteCredentialDisabled,
  resetRemoteCredentialFailure,
  forceRefreshToken,
  forceRefreshRemoteToken,
} from '@/api/credentials'
import type { RemoteNode, CredentialsStatusResponse, CredentialStatusItem, BalanceResponse, TestCredentialResponse } from '@/types/api'

type SortField = 'id' | 'successCount' | 'status' | 'priority' | 'email'
type SortDir = 'asc' | 'desc'

// PLACEHOLDER_NODES_MANAGER_BODY

interface NodeWithStatus extends RemoteNode {
  credentials?: CredentialsStatusResponse
}

export function NodesManager() {
  const [nodes, setNodes] = useState<NodeWithStatus[]>([])
  const [localNode, setLocalNode] = useState<NodeWithStatus | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newNodeName, setNewNodeName] = useState('')
  const [newNodeUrl, setNewNodeUrl] = useState('')
  const [newNodeKey, setNewNodeKey] = useState('')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [balanceMap, setBalanceMap] = useState<Map<string, BalanceResponse>>(new Map())
  const [loadingBalance, setLoadingBalance] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('id')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [batchTesting, setBatchTesting] = useState<string | null>(null)
  const [batchTestProgress, setBatchTestProgress] = useState({ current: 0, total: 0, passed: 0, failed: 0 })
  const [migrateDialog, setMigrateDialog] = useState<{ from: NodeWithStatus; credIds: number[] } | null>(null)
  const [migrateTarget, setMigrateTarget] = useState('')
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadLocalNode = useCallback(async () => {
    try {
      const creds = await getCredentials()
      setLocalNode({
        id: 'local',
        name: '本地节点',
        baseUrl: window.location.origin,
        adminKey: storage.getApiKey() || '',
        status: 'online',
        credentials: creds,
      })
    } catch {
      setLocalNode({
        id: 'local',
        name: '本地节点',
        baseUrl: window.location.origin,
        adminKey: storage.getApiKey() || '',
        status: 'offline',
      })
    }
  }, [])

  const loadRemoteNodes = useCallback(async () => {
    const savedNodes = storage.getNodes()
    const updated = await Promise.all(
      savedNodes.map(async (node) => {
        try {
          const creds = await getRemoteCredentials(node.baseUrl, node.adminKey)
          return { ...node, status: 'online' as const, credentials: creds }
        } catch {
          return { ...node, status: 'offline' as const }
        }
      })
    )
    setNodes(updated)
  }, [])

  useEffect(() => {
    loadLocalNode()
    loadRemoteNodes()
  }, [loadLocalNode, loadRemoteNodes])

  // 自动刷新（30 秒）
  useEffect(() => {
    if (autoRefresh) {
      refreshTimer.current = setInterval(() => {
        loadLocalNode()
        loadRemoteNodes()
      }, 30000)
    }
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current)
    }
  }, [autoRefresh, loadLocalNode, loadRemoteNodes])

  const handleAddNode = async () => {
    if (!newNodeName || !newNodeUrl || !newNodeKey) {
      toast.error('请填写所有字段')
      return
    }
    const online = await checkRemoteNode(newNodeUrl, newNodeKey)
    const node: RemoteNode = {
      id: crypto.randomUUID(),
      name: newNodeName,
      baseUrl: newNodeUrl,
      adminKey: newNodeKey,
      status: online ? 'online' : 'offline',
    }
    storage.addNode(node)
    setShowAddDialog(false)
    setNewNodeName('')
    setNewNodeUrl('')
    setNewNodeKey('')
    toast.success(online ? `节点 "${node.name}" 已添加并连接成功` : `节点 "${node.name}" 已添加但无法连接`)
    loadRemoteNodes()
  }

  const handleRemoveNode = (id: string) => {
    storage.removeNode(id)
    setNodes(prev => prev.filter(n => n.id !== id))
    toast.success('节点已移除')
  }

  const handleExport = async (node: NodeWithStatus) => {
    try {
      const data = node.id === 'local'
        ? await exportCredentials()
        : await exportRemoteCredentials(node.baseUrl, node.adminKey)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `credentials-${node.name}-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${node.name} 的 ${Array.isArray(data) ? data.length : 0} 个凭证`)
    } catch (e: unknown) {
      toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  const handleImport = async (node: NodeWithStatus) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        const credentials = Array.isArray(parsed) ? parsed : parsed.credentials || []
        const result = node.id === 'local'
          ? await importCredentials({ credentials })
          : await importRemoteCredentials(node.baseUrl, node.adminKey, { credentials })
        toast.success(`导入完成: ${result.imported} 成功, ${result.skipped} 跳过, ${result.failed} 失败`)
        if (node.id === 'local') loadLocalNode()
        else loadRemoteNodes()
      } catch (e: unknown) {
        toast.error(`导入失败: ${e instanceof Error ? e.message : '文件格式错误'}`)
      }
    }
    input.click()
  }

  const handleTestCredential = async (node: NodeWithStatus, credId: number) => {
    const key = `${node.id}-${credId}`
    setTestingId(key)
    try {
      let result: TestCredentialResponse
      if (node.id === 'local') {
        result = await testCredential(credId)
      } else {
        result = await testRemoteCredential(node.baseUrl, node.adminKey, credId)
      }
      if (result.success) {
        toast.success(`凭证 #${credId} 测试通过 (${result.latencyMs}ms)`)
      } else {
        toast.error(`凭证 #${credId} 测试失败: ${result.error}`)
      }
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'response' in e) {
        const resp = (e as { response?: { status?: number } }).response
        if (resp?.status === 404) {
          toast.error(`远程节点不支持测试功能，请升级到最新版本`)
        } else {
          toast.error(`测试请求失败: ${e instanceof Error ? e.message : '未知错误'}`)
        }
      } else {
        toast.error(`测试请求失败: ${e instanceof Error ? e.message : '未知错误'}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  const handleGetBalance = async (node: NodeWithStatus, credId: number) => {
    const key = `${node.id}-${credId}`
    setLoadingBalance(key)
    try {
      let balance: BalanceResponse
      if (node.id === 'local') {
        balance = await getCredentialBalance(credId)
      } else {
        balance = await getRemoteCredentialBalance(node.baseUrl, node.adminKey, credId)
      }
      setBalanceMap(prev => new Map(prev).set(key, balance))
      const pct = balance.usagePercentage.toFixed(1)
      toast.success(`#${credId} 余额: ${balance.remaining.toFixed(0)} 剩余 (${pct}% 已用)`)
    } catch (e: unknown) {
      toast.error(`查询余额失败: ${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setLoadingBalance(null)
    }
  }

  const handleToggleDisabled = async (node: NodeWithStatus, credId: number, currentDisabled: boolean) => {
    const key = `${node.id}-${credId}`
    setTogglingId(key)
    try {
      if (node.id === 'local') {
        await setCredentialDisabled(credId, !currentDisabled)
      } else {
        await setRemoteCredentialDisabled(node.baseUrl, node.adminKey, credId, !currentDisabled)
      }
      toast.success(`凭证 #${credId} 已${currentDisabled ? '启用' : '禁用'}`)
      if (node.id === 'local') loadLocalNode()
      else loadRemoteNodes()
    } catch (e: unknown) {
      toast.error(`操作失败: ${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setTogglingId(null)
    }
  }

  const handleResetFailure = async (node: NodeWithStatus, credId: number) => {
    try {
      if (node.id === 'local') {
        await resetCredentialFailure(credId)
      } else {
        await resetRemoteCredentialFailure(node.baseUrl, node.adminKey, credId)
      }
      toast.success(`凭证 #${credId} 失败计数已重置`)
      if (node.id === 'local') loadLocalNode()
      else loadRemoteNodes()
    } catch (e: unknown) {
      toast.error(`重置失败: ${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  const handleRefreshToken = async (node: NodeWithStatus, credId: number) => {
    const key = `${node.id}-${credId}`
    setTestingId(key)
    try {
      if (node.id === 'local') {
        await forceRefreshToken(credId)
      } else {
        await forceRefreshRemoteToken(node.baseUrl, node.adminKey, credId)
      }
      toast.success(`凭证 #${credId} Token 已刷新`)
      if (node.id === 'local') loadLocalNode()
      else loadRemoteNodes()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '未知错误'
      if (msg.includes('400') || msg.includes('API Key')) {
        toast.error(`凭证 #${credId} 不支持刷新 (API Key 类型)`)
      } else {
        toast.error(`刷新失败: ${msg}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  const handleBatchBalance = async (node: NodeWithStatus) => {
    if (!node.credentials) return
    const creds = node.credentials.credentials
    if (creds.length === 0) return
    let loaded = 0
    for (const cred of creds) {
      const key = `${node.id}-${cred.id}`
      try {
        let balance: BalanceResponse
        if (node.id === 'local') {
          balance = await getCredentialBalance(cred.id)
        } else {
          balance = await getRemoteCredentialBalance(node.baseUrl, node.adminKey, cred.id)
        }
        setBalanceMap(prev => new Map(prev).set(key, balance))
        loaded++
      } catch {
        // skip failed ones
      }
    }
    toast.success(`已查询 ${loaded}/${creds.length} 个凭证余额`)
  }

  const handleRefreshNode = async (node: NodeWithStatus) => {
    if (node.id === 'local') {
      await loadLocalNode()
    } else {
      try {
        const creds = await getRemoteCredentials(node.baseUrl, node.adminKey)
        setNodes(prev => prev.map(n => n.id === node.id ? { ...n, status: 'online' as const, credentials: creds } : n))
        toast.success(`${node.name} 状态已刷新`)
      } catch {
        setNodes(prev => prev.map(n => n.id === node.id ? { ...n, status: 'offline' as const } : n))
        toast.error(`${node.name} 连接失败`)
      }
    }
  }

  // 批量测试某节点所有凭证
  const handleBatchTest = async (node: NodeWithStatus) => {
    if (!node.credentials) return
    const creds = node.credentials.credentials.filter(c => !c.disabled)
    if (creds.length === 0) {
      toast.error('没有可用凭证')
      return
    }
    setBatchTesting(node.id)
    setBatchTestProgress({ current: 0, total: creds.length, passed: 0, failed: 0 })
    let passed = 0
    let failed = 0
    for (let i = 0; i < creds.length; i++) {
      try {
        let result: TestCredentialResponse
        if (node.id === 'local') {
          result = await testCredential(creds[i].id)
        } else {
          result = await testRemoteCredential(node.baseUrl, node.adminKey, creds[i].id)
        }
        if (result.success) passed++
        else failed++
      } catch {
        failed++
      }
      setBatchTestProgress({ current: i + 1, total: creds.length, passed, failed })
    }
    setBatchTesting(null)
    toast.success(`批量测试完成: ${passed} 通过, ${failed} 失败 (共 ${creds.length})`)
  }

  // 跨节点迁移
  const handleMigrate = async () => {
    if (!migrateDialog || !migrateTarget) return
    const targetNode = allNodes.find(n => n.id === migrateTarget)
    if (!targetNode) {
      toast.error('目标节点不存在')
      return
    }
    try {
      // 从源节点导出选中的凭证
      let allCreds: unknown[]
      if (migrateDialog.from.id === 'local') {
        allCreds = await exportCredentials()
      } else {
        allCreds = await exportRemoteCredentials(migrateDialog.from.baseUrl, migrateDialog.from.adminKey)
      }
      const selected = (allCreds as Array<{ id?: number }>).filter(
        c => c.id !== undefined && migrateDialog.credIds.includes(c.id)
      )
      if (selected.length === 0) {
        toast.error('未找到选中的凭证')
        return
      }
      // 导入到目标节点
      let result
      if (targetNode.id === 'local') {
        result = await importCredentials({ credentials: selected as never[] })
      } else {
        result = await importRemoteCredentials(targetNode.baseUrl, targetNode.adminKey, { credentials: selected as never[] })
      }
      toast.success(`迁移完成: ${result.imported} 成功, ${result.skipped} 跳过, ${result.failed} 失败`)
      setMigrateDialog(null)
      setMigrateTarget('')
      loadLocalNode()
      loadRemoteNodes()
    } catch (e: unknown) {
      toast.error(`迁移失败: ${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sortCredentials = (creds: CredentialStatusItem[]): CredentialStatusItem[] => {
    return [...creds].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'id': cmp = a.id - b.id; break
        case 'successCount': cmp = a.successCount - b.successCount; break
        case 'status': cmp = (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0); break
        case 'priority': cmp = a.priority - b.priority; break
        case 'email': cmp = (a.email || '').localeCompare(b.email || ''); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const allNodes = [localNode, ...nodes].filter(Boolean) as NodeWithStatus[]

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <th
      className="px-3 py-2 text-left font-medium cursor-pointer hover:bg-muted/80 select-none"
      onClick={() => toggleSort(field)}
    >
      <span className="flex items-center gap-1">
        {label}
        {sortField === field && (
          <ArrowUpDown className="h-3 w-3" />
        )}
      </span>
    </th>
  )

  // 健康看板数据
  const healthStats = useMemo(() => {
    let totalCreds = 0
    let availableCreds = 0
    let onlineNodes = 0
    let offlineNodes = 0
    for (const node of allNodes) {
      if (node.status === 'online') onlineNodes++
      else offlineNodes++
      if (node.credentials) {
        totalCreds += node.credentials.total
        availableCreds += node.credentials.available
      }
    }
    return { totalCreds, availableCreds, onlineNodes, offlineNodes, totalNodes: allNodes.length }
  }, [allNodes])

  return (
    <div className="space-y-6">
      {/* 健康看板 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{healthStats.totalNodes}</div>
            <p className="text-xs text-muted-foreground">节点总数 ({healthStats.onlineNodes} 在线)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{healthStats.totalCreds}</div>
            <p className="text-xs text-muted-foreground">凭证总数</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold text-green-600">{healthStats.availableCreds}</div>
            <p className="text-xs text-muted-foreground">可用凭证</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className={`text-2xl font-bold ${healthStats.totalCreds - healthStats.availableCreds > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
              {healthStats.totalCreds - healthStats.availableCreds}
            </div>
            <p className="text-xs text-muted-foreground">不可用凭证</p>
          </CardContent>
        </Card>
      </div>

      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="h-6 w-6" />
          多节点管理
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? '关闭自动刷新' : '开启自动刷新 (30s)'}
          >
            <Activity className="h-4 w-4 mr-1" />
            {autoRefresh ? '自动' : '手动'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { loadLocalNode(); loadRemoteNodes() }}>
            <RefreshCw className="h-4 w-4 mr-1" /> 刷新
          </Button>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4 mr-1" /> 添加节点</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>添加远程节点</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <Input placeholder="节点名称" value={newNodeName} onChange={e => setNewNodeName(e.target.value)} />
                <Input placeholder="Base URL (如 https://kiro.example.com)" value={newNodeUrl} onChange={e => setNewNodeUrl(e.target.value)} />
                <Input placeholder="Admin API Key" type="password" value={newNodeKey} onChange={e => setNewNodeKey(e.target.value)} />
                <Button className="w-full" onClick={handleAddNode}>添加</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* 跨节点迁移对话框 */}
      {migrateDialog && (
        <Dialog open={!!migrateDialog} onOpenChange={() => setMigrateDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>迁移凭证到其他节点</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <p className="text-sm text-muted-foreground">
                从 <strong>{migrateDialog.from.name}</strong> 迁移 {migrateDialog.credIds.length} 个凭证
              </p>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                value={migrateTarget}
                onChange={e => setMigrateTarget(e.target.value)}
              >
                <option value="">选择目标节点...</option>
                {allNodes.filter(n => n.id !== migrateDialog.from.id && n.status === 'online').map(n => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <Button className="w-full" onClick={handleMigrate} disabled={!migrateTarget}>
                <Send className="h-4 w-4 mr-1" /> 开始迁移
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {allNodes.map(node => (
        <NodeCard
          key={node.id}
          node={node}
          sortCredentials={sortCredentials}
          SortHeader={SortHeader}
          testingId={testingId}
          loadingBalance={loadingBalance}
          togglingId={togglingId}
          balanceMap={balanceMap}
          onExport={handleExport}
          onImport={handleImport}
          onRemove={handleRemoveNode}
          onTest={handleTestCredential}
          onGetBalance={handleGetBalance}
          onToggleDisabled={handleToggleDisabled}
          onResetFailure={handleResetFailure}
          onRefreshToken={handleRefreshToken}
          onRefreshNode={handleRefreshNode}
          onBatchTest={handleBatchTest}
          onBatchBalance={handleBatchBalance}
          onMigrate={(node, credIds) => setMigrateDialog({ from: node, credIds })}
          batchTesting={batchTesting}
          batchTestProgress={batchTestProgress}
        />
      ))}
    </div>
  )
}

// PLACEHOLDER_NODE_CARD

interface NodeCardProps {
  node: NodeWithStatus
  sortCredentials: (creds: CredentialStatusItem[]) => CredentialStatusItem[]
  SortHeader: React.FC<{ field: SortField; label: string }>
  testingId: string | null
  loadingBalance: string | null
  togglingId: string | null
  balanceMap: Map<string, BalanceResponse>
  onExport: (node: NodeWithStatus) => void
  onImport: (node: NodeWithStatus) => void
  onRemove: (id: string) => void
  onTest: (node: NodeWithStatus, credId: number) => void
  onGetBalance: (node: NodeWithStatus, credId: number) => void
  onToggleDisabled: (node: NodeWithStatus, credId: number, currentDisabled: boolean) => void
  onResetFailure: (node: NodeWithStatus, credId: number) => void
  onRefreshToken: (node: NodeWithStatus, credId: number) => void
  onRefreshNode: (node: NodeWithStatus) => void
  onBatchTest: (node: NodeWithStatus) => void
  onBatchBalance: (node: NodeWithStatus) => void
  onMigrate: (node: NodeWithStatus, credIds: number[]) => void
  batchTesting: string | null
  batchTestProgress: { current: number; total: number; passed: number; failed: number }
}

function NodeCard({
  node, sortCredentials, SortHeader, testingId, loadingBalance, togglingId, balanceMap,
  onExport, onImport, onRemove, onTest, onGetBalance, onToggleDisabled, onResetFailure,
  onRefreshToken, onRefreshNode, onBatchTest, onBatchBalance, onMigrate, batchTesting, batchTestProgress,
}: NodeCardProps) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const sorted = useMemo(
    () => node.credentials ? sortCredentials(node.credentials.credentials) : [],
    [node.credentials, sortCredentials]
  )

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Server className="h-5 w-5" />
            {node.name}
            <Badge variant={node.status === 'online' ? 'default' : 'destructive'}>
              {node.status === 'online' ? '在线' : '离线'}
            </Badge>
            {node.credentials && (
              <span className="text-sm font-normal text-muted-foreground">
                {node.credentials.available}/{node.credentials.total} 可用
              </span>
            )}
          </CardTitle>
          <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRefreshNode(node)}
                  title="刷新节点状态"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onBatchTest(node)}
                  disabled={batchTesting === node.id}
                  title="批量测试所有凭证"
                >
                  <FlaskConical className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onBatchBalance(node)}
                  title="批量查询所有余额"
                >
                  <Wallet className="h-4 w-4" />
                </Button>
                {selectedIds.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onMigrate(node, Array.from(selectedIds))}
                    title={`迁移 ${selectedIds.size} 个凭证到其他节点`}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => onExport(node)} title="导出凭证">
                  <Download className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onImport(node)} title="导入凭证">
                  <Upload className="h-4 w-4" />
                </Button>
                {node.id !== 'local' && (
                  <Button variant="ghost" size="sm" onClick={() => onRemove(node.id)} title="移除节点">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
        </div>
        <p className="text-xs text-muted-foreground">{node.baseUrl}</p>
      </CardHeader>
      {sorted.length > 0 && (
        <CardContent className="pt-0">
          {batchTesting === node.id && (
            <div className="mb-3 space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>批量测试中... {batchTestProgress.current}/{batchTestProgress.total}</span>
                <span className="text-green-600">{batchTestProgress.passed} 通过</span>
              </div>
              <Progress value={(batchTestProgress.current / batchTestProgress.total) * 100} />
            </div>
          )}
          <div className="border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-2 py-2 w-8">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={selectedIds.size === sorted.length && sorted.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedIds(new Set(sorted.map(c => c.id)))
                        else setSelectedIds(new Set())
                      }}
                    />
                  </th>
                  <SortHeader field="id" label="ID" />
                  <th className="px-3 py-2 text-left font-medium">类型</th>
                  <SortHeader field="email" label="邮箱" />
                  <SortHeader field="status" label="状态" />
                  <SortHeader field="priority" label="优先级" />
                  <SortHeader field="successCount" label="成功次数" />
                  <th className="px-3 py-2 text-left font-medium">余额</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(cred => {
                  const key = `${node.id}-${cred.id}`
                  const balance = balanceMap.get(key)
                  return (
                    <tr key={cred.id} className="border-t hover:bg-muted/30">
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={selectedIds.has(cred.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds)
                            if (e.target.checked) next.add(cred.id)
                            else next.delete(cred.id)
                            setSelectedIds(next)
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">#{cred.id}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{cred.authMethod || '?'}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground max-w-[150px] truncate">{cred.email || '-'}</td>
                      <td className="px-3 py-2">
                        {cred.disabled ? (
                          <Badge variant="destructive">禁用</Badge>
                        ) : cred.failureCount > 0 ? (
                          <Badge variant="secondary">失败×{cred.failureCount}</Badge>
                        ) : (
                          <Badge variant="default">正常</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2">{cred.priority}</td>
                      <td className="px-3 py-2">{cred.successCount}</td>
                      <td className="px-3 py-2 text-xs">
                        {balance ? (
                          <span className={balance.usagePercentage > 80 ? 'text-destructive' : 'text-muted-foreground'}>
                            {balance.remaining.toFixed(0)} 剩余 ({balance.usagePercentage.toFixed(0)}%)
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={loadingBalance === key}
                            onClick={() => onGetBalance(node, cred.id)}
                          >
                            <Wallet className="h-3 w-3 mr-1" />
                            {loadingBalance === key ? '...' : '查询'}
                          </Button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            disabled={testingId === key}
                            onClick={() => onTest(node, cred.id)}
                            title="测试凭证"
                          >
                            <FlaskConical className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            disabled={togglingId === key}
                            onClick={() => onToggleDisabled(node, cred.id, cred.disabled)}
                            title={cred.disabled ? '启用' : '禁用'}
                          >
                            <Power className={`h-3.5 w-3.5 ${cred.disabled ? 'text-green-500' : 'text-destructive'}`} />
                          </Button>
                          {cred.authMethod === 'social' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              disabled={testingId === key}
                              onClick={() => onRefreshToken(node, cred.id)}
                              title="刷新 Token"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {cred.failureCount > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => onResetFailure(node, cred.id)}
                              title="重置失败计数"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
