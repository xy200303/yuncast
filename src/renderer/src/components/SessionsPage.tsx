import { CalendarDays } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function SessionsPage() {
  return (
    <PagePlaceholder
      icon={CalendarDays}
      title="场次"
      description="规划与回顾每一场直播"
      empty="还没有场次，排一场直播试试"
    />
  )
}
