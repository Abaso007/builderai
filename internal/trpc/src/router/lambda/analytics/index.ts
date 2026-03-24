import { createTRPCRouter } from "#trpc"
import { getBrowserVisits } from "./getBrowserVisits"
import { getCountryVisits } from "./getCountryVisits"
import { getLakehouseFilePlan } from "./getLakehouseFilePlan"
import { getLatestEvents } from "./getLatestEvents"
import { getOverviewStats } from "./getOverviewStats"
import { getPagesOverview } from "./getPagesOverview"
import { getPlanClickBySessionId } from "./getPlanClickBySessionId"
import { getPlansConversion } from "./getPlansConversion"
import { getPlansStats } from "./getPlansStats"
import { getRealtimeTicket } from "./getRealtimeTicket"
import { getUsage } from "./getUsage"

export const analyticsRouter = createTRPCRouter({
  getUsage: getUsage,
  getBrowserVisits: getBrowserVisits,
  getCountryVisits: getCountryVisits,
  getOverviewStats: getOverviewStats,
  getPlansConversion: getPlansConversion,
  getPlansStats: getPlansStats,
  getPagesOverview: getPagesOverview,
  getPlanClickBySessionId: getPlanClickBySessionId,
  getLatestEvents: getLatestEvents,
  getLakehouseFilePlan: getLakehouseFilePlan,
  getRealtimeTicket: getRealtimeTicket,
})
