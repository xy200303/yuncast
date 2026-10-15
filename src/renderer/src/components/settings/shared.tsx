import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { type ProviderFieldSpec } from '../../stores/useAppStore'

/** 各家服务商的控制台与文档直达入口（凭据去哪儿拿）；本地服务没有控制台，故可以没有 */
export const LLM_LINKS: Record<string, { console: string; docs: string } | undefined> = {
  deepseek: {
    console: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com/zh-cn/'
  },
  qwen: {
    console: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    docs: 'https://help.aliyun.com/zh/model-studio/getting-started/what-is-model-studio'
  },
  doubao: {
    console: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    docs: 'https://www.volcengine.com/docs/82379/1298454'
  },
  kimi: {
    console: 'https://platform.moonshot.cn/console/api-keys',
    docs: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api'
  },
  zai: {
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction'
  },
  openai: {
    console: 'https://platform.openai.com/api-keys',
    docs: 'https://platform.openai.com/docs/api-reference/responses'
  }
}

/** 跳转外链（主进程 setWindowOpenHandler 会交给系统浏览器打开） */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 一键直达入口：控制台拿凭据 / 查文档 */
export function DocLinks({ items }: { items: { label: string; url: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => (
        <Button
          key={item.url}
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={() => openExternal(item.url)}
        >
          <ExternalLink className="size-3" />
          {item.label}
        </Button>
      ))}
    </div>
  )
}

/** manifest 驱动的单个配置字段：type 映射到现有控件，secret 用密码框 */
export function ProviderField({
  field,
  value,
  secretSaved,
  onChange
}: {
  field: ProviderFieldSpec
  value: string | number | boolean
  secretSaved: boolean
  onChange: (value: string | number | boolean) => void
}) {
  if (field.type === 'switch') {
    return (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={onChange}
        aria-label={field.label}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <Select value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={field.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (field.type === 'number') {
    return (
      <Input
        type="number"
        value={String(value ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }
  return (
    <Input
      type={field.type === 'password' ? 'password' : 'text'}
      value={String(value ?? '')}
      placeholder={secretSaved ? '已保存，留空表示不修改' : field.placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
