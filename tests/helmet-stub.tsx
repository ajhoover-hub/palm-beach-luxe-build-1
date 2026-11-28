import type { ReactNode } from "react"

export function HelmetProvider({ children }: { children?: ReactNode }) {
  return children
}

export function Helmet(_props: { children?: ReactNode }) {
  return null
}
