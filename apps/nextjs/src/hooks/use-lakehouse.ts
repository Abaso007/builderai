import { useCallback, useEffect, useRef, useState } from "react"

export type WorkerStatus = "idle" | "initializing" | "ready" | "running" | "error"

export interface LakehouseUrls {
  usage: string[]
  verifications: string[]
  metadata: string[]
}

export function useLakehouse() {
  const workerRef = useRef<Worker | null>(null)
  const [status, setStatus] = useState<WorkerStatus>("idle")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workerRef.current) {
      setStatus("initializing")
      workerRef.current = new Worker(new URL("../workers/lakehouse.worker.ts", import.meta.url), {
        type: "module",
      })

      // Global listener for Init/Error
      workerRef.current.addEventListener("message", (e) => {
        const { type, payload } = e.data
        if (type === "READY") {
          setStatus("ready")
        } else if (type === "ERROR") {
          setStatus("error")
          setError(payload)
        }
      })

      workerRef.current.postMessage({ type: "INIT" })
    }

    return () => {
      // workerRef.current?.terminate()
    }
  }, [])

  const runQuery = useCallback(async (urls: LakehouseUrls) => {
    return new Promise<any[]>((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) return reject("Worker not initialized")

      setStatus("running")

      const handler = (e: MessageEvent) => {
        const { type, payload } = e.data
        if (type === "RESULT") {
          setStatus("ready")
          worker.removeEventListener("message", handler)
          resolve(payload)
        } else if (type === "ERROR") {
          setStatus("error")
          setError(payload)
          worker.removeEventListener("message", handler)
          reject(payload)
        }
      }

      worker.addEventListener("message", handler)

      worker.postMessage({
        type: "QUERY",
        payload: {
          usageUrls: urls.usage,
          verificationUrls: urls.verifications,
          metadataUrls: urls.metadata,
        },
      })
    })
  }, [])

  return { status, error, runQuery }
}
