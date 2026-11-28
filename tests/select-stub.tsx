import { Children, isValidElement, type ReactNode } from "react"

export function Select({
  value,
  onValueChange,
  children,
}: {
  value?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
}) {
  const options: Array<{ value: string; label: ReactNode }> = []
  const walk = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return
      const props = child.props as { value?: string; children?: ReactNode }
      if (typeof props.value === "string") options.push({ value: props.value, label: props.children })
      if (props.children) walk(props.children)
    })
  }
  walk(children)
  return (
    <select
      aria-label="style"
      value={value}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export function SelectTrigger({ children }: { children?: ReactNode; id?: string; className?: string }) {
  return children
}

export function SelectValue() {
  return null
}

export function SelectContent({ children }: { children?: ReactNode; className?: string }) {
  return children
}

export function SelectItem({ children }: { children?: ReactNode; value: string; className?: string }) {
  return children
}
