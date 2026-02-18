import { createTRPCRouter } from "#trpc"
import { getBrowserVisits } from "./getBrowserVisits"
import { getCountryVisits } from "./getCountryVisits"
import { getFeaturesOverview } from "./getFeaturesOverview"
import { getLakehouseCredentials } from "./getLakehouseCredentials"
import { getLatestEvents } from "./getLatestEvents"
import { getOverviewStats } from "./getOverviewStats"
import { getPagesOverview } from "./getPagesOverview"
import { getPlanClickBySessionId } from "./getPlanClickBySessionId"
import { getPlansConversion } from "./getPlansConversion"
import { getPlansStats } from "./getPlansStats"
import { getRealtimeTicket } from "./getRealtimeTicket"
import { getUsage } from "./getUsage"
import { getVerificationRegions } from "./getVerificationRegions"
import { getVerifications } from "./getVerifications"

export const analyticsRouter = createTRPCRouter({
  getVerifications: getVerifications,
  getVerificationRegions: getVerificationRegions,
  getUsage: getUsage,
  getBrowserVisits: getBrowserVisits,
  getCountryVisits: getCountryVisits,
  getOverviewStats: getOverviewStats,
  getPlansConversion: getPlansConversion,
  getFeaturesOverview: getFeaturesOverview,
  getPlansStats: getPlansStats,
  getPagesOverview: getPagesOverview,
  getPlanClickBySessionId: getPlanClickBySessionId,
  getLatestEvents: getLatestEvents,
  getLakehouseCredentials: getLakehouseCredentials,
  getRealtimeTicket: getRealtimeTicket,
})
