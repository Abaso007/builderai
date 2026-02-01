"use client"

import { useChat } from "@ai-sdk/react"
import { useOnboarding } from "@onboardjs/react"
import { useQuery } from "@tanstack/react-query"
import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Card } from "@unprice/ui/card"
import { LoadingAnimation } from "@unprice/ui/loading-animation"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@unprice/ui/resizable"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Textarea } from "@unprice/ui/text-area"
import { cn } from "@unprice/ui/utils"
import { DefaultChatTransport } from "ai"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  CreditCard,
  Folder,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Puzzle,
  Rocket,
  Send,
  Sparkles,
  X,
} from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FeaturePlan } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/_components/feature-plan"
import type { PricingChatMessage } from "~/app/api/chat/route"
import { PricingCard } from "~/components/forms/pricing-card"
import { useActivePlanVersion } from "~/hooks/use-features"
import { useTRPC } from "~/trpc/client"

// =============================================================================
// Types
// =============================================================================

type PlanData = {
  id: string
  slug: string
  description: string
  active: boolean | null
  defaultPlan: boolean | null
  enterprisePlan: boolean | null
}

type PlanVersionData = {
  id: string
  version: number
  status: string
  title: string | null
  currency: string
  planId: string
  billingConfig: {
    name: string
    billingInterval: string
    billingIntervalCount: number
    planType: string
  }
}

type FullPlanVersionData = RouterOutputs["planVersions"]["getById"]["planVersion"]

type ArtifactType =
  | "feature"
  | "plan"
  | "planVersion"
  | "planVersionFeature"
  | "publishedPlanVersion"

type Artifact = {
  id: string
  type: ArtifactType
  data: unknown
  toolInput: Record<string, unknown>
  createdAt: number
}

// =============================================================================
// Constants
// =============================================================================

const API_DOCS = {
  createFeature: {
    endpoint: "POST /api/features",
    description: "Creates a new feature that can be included in pricing plans.",
  },
  createPlan: {
    endpoint: "POST /api/plans",
    description: "Creates a new pricing plan bundling multiple features.",
  },
  createPlanVersion: {
    endpoint: "POST /api/plan-versions",
    description: "Creates a new version of a pricing plan.",
  },
  createPlanVersionFeature: {
    endpoint: "POST /api/plan-version-features",
    description: "Adds a feature to a plan version with pricing configuration.",
  },
} as const

// Tool types that should always be visible (not hidden on desktop)
const ALWAYS_VISIBLE_TOOL_TYPES = new Set(["tool-getPlanVersionById"])

// =============================================================================
// Utility Functions
// =============================================================================

function getArtifactIcon(type: ArtifactType) {
  switch (type) {
    case "plan":
      return <Folder className="h-4 w-4 text-primary-solid" />
    case "planVersion":
      return <CreditCard className="h-4 w-4 text-secondary-solid" />
    case "planVersionFeature":
      return <CheckCircle2 className="h-4 w-4 text-primary-solid" />
    case "publishedPlanVersion":
      return <Rocket className="h-4 w-4 text-success-solid" />
    default:
      return <Puzzle className="h-4 w-4 text-primary-solid" />
  }
}

function isToolCreating(state: string): boolean {
  return state === "input-streaming" || state === "input-available"
}

function hasToolError(part: { state?: string; output?: { state?: string } }): boolean {
  return part.state === "output-available" && part.output?.state === "error"
}

function isToolOutputReady(part: { state?: string; output?: { state?: string } }): boolean {
  return part.state === "output-available" && part.output?.state !== "error"
}

// =============================================================================
// Custom Hooks
// =============================================================================

function useApiKey() {
  const { state } = useOnboarding()
  return (state?.context?.flowData as { apiKey?: string })?.apiKey ?? "YOUR_API_KEY"
}

function usePlanVersionId() {
  const { state } = useOnboarding()
  return (state?.context?.flowData as { planVersionId?: string })?.planVersionId
}

function useProjectSlug() {
  const { state } = useOnboarding()
  return (state?.context?.flowData as { project?: { slug: string } })?.project?.slug
}

function usePlanVersionData(planVersionId: string | undefined, projectSlug: string | undefined) {
  const trpc = useTRPC()

  return useQuery(
    trpc.planVersions.getById.queryOptions(
      { id: planVersionId ?? "", projectSlug },
      { enabled: !!planVersionId && !!projectSlug }
    )
  )
}

function useAutoTextareaResize(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string
) {
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
    }
  }, [value, textareaRef])
}

