import { Bot } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function AnchorsPage() {
  return (
    <PagePlaceholder
      icon={Bot}
      title="主播团"
      description="管理 AI 主播的人设、声音与记忆"
      empty="还没有主播，创建一个有人设的 AI 主播"
    />
  )
}
