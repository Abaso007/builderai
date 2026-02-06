"use client"

import { useEffect } from "react"
import { lakehouseRegisterSW } from "~/workers/service-worker-register"

export function LakehouseRegisterSw() {
  useEffect(() => {
    lakehouseRegisterSW()
  }, [])
  return null
}
