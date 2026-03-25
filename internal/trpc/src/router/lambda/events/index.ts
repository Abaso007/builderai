import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { listByActiveProject } from "./listByActiveProject"
import { update } from "./update"

export const eventRouter = createTRPCRouter({
  create,
  update,
  listByActiveProject,
})
