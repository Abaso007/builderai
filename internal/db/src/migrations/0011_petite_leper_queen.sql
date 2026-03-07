UPDATE "unprice_plan_versions_features" AS pvf
SET "meter_config" = f."meter_config"
FROM "unprice_features" AS f
WHERE pvf."feature_type" = 'usage'
  AND pvf."meter_config" IS NULL
  AND f."id" = pvf."feature_id"
  AND f."project_id" = pvf."project_id"
  AND f."meter_config" IS NOT NULL;

--> statement-breakpoint
DO $$
DECLARE
  unresolved_rows jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'projectId', pvf."project_id",
      'planVersionFeatureId', pvf."id",
      'planVersionId', pvf."plan_version_id",
      'featureId', pvf."feature_id"
    )
  )
  INTO unresolved_rows
  FROM "unprice_plan_versions_features" AS pvf
  WHERE pvf."feature_type" = 'usage'
    AND pvf."meter_config" IS NULL;

  IF unresolved_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot drop unprice_plan_versions_features.aggregation_method. Usage plan version features are missing meter_config: %',
      unresolved_rows::text;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "unprice_plan_versions_features" DROP COLUMN "aggregation_method";
