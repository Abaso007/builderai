"use client"

import type {
  ColumnDef,
  ColumnFiltersState,
  PaginationState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import * as React from "react"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"

import { AlertTriangle } from "lucide-react"
import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import { EmptyPlaceholder } from "../empty-placeholder"
import { DataTablePagination } from "./data-table-pagination"
import { DataTableToolbar } from "./data-table-toolbar"

export interface FilterOptionDataTable {
  filterBy?: string
  filterDateRange?: boolean
  filterColumns?: boolean
  filterServerSide?: boolean
  // when you define filterSelectors, you need filterfn in the column definition
  filterSelectors?: Record<
    string,
    {
      label: string
      value: string | number
      icon?: React.ComponentType<{ className?: string }>
    }[]
  >
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  filterOptions?: FilterOptionDataTable
  className?: string
  pageCount?: number
  error?: string
}

export function DataTable<TData, TValue>({
  columns,
  data,
  filterOptions,
  className,
  pageCount,
  error,
}: DataTableProps<TData, TValue>) {
  const [filters] = useFilterDataTable()
  const [rowSelection, setRowSelection] = React.useState({})
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [sorting, setSorting] = React.useState<SortingState>([])

  // if pageCount is provided, we assume server-side pagination
  // otherwise, we assume client-side pagination done by the library
  const isServerSidePagination = !!pageCount

  // Handle server-side pagination
  const [page, setPagination] = React.useState<PaginationState>({
    pageIndex: filters.page - 1,
    pageSize: filters.page_size ?? 10,
  })

  const pagination = React.useMemo(
    () => ({
      pageIndex: page.pageIndex,
      pageSize: page.pageSize,
    }),
    [page.pageIndex, page.pageSize]
  )

  const table = useReactTable({
    data,
    columns,
    ...(isServerSidePagination && { pageCount }),
    state: {
      sorting,
      ...(isServerSidePagination && { pagination }),
      columnVisibility,
      rowSelection,
      columnFilters,
      columnPinning: { right: ["actions"] },
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    ...(isServerSidePagination && {
      manualPagination: true,
      onPaginationChange: setPagination,
    }),
  })

  return (
    <div className={cn("w-full space-y-4 overflow-auto", className)}>
      <DataTableToolbar table={table} filterOptions={filterOptions} />
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isPinned = header.column.getIsPinned()

                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      style={{
                        minWidth: header.getSize() ? header.getSize() : 0,
                      }}
                      className={cn("relative", {
                        "sticky z-10 bg-background-bgSubtle": isPinned,
                        "-left-1 border-r": isPinned === "left",
                        "-right-1 border-l": isPinned === "right",
                      })}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => {
                    const isPinned = cell.column.getIsPinned()

                    return (
                      <TableCell
                        key={cell.id}
                        className={cn("relative", {
                          "sticky z-10 bg-background-bgSubtle": isPinned,
                          "-left-1 border-r": isPinned === "left",
                          "-right-1 border-l": isPinned === "right",
                        })}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center">
                  <EmptyPlaceholder className="min-h-[300px]">
                    <EmptyPlaceholder.Icon>
                      <AlertTriangle className="h-8 w-8" />
                    </EmptyPlaceholder.Icon>
                    <EmptyPlaceholder.Title>
                      {error ? "Ups, something went wrong" : "No Results"}
                    </EmptyPlaceholder.Title>
                    <EmptyPlaceholder.Description>
                      {error ? error : "There are no results for the selected filters."}
                    </EmptyPlaceholder.Description>
                  </EmptyPlaceholder>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} serverSidePagination={isServerSidePagination} />
    </div>
  )
}
