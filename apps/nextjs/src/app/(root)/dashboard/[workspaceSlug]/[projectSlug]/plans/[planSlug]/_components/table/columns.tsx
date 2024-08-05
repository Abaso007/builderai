"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/api"
import { Checkbox } from "@unprice/ui/checkbox"
import { cn } from "@unprice/ui/utils"

import { Badge } from "@unprice/ui/badge"
import { usePathname } from "next/navigation"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

export type PlanVersion = RouterOutputs["plans"]["getBySlug"]["plan"]["versions"][number]

export const columns: ColumnDef<PlanVersion>[] = [
  {
    id: "select",
    size: 50,
    accessorKey: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        disabled={
          table.getRowModel().rows.length === 0 ||
          table.getRowModel().rows.every((row) => !row.original.active)
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
        className="translate-y-0.5"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
        className="translate-y-0.5"
      />
    ),
    enableSorting: false,
    enableHiding: false,
    enableResizing: false,
  },
  {
    accessorKey: "title",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Title" />,
    cell: ({ row }) => {
      const pathname = usePathname()

      return (
        <SuperLink href={`${pathname}/${row.original.id}`} prefetch={false}>
          <div className="font-bold">
            {row.original.title} - v{row.original.version}
          </div>
          {row.original.description && (
            <div className="line-clamp-1 hidden text-muted-foreground text-xs md:inline">
              {`${row.original.description.slice(0, 40)}...`}
            </div>
          )}
        </SuperLink>
      )
    },
    enableSorting: true,
    enableHiding: false,
    enableResizing: true,
    filterFn: (row, _, filterValue) => {
      // search by title and description
      const searchValue = filterValue.toLowerCase()
      const title = row.original.title.toLowerCase()
      const version = row.original.version.toString().toLowerCase()
      const description = row.original.description?.toLowerCase() ?? ""

      if (
        title.includes(searchValue) ||
        version.includes(searchValue) ||
        description.includes(searchValue)
      ) {
        return true
      }

      return false
    },
  },
  {
    accessorKey: "currency",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Currency" />,
    cell: ({ row }) => (
      <Badge className="text-xs" variant="secondary">
        {row.original.currency}
      </Badge>
    ),
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
  },
  {
    accessorKey: "planType",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
    cell: ({ row }) => <Badge className="text-xs">{row.original.planType}</Badge>,
  },
  {
    accessorKey: "status",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge
        className={cn({
          success: row.original.status === "published",
        })}
      >
        {row.original.status}
      </Badge>
    ),
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created At" />,
    cell: ({ row }) => <div>{formatDate(row.getValue("createdAt"))}</div>,
    enableSorting: true,
    enableHiding: true,
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Updated At" />,
    cell: ({ row }) => <div>{formatDate(row.getValue("updatedAt"))}</div>,
    enableSorting: true,
    enableHiding: true,
  },
  {
    id: "actions",
    cell: function Cell({ row }) {
      return <DataTableRowActions row={row} />
    },
    size: 30,
  },
]
