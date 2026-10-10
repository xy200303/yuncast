import { BarChart3 } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function StatsPage() {
  return (
    <PagePlaceholder
      icon={BarChart3}
      title="数据"
      description="互动、转化与主播表现的数据看板"
      empty="暂无数据，开播后这里会有看板"
    />
  )
}
