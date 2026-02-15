import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useToolCompressionMode, useSetToolCompressionMode } from '@/hooks/use-credentials'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/utils'
import type { ToolCompressionMode } from '@/types/api'

interface CompressionModeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MODES: { id: ToolCompressionMode; name: string; label: string; description: string }[] = [
  {
    id: 'schema',
    name: 'Schema 精简',
    label: 'Schema Compression',
    description: '当工具定义总大小超过 20KB 时，简化 JSON Schema 结构并按比例截断描述。压缩在工具定义层面完成，不影响 system prompt。',
  },
  {
    id: 'elevate',
    name: '描述提升',
    label: 'Description Elevation',
    description: '当单个工具描述超过 10000 字符时，将完整描述移到 system prompt 的 Tool Documentation 区域，工具本身保留引用链接。零信息丢失。',
  },
  {
    id: 'hybrid',
    name: '混合模式',
    label: 'Hybrid',
    description: '先执行描述提升（处理超长描述），再执行 Schema 精简（处理总大小超限）。两种策略叠加，覆盖最全面。',
  },
]

export function CompressionModeDialog({ open, onOpenChange }: CompressionModeDialogProps) {
  const { data, isLoading } = useToolCompressionMode()
  const { mutate: setMode, isPending } = useSetToolCompressionMode()

  const currentMode = data?.mode || 'schema'

  const handleSelectMode = (mode: ToolCompressionMode) => {
    if (mode === currentMode || isPending) return

    setMode(mode, {
      onSuccess: () => {
        const modeName = MODES.find(m => m.id === mode)?.name || mode
        toast.success(`已切换到${modeName}`)
      },
      onError: (error) => {
        toast.error(`切换失败: ${extractErrorMessage(error)}`)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            工具压缩模式
            {!isLoading && (
              <Badge variant="secondary">
                {MODES.find(m => m.id === currentMode)?.name || currentMode}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            选择工具定义的压缩策略。当客户端发送大量工具定义时，压缩可以防止请求超限。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          {MODES.map((mode) => {
            const isSelected = currentMode === mode.id
            return (
              <Card
                key={mode.id}
                className={`cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'hover:border-muted-foreground/50'
                } ${isPending ? 'opacity-50 pointer-events-none' : ''}`}
                onClick={() => handleSelectMode(mode.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{mode.name}</span>
                      <span className="text-xs text-muted-foreground">{mode.label}</span>
                    </div>
                    {isSelected && (
                      <Badge variant="default" className="text-xs">当前</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{mode.description}</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
