import type { RemoteNode } from '@/types/api'

const API_KEY_STORAGE_KEY = 'adminApiKey'
const NODES_STORAGE_KEY = 'remoteNodes'

export const storage = {
  getApiKey: () => localStorage.getItem(API_KEY_STORAGE_KEY),
  setApiKey: (key: string) => localStorage.setItem(API_KEY_STORAGE_KEY, key),
  removeApiKey: () => localStorage.removeItem(API_KEY_STORAGE_KEY),

  getNodes: (): RemoteNode[] => {
    const raw = localStorage.getItem(NODES_STORAGE_KEY)
    if (!raw) return []
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  },
  setNodes: (nodes: RemoteNode[]) => localStorage.setItem(NODES_STORAGE_KEY, JSON.stringify(nodes)),
  addNode: (node: RemoteNode) => {
    const nodes = storage.getNodes()
    nodes.push(node)
    storage.setNodes(nodes)
  },
  removeNode: (id: string) => {
    const nodes = storage.getNodes().filter(n => n.id !== id)
    storage.setNodes(nodes)
  },
  updateNode: (id: string, updates: Partial<RemoteNode>) => {
    const nodes = storage.getNodes().map(n => n.id === id ? { ...n, ...updates } : n)
    storage.setNodes(nodes)
  },
}
