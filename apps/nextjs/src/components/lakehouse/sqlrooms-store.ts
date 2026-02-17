import { createWasmDuckDbConnector } from "@sqlrooms/duckdb"
import {
  type RoomShellSliceState,
  createRoomShellSlice,
  createRoomStore,
} from "@sqlrooms/room-shell"
import { type SqlEditorSliceState, createSqlEditorSlice } from "@sqlrooms/sql-editor"

const duckDbConnector = createWasmDuckDbConnector({
  allowUnsignedExtensions: true,
})

/**
 * Combined room state type for the Lakehouse dashboard.
 * Includes the base room shell state plus SQL editor capabilities.
 */
export type LakehouseRoomState = RoomShellSliceState & SqlEditorSliceState

/**
 * Create the room store for the Lakehouse dashboard.
 * This store manages:
 * - DuckDB connection and table state
 * - SQL editor state (queries, tabs, results)
 * - Data source loading
 */
export const { roomStore, useRoomStore } = createRoomStore<LakehouseRoomState>(
  (set, get, store) => ({
    // Base room shell slice - provides DuckDB integration, data sources, etc.
    ...createRoomShellSlice({
      connector: duckDbConnector,
      config: {
        title: "Lakehouse Analytics",
        // Data sources will be loaded dynamically from the tRPC endpoint
        dataSources: [],
      },
    })(set, get, store),

    // SQL editor slice - provides query tabs, execution, results
    ...createSqlEditorSlice()(set, get, store),
  })
)

export type LakehouseRoomStore = typeof roomStore
