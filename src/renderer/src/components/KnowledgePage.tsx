import { BookOpen } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function KnowledgePage() {
  return (
    <PagePlaceholder
      icon={BookOpen}
      title="知识库"
      description="商品资料与直播知识，为主播提供素材"
      empty="知识库是空的，导入商品资料让主播有话可说"
    />
  )
}
