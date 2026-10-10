import { Radio } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function LivePage() {
  return (
    <PagePlaceholder
      icon={Radio}
      title="直播台"
      description="开播控制台：互动感知、话术调度、推流状态"
      empty="尚未配置直播间，接入推流后从这里开播"
    />
  )
}
