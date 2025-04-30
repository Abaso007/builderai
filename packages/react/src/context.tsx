"use client"

import { Unprice } from "@unprice/api"
import { createContext, useContext, useEffect, useState } from "react"
import type { UnpriceContextType, UnpriceProviderProps } from "./types"

const UnpriceContext = createContext<UnpriceContextType | undefined>(undefined)

export function UnpriceProvider({
  children,
  client: providedClient,
  options,
}: UnpriceProviderProps) {
  const [state, setState] = useState<UnpriceContextType>(() => {
    if (providedClient) {
      return {
        client: providedClient,
        isLoading: false,
      }
    }

    if (!options?.token) {
      throw new Error("Unprice token is required when not providing a client instance")
    }

    return {
      client: new Unprice(options),
      isLoading: false,
    }
  })

  useEffect(() => {
    if (providedClient) {
      setState((prev) => ({
        ...prev,
        client: providedClient,
      }))
    }
  }, [providedClient])

  return <UnpriceContext.Provider value={state}>{children}</UnpriceContext.Provider>
}

export function useUnpriceContext() {
  const context = useContext(UnpriceContext)

  if (!context) {
    throw new Error("useUnpriceContext must be used within a UnpriceProvider")
  }

  return context
}
