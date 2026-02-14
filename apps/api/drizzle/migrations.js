import m0000 from "./0000_real_bruce_banner.sql"
import m0001 from "./0001_add_analytics_columns.sql"
import m0002 from "./0002_sad_layla_miller.sql"
import m0003 from "./0003_sturdy_usage_rollups.sql"
import m0004 from "./0004_clever_report_usage_rollups.sql"
import m0005 from "./0005_marvelous_entitlement_snapshots.sql"
import journal from "./meta/_journal.json"

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005,
  },
}
