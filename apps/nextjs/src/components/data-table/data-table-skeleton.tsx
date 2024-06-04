import { Skeleton } from "@builderai/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@builderai/ui/table"

interface DataTableSkeletonProps {
  /**
   * Number of rows to render
   * @default 3
   */
  rows?: number
}

export function DataTableSkeleton({ rows = 3 }: DataTableSkeletonProps) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-transparent">
            <TableHead>
              <Skeleton className="my-1.5 h-4 w-24" />
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              <Skeleton className="my-1.5 h-4 w-32" />
            </TableHead>
            <TableHead className="hidden md:table-cell">
              <Skeleton className="my-1.5 h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="my-1.5 h-4 w-20" />
            </TableHead>
            <TableHead className="flex items-center justify-end" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {new Array(rows).fill(0).map((_) => (
            <TableRow key={Math.random()} className="hover:bg-transparent">
              <TableCell>
                <Skeleton className="my-1.5 h-4 w-full max-w-[10rem]" />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <Skeleton className="my-1.5 h-4 w-full max-w-[13rem]" />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Skeleton className="my-1.5 h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="my-1.5 h-4 w-full max-w-[10rem]" />
              </TableCell>
              <TableCell className="flex justify-end">
                <Skeleton className="my-1.5 h-5 w-5" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
