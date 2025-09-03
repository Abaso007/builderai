import type { Metric } from "@unprice/metrics"
import type { Metrics } from "./interface"

export class NoopMetrics implements Metrics {
  public emit(_metric: Metric): Promise<void> {
    return Promise.resolve()
  }

  public setColo(_colo: string): void {
    return
  }

  public async flush(): Promise<void> {}
}
