import { createTRPCRouter } from "#trpc"
import { cancel } from "./cancel"
import { changePhasePlan } from "./changePhasePlan"
import { create } from "./create"
import { createPhase } from "./createPhase"
import { getById } from "./getById"
import { invoice } from "./invoice"
import { listByActiveProject } from "./listByActiveProject"
import { listByPlanVersion } from "./listByPlanVersion"
import { machine } from "./machine"
import { removePhase } from "./removePhase"
import { updatePhase } from "./updatePhase"

export const subscriptionRouter = createTRPCRouter({
  create: create,
  createPhase: createPhase,
  listByActiveProject: listByActiveProject,
  listByPlanVersion: listByPlanVersion,
  getById: getById,
  cancel: cancel,
  updatePhase: updatePhase,
  removePhase: removePhase,
  changePhasePlan: changePhasePlan,
  invoice: invoice,
  machine: machine,
})