function useScrollToBottom(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function useAutoOpenPanel(
  hasArtifacts: boolean,
  showPanel: boolean,
  setShowPanel: (show: boolean) => void
) {
  const hasAutoOpenedRef = useRef(false)

  useEffect(() => {
    if (hasArtifacts && !showPanel && !hasAutoOpenedRef.current) {
      if (typeof window !== "undefined" && window.innerWidth >= 768) {
        setShowPanel(true)
      }
      hasAutoOpenedRef.current = true
    }
  }, [hasArtifacts, showPanel, setShowPanel])
}

// =============================================================================
// Artifact Extraction Hooks
// =============================================================================

function useMessageArtifacts(messages: PricingChatMessage[]): Artifact[] {
  return useMemo(() => {
    const result: Artifact[] = []

    for (const message of messages) {
      if (message.role !== "assistant") continue

      for (const part of message.parts) {
        const artifact = extractArtifactFromPart(part)
        if (artifact) result.push(artifact)
      }
    }

    return result
  }, [messages])
}

function extractArtifactFromPart(part: PricingChatMessage["parts"][number]): Artifact | null {
  if (part.type === "tool-createFeature") {
    if (part.state === "output-available" && part.output.state === "created") {
      return {
        id: part.output.feature.id,
        type: "feature",
        data: part.output.feature,
        toolInput: part.input,
        createdAt: Date.now(),
      }
    }
  }

  if (part.type === "tool-createPlan") {
    if (part.state === "output-available" && part.output.state === "created") {
      return {
        id: part.output.plan.id,
        type: "plan",
        data: part.output.plan,
        toolInput: part.input,
        createdAt: Date.now(),
      }
    }
  }

  if (part.type === "tool-createPlanVersion") {
    if (
      part.state === "output-available" &&
      part.output.state === "created" &&
      part.output.planVersion
    ) {
      return {
        id: part.output.planVersion.id,
        type: "planVersion",
        data: part.output.planVersion,
        toolInput: part.input,
        createdAt: Date.now(),
      }
    }
  }

  if (part.type === "tool-createPlanVersionFeature") {
    if (
      part.state === "output-available" &&
      part.output.state === "created" &&
      part.output.planVersionFeature
    ) {
      return {
        id: part.output.planVersionFeature.id,
        type: "planVersionFeature",
        data: part.output.planVersionFeature,
        toolInput: part.input,
        createdAt: Date.now(),
      }
    }
  }

  return null
}

function useLoadedArtifacts(
  planVersion: FullPlanVersionData | undefined,
  isLoading: boolean
): Artifact[] {
  return useMemo(() => {
    if (!planVersion || isLoading) return []

    const result: Artifact[] = []

    // Plan
    result.push({
      id: planVersion.plan.id,
      type: "plan",
      data: planVersion.plan,
      toolInput: {
        slug: planVersion.plan.slug,
        description: planVersion.plan.description,
        defaultPlan: planVersion.plan.defaultPlan,
        enterprisePlan: planVersion.plan.enterprisePlan,
      },
      createdAt: Date.now(),
    })

    // Plan Version
    result.push({
      id: planVersion.id,
      type: "planVersion",
      data: planVersion,
      toolInput: {
        planId: planVersion.planId,
        currency: planVersion.currency,
        billingPeriod: planVersion.billingConfig.billingInterval,
        trialDays: 0,
      },
      createdAt: Date.now(),
    })

    // Features and PlanVersionFeatures
    for (const pf of planVersion.planFeatures) {
      result.push({
        id: pf.feature.id,
        type: "feature",
        data: pf.feature,
        toolInput: {
          title: pf.feature.title,
          slug: pf.feature.slug,
          description: pf.feature.description,
          unit: pf.feature.unit,
        },
        createdAt: Date.now(),
      })

      result.push({
        id: pf.id,
        type: "planVersionFeature",
        data: pf,
        toolInput: {
          planVersionId: planVersion.id,
          featureId: pf.featureId,
          featureType: pf.featureType,
        },
        createdAt: Date.now(),
      })
    }

    return result
  }, [planVersion, isLoading])
}

function useCombinedArtifacts(
  messageArtifacts: Artifact[],
  loadedArtifacts: Artifact[]
): Artifact[] {
  return useMemo(() => {
    const existingIds = new Set(messageArtifacts.map((a) => a.id))
    const newArtifacts = loadedArtifacts.filter((a) => !existingIds.has(a.id))
    return [...messageArtifacts, ...newArtifacts]
  }, [messageArtifacts, loadedArtifacts])
}

// =============================================================================
// API Code Generation
// =============================================================================

function generateApiCode(toolName: string, input: Record<string, unknown>, apiKey: string): string {
  const docs = API_DOCS[toolName as keyof typeof API_DOCS]
  if (!docs) return ""

  const formatJsonBody = (obj: Record<string, unknown>): string => {
    return JSON.stringify(obj, null, 2).split("\n").join("\n  ")
  }

  const baseUrl = "https://api.unprice.dev/v1"
  const headers = `-H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}"`

  switch (toolName) {
    case "createFeature":
      return `# ${docs.description}
curl -X POST ${baseUrl}/features \\
  ${headers} \\
  -d '${formatJsonBody({
    title: input.title,
    slug: input.slug,
    description: input.description,
    unit: input.unit,
  })}'`

    case "createPlan":
      return `# ${docs.description}
curl -X POST ${baseUrl}/plans \\
  ${headers} \\
  -d '${formatJsonBody({
    slug: input.slug,
    description: input.description,
    defaultPlan: input.defaultPlan,
    enterprisePlan: input.enterprisePlan,
  })}'`

    case "createPlanVersion":
      return `# ${docs.description}
curl -X POST ${baseUrl}/plan-versions \\
  ${headers} \\
  -d '${formatJsonBody({
    planId: input.planId,
    currency: input.currency,
    billingPeriod: input.billingPeriod,
    trialDays: input.trialDays,
  })}'`

    case "createPlanVersionFeature":
      return `# ${docs.description}
curl -X POST ${baseUrl}/plan-version-features \\
  ${headers} \\
  -d '${formatJsonBody({
    planVersionId: input.planVersionId,
    featureId: input.featureId,
    featureType: input.featureType,
  })}'`

    default:
      return ""
  }
}

// =============================================================================
// Memoized Sub-Components
// =============================================================================

const ErrorMessage = memo(function ErrorMessage({ error }: { error: string }) {
  return (
    <div className="my-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-900">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      <span className="text-sm">{error}</span>
    </div>
  )
})

const LoadingIndicator = memo(function LoadingIndicator({ text }: { text: string }) {
  return (
    <div className="my-2 flex items-center gap-2 text-background-text text-sm md:hidden">
      <LoadingAnimation className="h-4 w-4" />
      <span>{text}</span>
    </div>
  )
})

const ApiPreview = memo(function ApiPreview({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const apiKey = useApiKey()
  const code = generateApiCode(toolName, input, apiKey)
  const docs = API_DOCS[toolName as keyof typeof API_DOCS]

  if (!code || !docs) return null

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-background-line bg-background-base">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-background-bgHover"
      >
        <div className="flex items-center gap-2 text-background-text">
          <Code className="h-3.5 w-3.5 text-primary-solid" />
          <span className="font-mono text-background-textContrast">{docs.endpoint}</span>
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-background-text transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen && (
        <div className="border-background-line border-t">
          <div className="flex items-center justify-between bg-background-bg px-3 py-1.5">
            <span className="font-medium text-background-text text-xs">API Request</span>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-background-text text-xs transition-colors hover:bg-background-bgHover hover:text-background-textContrast"
            >
              {copied ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-success-solid" />
                  <span className="text-success-text">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  )
})

// =============================================================================
// Artifact Cards
// =============================================================================

const PlanCard = memo(function PlanCard({
  plan,
  isSelected,
  onSelect,
}: {
  plan: PlanData
  isSelected?: boolean
  onSelect?: () => void
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer border-2 p-4 transition-all duration-200",
        isSelected
          ? "border-primary-border bg-primary-bg ring-1 ring-primary-border"
          : "border-background-border bg-background-bgSubtle hover:border-background-borderHover"
      )}
      onClick={onSelect}
    >
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-background-textContrast text-lg">{plan.slug}</h3>
            {plan.defaultPlan && (
              <span className="rounded-full bg-primary-solid px-2 py-0.5 font-medium text-primary-foreground text-xs">
                Default
              </span>
            )}
            {plan.enterprisePlan && (
              <span className="rounded-full bg-warning-solid px-2 py-0.5 font-medium text-warning-foreground text-xs">
                Enterprise
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-background-text text-sm">{plan.description}</p>
        </div>
      </div>
    </Card>
  )
})

const PlanVersionCard = memo(function PlanVersionCard({
  version,
  isSelected,
  onSelect,
}: {
  version: PlanVersionData
  isSelected?: boolean
  onSelect?: () => void
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer border p-4 transition-all duration-200",
        isSelected
          ? "border-primary-border bg-primary-bg ring-1 ring-primary-border"
          : "border-background-border bg-background-bgSubtle hover:border-background-borderHover hover:bg-background-bg"
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-primary-border bg-primary-bg p-2">
          <CreditCard className="h-4 w-4 text-primary-solid" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-background-textContrast">
              {version.title || `Version ${version.version}`}
            </h4>
            <span className="rounded-full border border-background-border bg-background-bg px-2 py-0.5 text-background-text text-xs capitalize">
              {version.status}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-4 text-background-text text-xs">
            <div className="flex items-center gap-1">
              <span className="font-medium">Billing:</span>
              <span className="capitalize">{version.billingConfig.name}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="font-medium">Currency:</span>
              <span>{version.currency}</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
})

const PublishedPlanCard = memo(function PublishedPlanCard({
  planVersion,
  isSelected,
  onSelect,
}: {
  planVersion: FullPlanVersionData
  isSelected?: boolean
  onSelect?: () => void
}) {
  return (
    <div className={cn("relative transition-all duration-200", isSelected && "scale-[1.02]")}>
      <div className="-top-2 -right-2 absolute z-10">
        <span className="flex h-6 items-center gap-1 rounded-full bg-success-solid px-2 font-bold text-success-foreground text-xs shadow-sm">
          <Rocket className="h-3 w-3" />
          PUBLISHED
        </span>
      </div>
      <button type="button" onClick={onSelect} className="w-full cursor-pointer text-left">
        <PricingCard planVersion={planVersion} />
      </button>
    </div>
  )
})

// =============================================================================
// Artifact Reference (inline in chat messages)
// =============================================================================

const ArtifactReference = memo(function ArtifactReference({
  type,
  name,
  onView,
  isCreating,
  subtext,
}: {
  type: ArtifactType
  name: string
  onView: () => void
  isCreating?: boolean
  subtext?: string
}) {
  if (isCreating) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-background-line bg-background-bgSubtle px-3 py-2 md:hidden">
        <LoadingAnimation className="h-4 w-4 text-primary-solid" />
        <span className="text-background-text text-sm">
          Creating {type === "feature" ? "feature" : type === "plan" ? "plan" : "item"}...
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onView}
      className="my-2 flex w-full items-center justify-between gap-2 rounded-lg border border-background-line bg-background-bgSubtle px-3 py-2 text-left transition-colors hover:border-primary-border hover:bg-primary-bg md:hidden"
    >
      <div className="flex items-center gap-2">
        {getArtifactIcon(type)}
        <div className="flex flex-col">
          <span className="font-medium text-background-textContrast text-sm">{name}</span>
          {subtext && <span className="text-background-text text-xs">{subtext}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 text-primary-solid">
        <span className="text-xs">View</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </div>
    </button>
  )
})

// =============================================================================
// Artifacts Panel
// =============================================================================

const ArtifactsPanel = memo(function ArtifactsPanel({
  artifacts,
  selectedArtifactId,
  onSelectArtifact,
  onClose,
  isMobile,
}: {
  artifacts: Artifact[]
  selectedArtifactId: string | null
  onSelectArtifact: (id: string) => void
  onClose?: () => void
  isMobile?: boolean
}) {
  const artifactRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Scroll to selected artifact
  useEffect(() => {
    if (selectedArtifactId) {
      const element = artifactRefs.current.get(selectedArtifactId)
      element?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [selectedArtifactId])

  // Group artifacts by type
  const groupedArtifacts = useMemo(() => {
    return {
      published: artifacts.filter((a) => a.type === "publishedPlanVersion"),
      versions: artifacts.filter((a) => a.type === "planVersion"),
      plans: artifacts.filter((a) => a.type === "plan"),
      features: artifacts.filter((a) => a.type === "feature"),
      versionFeatures: artifacts.filter((a) => a.type === "planVersionFeature"),
    }
  }, [artifacts])

  const selectedArtifact = useMemo(
    () => artifacts.find((a) => a.id === selectedArtifactId),
    [artifacts, selectedArtifactId]
  )

  const setArtifactRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) artifactRefs.current.set(id, el)
    },
    []
  )

  return (
    <div className="flex h-full flex-col bg-background-base">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-background-line border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary-solid" />
          <h3 className="font-semibold text-background-textContrast text-sm">Artifacts</h3>
          <span className="rounded-full bg-background-bg px-2 py-0.5 text-background-text text-xs">
            {artifacts.length}
          </span>
        </div>
        {isMobile && onClose && (
          <Button variant="ghost" size="xs" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Artifacts List */}
      <ScrollArea className="flex-1">
        <div className="space-y-6 p-4">
          {/* Published Plans */}
          {groupedArtifacts.published.length > 0 && (
            <ArtifactSection title="Published Plans" icon={<Rocket className="h-3.5 w-3.5" />}>
              {groupedArtifacts.published.map((artifact) => (
                <div
                  key={artifact.id}
                  ref={setArtifactRef(artifact.id)}
                  className="flex justify-center"
                >
                  <PublishedPlanCard
                    planVersion={artifact.data as FullPlanVersionData}
                    isSelected={artifact.id === selectedArtifactId}
                    onSelect={() => onSelectArtifact(artifact.id)}
                  />
                </div>
              ))}
            </ArtifactSection>
          )}

          {/* Plan Versions */}
          {groupedArtifacts.versions.length > 0 && (
            <ArtifactSection title="Plan Versions" icon={<CreditCard className="h-3.5 w-3.5" />}>
              {groupedArtifacts.versions.map((artifact) => (
                <div key={artifact.id} ref={setArtifactRef(artifact.id)}>
                  <PlanVersionCard
                    version={artifact.data as PlanVersionData}
                    isSelected={artifact.id === selectedArtifactId}
                    onSelect={() => onSelectArtifact(artifact.id)}
                  />
                </div>
              ))}
            </ArtifactSection>
          )}

          {/* Plans */}
          {groupedArtifacts.plans.length > 0 && (
            <ArtifactSection title="Plans" icon={<Folder className="h-3.5 w-3.5" />}>
              {groupedArtifacts.plans.map((artifact) => (
                <div key={artifact.id} ref={setArtifactRef(artifact.id)}>
                  <PlanCard
                    plan={artifact.data as PlanData}
                    isSelected={artifact.id === selectedArtifactId}
                    onSelect={() => onSelectArtifact(artifact.id)}
                  />
                </div>
              ))}
            </ArtifactSection>
          )}

          {/* Features */}
          {groupedArtifacts.features.length > 0 && (
            <ArtifactSection title="Features" icon={<Puzzle className="h-3.5 w-3.5" />}>
              {groupedArtifacts.features.map((artifact) => (
                <div key={artifact.id} ref={setArtifactRef(artifact.id)}>
                  <FeaturePlan
                    mode="Feature"
                    planFeatureVersion={{ feature: artifact.data } as PlanVersionFeatureDragDrop}
                  />
                </div>
              ))}
            </ArtifactSection>
          )}

          {/* Plan Version Features */}
          {groupedArtifacts.versionFeatures.length > 0 && (
            <ArtifactSection
              title="Features in Plan Version"
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            >
              {groupedArtifacts.versionFeatures.map((artifact) => (
                <div key={artifact.id} ref={setArtifactRef(artifact.id)}>
                  <FeaturePlan
                    mode="FeaturePlan"
                    planFeatureVersion={artifact.data as PlanVersionFeatureDragDrop}
                  />
                </div>
              ))}
            </ArtifactSection>
          )}
        </div>
      </ScrollArea>

      {/* Selected Artifact Details */}
      {selectedArtifact && selectedArtifact.type !== "publishedPlanVersion" && (
        <div className="border-background-line border-t p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-background-textContrast text-sm">API Code</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onSelectArtifact("")}
              className="text-background-text"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ApiPreview
            toolName={`create${selectedArtifact.type.charAt(0).toUpperCase() + selectedArtifact.type.slice(1)}`}
            input={selectedArtifact.toolInput}
          />
        </div>
      )}
    </div>
  )
})

const ArtifactSection = memo(function ArtifactSection({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
        {icon}
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </div>
  )
})

// =============================================================================
// Message Part Renderers
// =============================================================================

function useMessagePartRenderer(handleViewArtifact: (id: string) => void) {
  return useCallback(
    (part: PricingChatMessage["parts"][number], index: number): React.ReactNode => {
      switch (part.type) {
        case "text":
          if (!part.text.trim()) return null
          return (
            <div key={index} className="whitespace-pre-wrap text-sm leading-relaxed">
              {part.text}
            </div>
          )

        case "tool-createFeature":
          return renderCreateFeaturePart(part, index, handleViewArtifact)

        case "tool-createPlan":
          return renderCreatePlanPart(part, index, handleViewArtifact)

        case "tool-createPlanVersion":
          return renderCreatePlanVersionPart(part, index, handleViewArtifact)

        case "tool-createPlanVersionFeature":
          return renderCreatePlanVersionFeaturePart(part, index, handleViewArtifact)

        case "tool-getPlanVersionById":
          return renderGetPlanVersionByIdPart(part, index)

        case "tool-listFeatures":
        case "tool-listPlans":
        case "tool-listPlanVersionFeatures":
        case "tool-getPlanBySlug":
          return renderListToolPart(part, index)

        default:
          return null
      }
    },
    [handleViewArtifact]
  )
}

function renderCreateFeaturePart(
  part: Extract<PricingChatMessage["parts"][number], { type: "tool-createFeature" }>,
  index: number,
  handleViewArtifact: (id: string) => void
) {
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (part.state === "output-available" && part.output.state === "created" && part.output.feature) {
    const feature = part.output.feature
    return (
      <ArtifactReference
        key={index}
        type="feature"
        name={feature.title}
        onView={() => handleViewArtifact(feature.id)}
      />
    )
  }

  if (isToolCreating(part.state)) {
    return <ArtifactReference key={index} type="feature" name="..." onView={() => {}} isCreating />
  }

  return null
}

function renderCreatePlanPart(
  part: Extract<PricingChatMessage["parts"][number], { type: "tool-createPlan" }>,
  index: number,
  handleViewArtifact: (id: string) => void
) {
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (part.state === "output-available" && part.output.state === "created" && part.output.plan) {
    const plan = part.output.plan
    return (
      <ArtifactReference
        key={index}
        type="plan"
        name={plan.slug}
        onView={() => handleViewArtifact(plan.id)}
      />
    )
  }

  if (isToolCreating(part.state)) {
    return <ArtifactReference key={index} type="plan" name="..." onView={() => {}} isCreating />
  }

  return null
}

function renderCreatePlanVersionPart(
  part: Extract<PricingChatMessage["parts"][number], { type: "tool-createPlanVersion" }>,
  index: number,
  handleViewArtifact: (id: string) => void
) {
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (
    part.state === "output-available" &&
    part.output.state === "created" &&
    part.output.planVersion
  ) {
    const version = part.output.planVersion
    return (
      <ArtifactReference
        key={index}
        type="planVersion"
        name={version.title || `Version ${version.version}`}
        subtext={`${version.currency} • ${version.billingConfig.name}`}
        onView={() => handleViewArtifact(version.id)}
      />
    )
  }

  if (isToolCreating(part.state)) {
    return (
      <ArtifactReference key={index} type="planVersion" name="..." onView={() => {}} isCreating />
    )
  }

  return null
}

function renderCreatePlanVersionFeaturePart(
  part: Extract<PricingChatMessage["parts"][number], { type: "tool-createPlanVersionFeature" }>,
  index: number,
  handleViewArtifact: (id: string) => void
) {
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (
    part.state === "output-available" &&
    part.output.state === "created" &&
    part.output.planVersionFeature
  ) {
    const feature = part.output.planVersionFeature
    return (
      <ArtifactReference
        key={index}
        type="planVersionFeature"
        name={feature.feature.title}
        subtext={feature.featureType}
        onView={() => handleViewArtifact(feature.id)}
      />
    )
  }

  if (isToolCreating(part.state)) {
    return (
      <ArtifactReference
        key={index}
        type="planVersionFeature"
        name="..."
        onView={() => {}}
        isCreating
      />
    )
  }

  return null
}

function renderGetPlanVersionByIdPart(
  part: Extract<PricingChatMessage["parts"][number], { type: "tool-getPlanVersionById" }>,
  index: number
) {
  const { next } = useOnboarding()
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (isToolCreating(part.state)) {
    return <LoadingIndicator key={index} text="Checking..." />
  }

  if (
    part.state === "output-available" &&
    part.output.state === "ready" &&
    part.output.planVersion
  ) {
    return (
      <div key={index} className="my-4">
        <PricingCard
          planVersion={part.output.planVersion}
          onPublish={() => {
            next()
          }}
        />
      </div>
    )
  }

  return null
}

function renderListToolPart(part: { state?: string; output?: { state?: string } }, index: number) {
  if (hasToolError(part)) {
    return <ErrorMessage key={index} error={(part.output as { error: string }).error} />
  }

  if (part.state === "input-streaming" || part.state === "input-available") {
    return <LoadingIndicator key={index} text="Checking..." />
  }

  return null
}

// =============================================================================
// Message Visibility Helpers
// =============================================================================

function shouldHideMessageOnDesktop(parts: PricingChatMessage["parts"]): boolean {
  return parts.every((part) => {
    if (part.type === "text") return !part.text.trim()

    if (part.type.startsWith("tool-")) {
      // Errors are always visible
      if (hasToolError(part as { state?: string; output?: { state?: string } })) {
        return false
      }

      // tool-getPlanVersionById with ready state should be visible (shows PricingCard)
      if (
        ALWAYS_VISIBLE_TOOL_TYPES.has(part.type) &&
        isToolOutputReady(part as { state?: string; output?: { state?: string } })
      ) {
        return false
      }

      // Other tool results are hidden on desktop (shown in artifacts panel)
      return true
    }

    return false
  })
}

function hasVisibleContent(parts: PricingChatMessage["parts"]): boolean {
  return parts.some((part) => {
    if (part.type === "text" && part.text.trim()) return true
    if (part.type.startsWith("tool-")) return true
    return false
  })
}

// =============================================================================
// Chat Panel Component
// =============================================================================

const ChatPanel = memo(function ChatPanel({
  messages,
  input,
  setInput,
  isLoading,
  showThinking,
  hasArtifacts,
  showArtifactsPanel,
  setShowArtifactsPanel,
  onSubmit,
  renderMessagePart,
}: {
  messages: PricingChatMessage[]
  input: string
  setInput: (value: string) => void
  isLoading: boolean
  showThinking: boolean
  hasArtifacts: boolean
  showArtifactsPanel: boolean
  setShowArtifactsPanel: (show: boolean) => void
  onSubmit: () => void
  renderMessagePart: (part: PricingChatMessage["parts"][number], index: number) => React.ReactNode
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useAutoTextareaResize(textareaRef, input)
  useScrollToBottom(messagesEndRef, [messages])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      onSubmit()
    },
    [onSubmit]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        onSubmit()
      }
    },
    [onSubmit]
  )

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-background-line border-b bg-background-bgSubtle px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-primary-border bg-primary-bg p-2">
            <Sparkles className="h-5 w-5 text-primary-solid" />
          </div>
          <div>
            <h2 className="font-semibold text-background-textContrast">Pricing Assistant</h2>
            <p className="hidden text-background-text text-sm sm:block">
              Create and manage your SaaS pricing plans
            </p>
          </div>
        </div>

        {hasArtifacts && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowArtifactsPanel(!showArtifactsPanel)}
            className="md:hidden"
          >
            {showArtifactsPanel ? (
              <PanelRightClose className="h-5 w-5" />
            ) : (
              <PanelRightOpen className="h-5 w-5" />
            )}
          </Button>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-4 md:p-6">
          {messages.length === 0 && <WelcomeScreen setInput={setInput} />}

          {messages.map((message) => {
            if (!hasVisibleContent(message.parts) && message.role === "assistant") return null

            const hideOnDesktop = shouldHideMessageOnDesktop(message.parts)

            return (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === "user" ? "justify-end" : "justify-start",
                  hideOnDesktop && "md:hidden"
                )}
              >
                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl px-4 py-3 md:max-w-[85%]",
                    message.role === "user"
                      ? "border border-primary-border bg-primary-bg text-primary-textContrast"
                      : "border border-background-line bg-background-bg text-background-textContrast"
                  )}
                >
                  {message.parts.map((part, index) => renderMessagePart(part, index))}
                </div>
              </div>
            )
          })}

          {showThinking && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-background-line bg-background-bg px-4 py-3">
                <div className="flex items-center gap-3">
                  <LoadingAnimation variant="dots" className="text-primary-solid" />
                  <span className="text-background-text text-sm">Thinking...</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-background-line border-t bg-background-bgSubtle p-4">
        <form onSubmit={handleSubmit} className="flex items-start gap-3">
          <Textarea
            id="pricing-chat-input"
            rows={1}
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your pricing needs..."
            disabled={isLoading}
            className="h-[36px] max-h-[100px] resize-none"
          />
          <Button
            type="submit"
            disabled={isLoading || !input.trim()}
            variant="primary"
            size="icon"
            className="shrink-0"
          >
            {isLoading ? <LoadingAnimation className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            <span className="sr-only">Send message</span>
          </Button>
        </form>
      </div>
    </div>
  )
})

