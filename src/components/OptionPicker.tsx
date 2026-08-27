import type { Option } from '@/lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** The server's default is an empty id, which Select cannot hold. */
export const DEFAULT = 'default'

export function OptionPicker({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: Option[]
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-40 shrink-0" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id || DEFAULT} value={o.id || DEFAULT}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
