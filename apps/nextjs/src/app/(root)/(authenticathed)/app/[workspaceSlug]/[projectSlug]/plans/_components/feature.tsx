import type { ComponentPropsWithoutRef, ElementRef } from "react"
import { forwardRef } from "react"

import type { FeaturePlan, FeatureType } from "@builderai/db/validators"
import { cn } from "@builderai/ui"
import { Badge } from "@builderai/ui/badge"
import { Button } from "@builderai/ui/button"
import { Trash2 } from "@builderai/ui/icons"

import { FeatureConfigForm } from "./feature-config-form"
import { FeatureForm } from "./feature-form"

interface FeatureCardBase {
  feature: FeaturePlan
  type: FeatureType
  projectSlug: string
  isOverlay?: boolean
}

export type FeatureCardProps =
  | (FeatureCardBase & {
      type: "Feature"
      deleteFeature?: (id: string) => void
      updateFeature?: (feature: FeaturePlan) => void
    })
  | (FeatureCardBase & {
      type: "Plan"
      deleteFeature: (id: string) => void
      updateFeature: (feature: FeaturePlan) => void
    })
  | (FeatureCardBase & {
      type: "Addon"
      deleteFeature: undefined
      updateFeature: undefined
    })

// A common pitfall when using the DragOverlay
// component is rendering the same component that
// calls useSortable inside the DragOverlay.
// This will lead to unexpected results,
// since there will be an id collision between the
// two components both calling useDraggable with the same id,
// since useSortable is an abstraction on top of useDraggable.
// To avoid this, make sure that the component that calls useSortable
// is not rendered inside the DragOverlay so basically this component renders the DragOverlay
// and for the sortable feature we have a separate component that wraps the feature card
// and calls useSortable
const FeatureCard = forwardRef<
  ElementRef<"div">,
  ComponentPropsWithoutRef<"div"> & FeatureCardProps
>(
  (
    {
      feature,
      deleteFeature,
      type,
      isOverlay = false,
      projectSlug,
      updateFeature,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        {...props}
        className={cn(
          "flex flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-all hover:bg-accent",
          props.className
        )}
      >
        <div className="flex w-full flex-col gap-1">
          <div className="flex items-center">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{feature.title}</div>
            </div>
            <div className={"ml-auto flex items-center"}>
              <Badge className="mr-2">{feature.type}</Badge>
              {!isOverlay &&
                (type === "Feature" ? (
                  <FeatureForm
                    projectSlug={projectSlug}
                    mode="edit"
                    feature={feature}
                  />
                ) : type === "Plan" ? (
                  <FeatureConfigForm
                    projectSlug={projectSlug}
                    feature={feature}
                    onSubmit={updateFeature}
                  />
                ) : type === "Addon" ? (
                  <FeatureForm
                    projectSlug={projectSlug}
                    mode="edit"
                    feature={feature}
                  />
                ) : null)}
              {deleteFeature && (
                <Button
                  onClick={() => deleteFeature(feature.id)}
                  variant="ghost"
                  size={"icon"}
                  className="h-8 w-8"
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">delete of plan</span>
                </Button>
              )}
            </div>
          </div>
          <div className="text-xs font-medium">{feature.title}</div>
        </div>
        {type !== "Feature" && (
          <>
            <div className="line-clamp-2 text-xs text-muted-foreground">
              {feature.description &&
                feature.description?.substring(0, 50) + "..."}
            </div>
            <div className={cn("ml-auto flex items-center text-xs")}>
              1000 calls per $5 USD
            </div>
          </>
        )}
      </div>
    )
  }
)

FeatureCard.displayName = "FeatureCard"

export { FeatureCard }