const WelcomeScreen = memo(function WelcomeScreen({
  setInput,
}: {
  setInput: (value: string) => void
}) {
  const prompts = [
    "I want to build a plan with tokens as pay-per-usage at 10 euros monthly",
    "Create a Pro plan with 100 API calls, 5 team members, unlimited storage for $29/month",
  ]

  return (
    <div className="py-12 text-center">
      <div className="mx-auto mb-4 w-fit rounded-full border border-primary-border bg-primary-bg p-4">
        <Sparkles className="h-8 w-8 text-primary-solid" />
      </div>
      <h3 className="mb-2 font-semibold text-background-textContrast text-lg">
        Welcome to Pricing Assistant
      </h3>
      <p className="mx-auto max-w-md text-background-text text-sm">
        Describe your SaaS product and I'll help you create the perfect pricing plan.
      </p>
      <div className="mt-6 space-y-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => setInput(prompt)}
            className="mx-auto block w-full max-w-md rounded-lg border border-background-line bg-background-bg px-4 py-3 text-left text-background-textContrast text-sm transition-all hover:border-background-borderHover hover:bg-background-bgHover"
          >
            "{prompt}"
          </button>
        ))}
      </div>
    </div>
  )
})

// =============================================================================
// Main Component
// =============================================================================

export function PricingChat() {
  const [input, setInput] = useState("")
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [showArtifactsPanel, setShowArtifactsPanel] = useState(false)

  const { messages, sendMessage, status, setMessages } = useChat<PricingChatMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  })

  const { updateContext, state, skip } = useOnboarding()
  const planVersionId = usePlanVersionId()
  const projectSlug = useProjectSlug()
  const { data: loadedData, isLoading: isLoadingPlanVersion } = usePlanVersionData(
    planVersionId,
    projectSlug
  )

  const [, setActivePlanVersion] = useActivePlanVersion()

  useEffect(() => {
    if (loadedData?.planVersion) {
      setActivePlanVersion(loadedData.planVersion)
    }
  }, [loadedData?.planVersion?.id])

  // Restore pricing card if plan version is loaded but chat is empty
  const hasRestoredRef = useRef(false)
  useEffect(() => {
    if (loadedData?.planVersion && messages.length === 0 && !hasRestoredRef.current) {
      hasRestoredRef.current = true
      setMessages([
        {
          id: "restored-plan-version",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool-getPlanVersionById",
              state: "output-available",
              toolCallId: "restored-call",
              input: { planVersionId: loadedData.planVersion.id },
              output: {
                state: "ready",
                planVersion: loadedData.planVersion,
              },
            },
          ],
        } as PricingChatMessage,
      ])
    }
  }, [loadedData?.planVersion, messages.length, setMessages])

  // Extract and combine artifacts
  const messageArtifacts = useMessageArtifacts(messages)
  const loadedArtifacts = useLoadedArtifacts(loadedData?.planVersion, isLoadingPlanVersion)
  const artifacts = useCombinedArtifacts(messageArtifacts, loadedArtifacts)

  // Update context when a plan version is created
  useEffect(() => {
    const latestPlanVersion = [...artifacts].reverse().find((a) => a.type === "planVersion")

    if (latestPlanVersion) {
      const planVersionData = latestPlanVersion.data as PlanVersionData
      const currentPlanVersionId = (state?.context?.flowData as { planVersionId?: string })
        ?.planVersionId

      if (currentPlanVersionId !== planVersionData.id) {
        updateContext({ flowData: { planVersionId: planVersionData.id } })
      }
    }
  }, [artifacts, updateContext, state?.context?.flowData])

  const hasArtifacts = artifacts.length > 0
  useAutoOpenPanel(hasArtifacts, showArtifactsPanel, setShowArtifactsPanel)

  const isLoading = status === "streaming" || status === "submitted"

  const showThinking = useMemo(() => {
    if (!isLoading) return false
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage || lastMessage.role === "user") return true
    if (lastMessage.parts.length === 0) return true

    return !lastMessage.parts.some((part) => {
      if (part.type === "text" && part.text.trim()) return true
      if (part.type.startsWith("tool-")) {
        const state = (part as { state?: string }).state
        return (
          state === "input-streaming" || state === "input-available" || state === "output-available"
        )
      }
      return false
    })
  }, [isLoading, messages])

  const handleViewArtifact = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId)
    setShowArtifactsPanel(true)
  }, [])

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return
    sendMessage({ text: input })
    setInput("")
  }, [input, isLoading, sendMessage])

  const renderMessagePart = useMessagePartRenderer(handleViewArtifact)

  const chatPanel = (
    <ChatPanel
      messages={messages}
      input={input}
      setInput={setInput}
      isLoading={isLoading}
      showThinking={showThinking}
      hasArtifacts={hasArtifacts}
      showArtifactsPanel={showArtifactsPanel}
      setShowArtifactsPanel={setShowArtifactsPanel}
      onSubmit={handleSubmit}
      renderMessagePart={renderMessagePart}
    />
  )

  // Mobile: Overlay panel
  if (showArtifactsPanel && hasArtifacts) {
    return (
      <div className="flex h-full max-h-[800px] animate-content flex-col overflow-hidden rounded-xl border border-background-border bg-background-base shadow-sm delay-[0.2s]!">
        {/* Mobile: Show artifacts panel as overlay */}
        <div className="relative flex h-full md:hidden">
          {chatPanel}
          <div className="absolute inset-0 z-10 bg-background-base">
            <ArtifactsPanel
              artifacts={artifacts}
              selectedArtifactId={selectedArtifactId}
              onSelectArtifact={setSelectedArtifactId}
              onClose={() => setShowArtifactsPanel(false)}
              isMobile
            />
          </div>
        </div>

        {/* Desktop: Resizable panels */}
        <div className="hidden h-full md:block">
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel defaultSize={60} minSize={40}>
              {chatPanel}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={40} minSize={25}>
              <ArtifactsPanel
                artifacts={artifacts}
                selectedArtifactId={selectedArtifactId}
                onSelectArtifact={setSelectedArtifactId}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    )
  }

  // No artifacts yet - just show chat
  return (
    <>
      <div className="flex h-full max-h-[800px] animate-content flex-col overflow-hidden rounded-xl border border-background-border bg-background-base shadow-sm delay-[0.2s]!">
        {chatPanel}
      </div>
      <div className="flex animate-content justify-center p-8 delay-[0.2s]!">
        <Button variant="outline" onClick={() => skip()} className="w-full">
          I'll do it manually
        </Button>
      </div>
    </>
  )
}
