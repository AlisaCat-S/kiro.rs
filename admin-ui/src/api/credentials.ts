import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialsStatusResponse,
  BalanceResponse,
  SuccessResponse,
  SetDisabledRequest,
  SetPriorityRequest,
  AddCredentialRequest,
  AddCredentialResponse,
  ImportCredentialsRequest,
  ImportCredentialsResponse,
  TestCredentialResponse,
} from '@/types/api'

// 创建 axios 实例
const api = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器添加 API Key
api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

// 获取所有凭据状态
export async function getCredentials(): Promise<CredentialsStatusResponse> {
  const { data } = await api.get<CredentialsStatusResponse>('/credentials')
  return data
}

// 设置凭据禁用状态
export async function setCredentialDisabled(
  id: number,
  disabled: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/disabled`,
    { disabled } as SetDisabledRequest
  )
  return data
}

// 设置凭据优先级
export async function setCredentialPriority(
  id: number,
  priority: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/priority`,
    { priority } as SetPriorityRequest
  )
  return data
}

// 重置失败计数
export async function resetCredentialFailure(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}

// 强制刷新 Token
export async function forceRefreshToken(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/refresh`)
  return data
}

// 获取凭据余额
export async function getCredentialBalance(id: number): Promise<BalanceResponse> {
  const { data } = await api.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 添加新凭据
export async function addCredential(
  req: AddCredentialRequest
): Promise<AddCredentialResponse> {
  const { data } = await api.post<AddCredentialResponse>('/credentials', req)
  return data
}

// 删除凭据
export async function deleteCredential(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/credentials/${id}`)
  return data
}

// 重置单个凭据的成功次数
export async function resetSuccessCount(id: number): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset-stats`)
  return data
}

// 重置所有凭据的成功次数
export async function resetAllSuccessCount(): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>('/credentials/reset-stats')
  return data
}

// 获取负载均衡模式
export async function getLoadBalancingMode(): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.get<{ mode: 'priority' | 'balanced' }>('/config/load-balancing')
  return data
}

// 设置负载均衡模式
export async function setLoadBalancingMode(mode: 'priority' | 'balanced'): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.put<{ mode: 'priority' | 'balanced' }>('/config/load-balancing', { mode })
  return data
}

// 导出所有凭据
export async function exportCredentials(): Promise<unknown[]> {
  const { data } = await api.get<unknown[]>('/credentials/export')
  return data
}

// 批量导入凭据
export async function importCredentials(req: ImportCredentialsRequest): Promise<ImportCredentialsResponse> {
  const { data } = await api.post<ImportCredentialsResponse>('/credentials/import', req)
  return data
}

// 测试凭据
export async function testCredential(id: number): Promise<TestCredentialResponse> {
  const { data } = await api.post<TestCredentialResponse>(`/credentials/${id}/test`)
  return data
}

// ============ 远程节点 API ============

// 创建连接远程节点的 axios 实例
function createRemoteApi(baseUrl: string, adminKey: string) {
  const instance = axios.create({
    baseURL: `${baseUrl.replace(/\/$/, '')}/api/admin`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': adminKey,
    },
    timeout: 10000,
  })
  return instance
}

// 获取远程节点凭据
export async function getRemoteCredentials(baseUrl: string, adminKey: string): Promise<CredentialsStatusResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.get<CredentialsStatusResponse>('/credentials')
  return data
}

// 导出远程节点凭据
export async function exportRemoteCredentials(baseUrl: string, adminKey: string): Promise<unknown[]> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.get<unknown[]>('/credentials/export')
  return data
}

// 导入凭据到远程节点
export async function importRemoteCredentials(baseUrl: string, adminKey: string, req: ImportCredentialsRequest): Promise<ImportCredentialsResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.post<ImportCredentialsResponse>('/credentials/import', req)
  return data
}

// 测试远程节点凭据
export async function testRemoteCredential(baseUrl: string, adminKey: string, id: number): Promise<TestCredentialResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.post<TestCredentialResponse>(`/credentials/${id}/test`)
  return data
}

// 检查远程节点连通性
export async function checkRemoteNode(baseUrl: string, adminKey: string): Promise<boolean> {
  try {
    const remote = createRemoteApi(baseUrl, adminKey)
    await remote.get('/credentials')
    return true
  } catch {
    return false
  }
}

// 获取远程节点凭据余额
export async function getRemoteCredentialBalance(baseUrl: string, adminKey: string, id: number): Promise<BalanceResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 设置远程节点凭据禁用状态
export async function setRemoteCredentialDisabled(baseUrl: string, adminKey: string, id: number, disabled: boolean): Promise<SuccessResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.post<SuccessResponse>(`/credentials/${id}/disabled`, { disabled })
  return data
}

// 重置远程节点凭据失败计数
export async function resetRemoteCredentialFailure(baseUrl: string, adminKey: string, id: number): Promise<SuccessResponse> {
  const remote = createRemoteApi(baseUrl, adminKey)
  const { data } = await remote.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}
