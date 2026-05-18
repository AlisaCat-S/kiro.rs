import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, RefreshCw, Download, Upload, FlaskConical, Globe, Server, ArrowUpDown, Wallet, Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
      toast.error(`测试请求失败: ${e instanceof Error ? e.message : '未知错误'}`)
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Globe className="h-6 w-6" />
          多节点管理
        </h2>
        <div className="flex gap-2">
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
}

function NodeCard({
  node, sortCredentials, SortHeader, testingId, loadingBalance, togglingId, balanceMap,
  onExport, onImport, onRemove, onTest, onGetBalance, onToggleDisabled, onResetFailure,
}: NodeCardProps) {
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
          <div className="border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
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
