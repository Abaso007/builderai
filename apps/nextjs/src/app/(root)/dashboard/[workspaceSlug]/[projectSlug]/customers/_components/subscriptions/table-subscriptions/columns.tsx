"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { RouterOutputs } from "@unprice/api"
import { Badge } from "@unprice/ui/badge"
import { Checkbox } from "@unprice/ui/checkbox"
import { Separator } from "@unprice/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { AlertCircle } from "lucide-react"
import { useParams } from "next/navigation"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { SuperLink } from "~/components/super-link"
import { formatDate } from "~/lib/dates"
import { DataTableRowActions } from "./data-table-row-actions"

type Subscription =
  RouterOutputs["customers"]["getSubscriptions"]["customer"]["subscriptions"][number]

export const columns: ColumnDef<Subscription>[] = [
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
          table.getRowModel().rows.every((row) => row.original.status !== "active")
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
    accessorKey: "customer",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
    cell: ({ row }) => {
      const { workspaceSlug, projectSlug } = useParams()

      return (
        <SuperLink
          href={`/${workspaceSlug}/${projectSlug}/customers/subscriptions/${row.original.id}`}
          prefetch={false}
        >
          <div className="whitespace-nowrap text-sm">{row.original.customer.email}</div>
        </SuperLink>
      )
    },
    size: 40,
  },
  {
    accessorKey: "status",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge
        className={cn({
          success: row.original.status === "active",
          info: row.original.status === "trialing",
          danger: row.original.status === "past_due",
        })}
      >
        {row.original.status}
      </Badge>
    ),
    filterFn: (row, id, value) => {
      return Array.isArray(value) && value.includes(row.getValue(id))
    },
    size: 20,
  },
  {
    accessorKey: "planSlug",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Plan" />,
    cell: ({ row }) => <Badge className="text-xs">{row.original.planSlug}</Badge>,
    size: 20,
  },
  {
    accessorKey: "timezone",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Timezone" />,
    cell: ({ row }) => <Badge>{row.original.timezone}</Badge>,
    size: 20,
  },
  {
    accessorKey: "currentCycleStartAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Start current cycle" />,
    cell: ({ row }) => (
      <div className="flex items-center space-x-1">
        <div className="whitespace-nowrap text-sm">
          {formatDate(row.original.currentCycleStartAt, row.original.timezone)}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertCircle className="size-4 font-light" />
          </TooltipTrigger>
          <TooltipContent align="start" side="right" sideOffset={10} alignOffset={-5}>
            <div className="flex flex-col gap-1">
              <Typography variant="p" affects="removePaddingMargin" className="font-semibold">
                Timezone: {row.original.timezone}
              </Typography>
              <Separator className="my-1" />
              <Typography variant="p" affects="removePaddingMargin" className="text-xs">
                <span className="font-semibold">Local time: </span>
                {format(
                  toZonedTime(row.original.currentCycleStartAt, row.original.timezone),
                  "PPpp"
                )}
              </Typography>

              <Typography variant="p" affects="removePaddingMargin" className="text-xs">
                <span className="font-semibold">Customer time: </span>
                {format(new Date(row.original.currentCycleStartAt), "PPpp")}
              </Typography>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    accessorKey: "currentCycleEndAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="End current cycle" />,
    cell: ({ row }) => {
      const endDate = row.original.currentCycleEndAt

      if (endDate === null || endDate === undefined) {
        return <div className="whitespace-nowrap text-sm">Forever</div>
      }

      return (
        <div className="flex items-center space-x-1">
          <div className="whitespace-nowrap text-sm">
            {formatDate(endDate, row.original.timezone)}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertCircle className="size-4 font-light" />
            </TooltipTrigger>
            <TooltipContent align="start" side="right" sideOffset={10} alignOffset={-5}>
              <div className="flex flex-col gap-1">
                <Typography variant="p" affects="removePaddingMargin" className="font-semibold">
                  Timezone: {row.original.timezone}
                </Typography>
                <Separator className="my-1" />
                <Typography variant="p" affects="removePaddingMargin" className="text-xs">
                  <span className="font-semibold">Local time: </span>
                  {format(toZonedTime(endDate, row.original.timezone), "PPpp")}
                </Typography>

                <Typography variant="p" affects="removePaddingMargin" className="text-xs">
                  <span className="font-semibold">Customer time: </span>
                  {format(new Date(endDate), "PPpp")}
                </Typography>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      )
    },
    enableSorting: true,
    enableHiding: true,
    size: 40,
  },
  {
    id: "actions",
    cell: function Cell({ row }) {
      return <DataTableRowActions row={row} />
    },
    size: 30,
  },
]
