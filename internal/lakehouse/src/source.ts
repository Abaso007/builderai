export const LAKEHOUSE_SOURCES = ["events"] as const

export type LakehouseSource = (typeof LAKEHOUSE_SOURCES)[number]
