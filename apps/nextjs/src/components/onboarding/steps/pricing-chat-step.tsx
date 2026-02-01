"use client"

import { useChat } from "@ai-sdk/react"
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
  Layers,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Rocket,
  Send,
  Sparkles,
  Tag,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PricingChatMessage } from "~/app/api/chat/route"
import { PricingCard } from "~/components/forms/pricing-card"

// =============================================================================
// Types
// =============================================================================

type FeatureData = {
  id: string
  title: string
  slug: string
  description: string | null
  unit: string
}

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

type PlanVersionFeatureData = {
  id: string
  featureType: string
  feature: FeatureData
  planVersionId: string
}

type FullPlanVersionData = RouterOutputs["planVersions"]["getById"]["planVersion"]

type Artifact = {
  id: string
  type: "feature" | "plan" | "planVersion" | "planVersionFeature" | "publishedPlanVersion"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  toolInput: Record<string, unknown>
  createdAt: number
}

// =============================================================================
// API Documentation
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
  publishPlanVersion: {
    endpoint: "POST /api/plan-versions/{id}/publish",
    description: "Publishes a plan version, making it available to customers.",
  },
  listFeatures: {
    endpoint: "GET /api/features",
    description: "Retrieves all available features.",
  },
  listPlans: {
    endpoint: "GET /api/plans",
    description: "Retrieves all pricing plans.",
  },
}

function generateApiCode(toolName: string, input: Record<string, unknown>): string {
  const docs = API_DOCS[toolName as keyof typeof API_DOCS]
  if (!docs) return ""

  const formatJsonBody = (obj: Record<string, unknown>): string => {
    return JSON.stringify(obj, null, 2).split("\n").join("\n  ")
  }

  switch (toolName) {
    case "createFeature":
      return `# ${docs.description}
curl -X POST https://api.unprice.dev/v1/features \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '${formatJsonBody({
    title: input.title,
    slug: input.slug,
    description: input.description,
    unit: input.unit,
  })}'`

    case "createPlan":
      return `# ${docs.description}
curl -X POST https://api.unprice.dev/v1/plans \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '${formatJsonBody({
    slug: input.slug,
    description: input.description,
    defaultPlan: input.defaultPlan,
    enterprisePlan: input.enterprisePlan,
  })}'`

    case "createPlanVersion":
      return `# ${docs.description}
curl -X POST https://api.unprice.dev/v1/plan-versions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '${formatJsonBody({
    planId: input.planId,
    currency: input.currency,
    billingPeriod: input.billingPeriod,
    trialDays: input.trialDays,
  })}'`

    case "createPlanVersionFeature":
      return `# ${docs.description}
curl -X POST https://api.unprice.dev/v1/plan-version-features \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '${formatJsonBody({
    planVersionId: input.planVersionId,
    featureId: input.featureId,
    featureType: input.featureType,
  })}'`

    case "publishPlanVersion":
      return `# ${docs.description}
curl -X POST https://api.unprice.dev/v1/plan-versions/${input.planVersionId}/publish \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY"`

    default:
      return ""
  }
}

// =============================================================================
// API Preview Component (for Artifacts Panel)
// =============================================================================

function ApiPreview({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const code = generateApiCode(toolName, input)
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
}

// =============================================================================
// Artifact Cards (for Panel)
// =============================================================================

function FeatureCard({
  feature,
  isSelected,
  onSelect,
}: {
  feature: FeatureData
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
          <Package className="h-4 w-4 text-primary-solid" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-background-textContrast">{feature.title}</h4>
            <span className="rounded-full border border-background-border bg-background-bg px-2 py-0.5 font-mono text-background-text text-xs">
              {feature.slug}
            </span>
          </div>
          {feature.description && (
            <p className="mt-1 line-clamp-2 text-background-text text-sm">{feature.description}</p>
          )}
          <p className="mt-1.5 text-background-text text-xs">
            <span className="font-medium">Unit:</span> {feature.unit}
          </p>
        </div>
      </div>
    </Card>
  )
}

function PlanCard({
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
}

function PlanVersionCard({
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
          <Layers className="h-4 w-4 text-primary-solid" />
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
}

function PlanVersionFeatureCard({
  feature,
  isSelected,
  onSelect,
}: {
  feature: PlanVersionFeatureData
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
          <Tag className="h-4 w-4 text-primary-solid" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-medium text-background-textContrast">{feature.feature.title}</h4>
            <span className="rounded-full border border-background-border bg-background-bg px-2 py-0.5 text-background-text text-xs capitalize">
              {feature.featureType}
            </span>
          </div>
          <p className="mt-1 text-background-text text-xs">
            <span className="font-medium">Unit:</span> {feature.feature.unit}
          </p>
        </div>
      </div>
    </Card>
  )
}

function PublishedPlanCard({
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
      <div className="absolute -top-2 -right-2 z-10">
        <span className="flex h-6 items-center gap-1 rounded-full bg-success-solid px-2 text-success-foreground text-xs font-bold shadow-sm">
          <Rocket className="h-3 w-3" />
          PUBLISHED
        </span>
      </div>
      <div
        // biome-ignore lint/a11y/useSemanticElements: <explanation>
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            onSelect?.()
          }
        }}
        className="w-full cursor-pointer text-left"
      >
        <PricingCard planVersion={planVersion} />
      </div>
    </div>
  )
}

// =============================================================================
// Artifact Reference (inline in chat messages)
// =============================================================================

function ErrorMessage({ error }: { error: string }) {
  return (
    <div className="my-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-900">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      <span className="text-sm">{error}</span>
    </div>
  )
}

function ArtifactReference({
  type,
  name,
  onView,
  isCreating,
  subtext,
}: {
  type: "feature" | "plan" | "planVersion" | "planVersionFeature" | "publishedPlanVersion"
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

  let icon = <Package className="h-4 w-4 text-primary-solid" />
  if (type === "plan") icon = <Layers className="h-4 w-4 text-primary-solid" />
  if (type === "planVersion") icon = <Layers className="h-4 w-4 text-secondary-solid" />
  if (type === "planVersionFeature") icon = <Tag className="h-4 w-4 text-primary-solid" />
  if (type === "publishedPlanVersion") icon = <Rocket className="h-4 w-4 text-success-solid" />

  return (
    <button
      type="button"
      onClick={onView}
      className="my-2 flex w-full items-center justify-between gap-2 rounded-lg border border-background-line bg-background-bgSubtle px-3 py-2 text-left transition-colors hover:border-primary-border hover:bg-primary-bg md:hidden"
    >
      <div className="flex items-center gap-2">
        {icon}
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
}

// =============================================================================
// Artifacts Panel
// =============================================================================

function ArtifactsPanel({
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
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
  }, [selectedArtifactId])

  // Group artifacts
  const features = artifacts.filter((a) => a.type === "feature")
  const plans = artifacts.filter((a) => a.type === "plan")
  const versions = artifacts.filter((a) => a.type === "planVersion")
  const versionFeatures = artifacts.filter((a) => a.type === "planVersionFeature")
  const published = artifacts.filter((a) => a.type === "publishedPlanVersion")

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId)

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
          {published.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
                <Rocket className="h-3.5 w-3.5" />
                Published Plans
              </h4>
              <div className="space-y-4">
                {published.map((artifact) => (
                  <div
                    key={artifact.id}
                    ref={(el) => {
                      if (el) artifactRefs.current.set(artifact.id, el)
                    }}
                    className="flex justify-center"
                  >
                    <PublishedPlanCard
                      planVersion={artifact.data as FullPlanVersionData}
                      isSelected={artifact.id === selectedArtifactId}
                      onSelect={() => onSelectArtifact(artifact.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Plan Versions */}
          {versions.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
                <Layers className="h-3.5 w-3.5" />
                Plan Versions
              </h4>
              <div className="space-y-2">
                {versions.map((artifact) => (
                  <div
                    key={artifact.id}
                    ref={(el) => {
                      if (el) artifactRefs.current.set(artifact.id, el)
                    }}
                  >
                    <PlanVersionCard
                      version={artifact.data as PlanVersionData}
                      isSelected={artifact.id === selectedArtifactId}
                      onSelect={() => onSelectArtifact(artifact.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Plans */}
          {plans.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
                <Layers className="h-3.5 w-3.5" />
                Plans
              </h4>
              <div className="space-y-2">
                {plans.map((artifact) => (
                  <div
                    key={artifact.id}
                    ref={(el) => {
                      if (el) artifactRefs.current.set(artifact.id, el)
                    }}
                  >
                    <PlanCard
                      plan={artifact.data as PlanData}
                      isSelected={artifact.id === selectedArtifactId}
                      onSelect={() => onSelectArtifact(artifact.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Features */}
          {features.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
                <Package className="h-3.5 w-3.5" />
                Features
              </h4>
              <div className="space-y-2">
                {features.map((artifact) => (
                  <div
                    key={artifact.id}
                    ref={(el) => {
                      if (el) artifactRefs.current.set(artifact.id, el)
                    }}
                  >
                    <FeatureCard
                      feature={artifact.data as FeatureData}
                      isSelected={artifact.id === selectedArtifactId}
                      onSelect={() => onSelectArtifact(artifact.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Plan Version Features */}
          {versionFeatures.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 font-medium text-background-text text-xs uppercase tracking-wide">
                <Tag className="h-3.5 w-3.5" />
                Added Features
              </h4>
              <div className="space-y-2">
                {versionFeatures.map((artifact) => (
                  <div
                    key={artifact.id}
                    ref={(el) => {
                      if (el) artifactRefs.current.set(artifact.id, el)
                    }}
                  >
                    <PlanVersionFeatureCard
                      feature={artifact.data as PlanVersionFeatureData}
                      isSelected={artifact.id === selectedArtifactId}
                      onSelect={() => onSelectArtifact(artifact.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
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
}

// =============================================================================
// Main Component
// =============================================================================

export function PricingChat() {
  const [input, setInput] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [showArtifactsPanel, setShowArtifactsPanel] = useState(false)

  const { messages, sendMessage, status } = useChat<PricingChatMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  })

  // Extract artifacts from messages
  const artifacts = useMemo(() => {
    const result: Artifact[] = []
    for (const message of messages) {
      if (message.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type === "tool-createFeature") {
          if (part.state === "output-available" && part.output.state === "created") {
            result.push({
              id: part.output.feature.id,
              type: "feature",
              data: part.output.feature,
              toolInput: part.input,
              createdAt: Date.now(),
            })
          }
        } else if (part.type === "tool-createPlan") {
          if (part.state === "output-available" && part.output.state === "created") {
            result.push({
              id: part.output.plan.id,
              type: "plan",
              data: part.output.plan,
              toolInput: part.input,
              createdAt: Date.now(),
            })
          }
        } else if (part.type === "tool-createPlanVersion") {
          if (
            part.state === "output-available" &&
            part.output.state === "created" &&
            part.output.planVersion
          ) {
            result.push({
              id: part.output.planVersion.id,
              type: "planVersion",
              data: part.output.planVersion,
              toolInput: part.input,
              createdAt: Date.now(),
            })
          }
        } else if (part.type === "tool-createPlanVersionFeature") {
          if (
            part.state === "output-available" &&
            part.output.state === "created" &&
            part.output.planVersionFeature
          ) {
            result.push({
              id: part.output.planVersionFeature.id,
              type: "planVersionFeature",
              data: part.output.planVersionFeature,
              toolInput: part.input,
              createdAt: Date.now(),
            })
          }
        } else if (part.type === "tool-publishPlanVersion") {
          if (
            part.state === "output-available" &&
            part.output.state === "published" &&
            part.output.planVersion
          ) {
            // Check if we already have this published version to avoid duplicates
            if (!result.find((a) => a.id === part.output.planVersion!.id)) {
              result.push({
                id: part.output.planVersion!.id,
                type: "publishedPlanVersion",
                data: part.output.planVersion,
                toolInput: part.input,
                createdAt: Date.now(),
              })
            }
          }
        }
      }
    }
    return result
  }, [messages])

  const hasArtifacts = artifacts.length > 0

  // Auto-show panel when first artifact is created
  const hasAutoOpenedRef = useRef(false)

  useEffect(() => {
    if (hasArtifacts && !showArtifactsPanel && !hasAutoOpenedRef.current) {
      // Only auto-show on desktop
      if (window.innerWidth >= 768) {
        setShowArtifactsPanel(true)
      }
      hasAutoOpenedRef.current = true
    }
  }, [hasArtifacts, showArtifactsPanel])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
    }
  }, [input])

  const handleViewArtifact = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId)
    setShowArtifactsPanel(true)
  }, [])

  const isLoading = status === "streaming" || status === "submitted"

  // Check if we should show "Thinking..." indicator
  const lastMessage = messages[messages.length - 1]
  const showThinking = useMemo(() => {
    if (!isLoading) return false
    if (!lastMessage || lastMessage.role === "user") return true
    if (lastMessage.parts.length === 0) return true

    // Check if any part actually renders content
    const hasRenderedContent = lastMessage.parts.some((part) => {
      if (part.type === "text" && part.text.trim()) return true
      if (part.type.startsWith("tool-")) {
        const state = (part as { state?: string }).state
        return (
          state === "input-streaming" || state === "input-available" || state === "output-available"
        )
      }
      return false
    })

    return !hasRenderedContent
  }, [isLoading, lastMessage])

  // Render message parts
  const renderMessagePart = (
    part: PricingChatMessage["parts"][number],
    index: number,
    _messageId: string
  ) => {
    switch (part.type) {
      case "text":
        if (!part.text.trim()) return null
        return (
          <div key={index.toString()} className="whitespace-pre-wrap text-sm leading-relaxed">
            {part.text}
          </div>
        )

      case "tool-createFeature": {
        const isCreating = part.state === "input-streaming" || part.state === "input-available"
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        if (
          part.state === "output-available" &&
          part.output.state === "created" &&
          part.output.feature
        ) {
          const feature = part.output.feature
          return (
            <ArtifactReference
              key={index.toString()}
              type="feature"
              name={feature.title}
              onView={() => handleViewArtifact(feature.id)}
            />
          )
        }
        if (isCreating) {
          return (
            <ArtifactReference
              key={index.toString()}
              type="feature"
              name="..."
              onView={() => {}}
              isCreating
            />
          )
        }
        return null
      }

      case "tool-createPlan": {
        const isCreating = part.state === "input-streaming" || part.state === "input-available"
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        if (
          part.state === "output-available" &&
          part.output.state === "created" &&
          part.output.plan
        ) {
          const plan = part.output.plan
          return (
            <ArtifactReference
              key={index.toString()}
              type="plan"
              name={plan.slug}
              onView={() => handleViewArtifact(plan.id)}
            />
          )
        }
        if (isCreating) {
          return (
            <ArtifactReference
              key={index.toString()}
              type="plan"
              name="..."
              onView={() => {}}
              isCreating
            />
          )
        }
        return null
      }

      case "tool-createPlanVersion": {
        const isCreating = part.state === "input-streaming" || part.state === "input-available"
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        if (
          part.state === "output-available" &&
          part.output.state === "created" &&
          part.output.planVersion
        ) {
          const version = part.output.planVersion
          return (
            <ArtifactReference
              key={index.toString()}
              type="planVersion"
              name={version.title || `Version ${version.version}`}
              subtext={`${version.currency} • ${version.billingConfig.name}`}
              onView={() => handleViewArtifact(version.id)}
            />
          )
        }
        if (isCreating) {
          return (
            <ArtifactReference
              key={index.toString()}
              type="planVersion"
              name="..."
              onView={() => {}}
              isCreating
            />
          )
        }
        return null
      }

      case "tool-createPlanVersionFeature": {
        const isCreating = part.state === "input-streaming" || part.state === "input-available"
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        if (
          part.state === "output-available" &&
          part.output.state === "created" &&
          part.output.planVersionFeature
        ) {
          const feature = part.output.planVersionFeature
          return (
            <ArtifactReference
              key={index.toString()}
              type="planVersionFeature"
              name={feature.feature.title}
              subtext={feature.featureType}
              onView={() => handleViewArtifact(feature.id)}
            />
          )
        }
        if (isCreating) {
          return (
            <ArtifactReference
              key={index.toString()}
              type="planVersionFeature"
              name="..."
              onView={() => {}}
              isCreating
            />
          )
        }
        return null
      }

      case "tool-publishPlanVersion": {
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        if (
          part.state === "output-available" &&
          part.output.state === "published" &&
          part.output.planVersion
        ) {
          const version = part.output.planVersion
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const planName =
            (version as unknown as { plan?: { slug: string } }).plan?.slug ??
            "Published Plan Version"

          return (
            <ArtifactReference
              key={index.toString()}
              type="publishedPlanVersion"
              name={planName}
              subtext="Published Successfully"
              onView={() => handleViewArtifact(version.id)}
            />
          )
        }
        return null
      }

      case "tool-listFeatures":
      case "tool-listPlans":
      case "tool-listPlanVersionFeatures":
      case "tool-getPlanBySlug":
      case "tool-getPlanVersionById": {
        if (part.state === "output-available" && (part.output as any).state === "error") {
          return <ErrorMessage key={index.toString()} error={(part.output as any).error} />
        }
        // Just show status for read operations
        if (part.state === "input-streaming" || part.state === "input-available") {
          return (
            <div
              key={index.toString()}
              className="my-2 flex items-center gap-2 text-background-text text-sm md:hidden"
            >
              <LoadingAnimation className="h-4 w-4" />
              <span>Checking...</span>
            </div>
          )
        }
        return null
      }

      default:
        return null
    }
  }

  // Chat Panel Content
  const chatPanel = (
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

        {/* Mobile toggle for artifacts panel */}
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
          {messages.length === 0 && (
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
                <button
                  type="button"
                  onClick={() =>
                    setInput(
                      "I want to build a plan with tokens as pay-per-usage at 10 euros monthly"
                    )
                  }
                  className="mx-auto block w-full max-w-md rounded-lg border border-background-line bg-background-bg px-4 py-3 text-left text-background-textContrast text-sm transition-all hover:border-background-borderHover hover:bg-background-bgHover"
                >
                  "I want to build a plan with tokens as pay-per-usage at 10 euros monthly"
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setInput(
                      "Create a Pro plan with 100 API calls, 5 team members, unlimited storage for $29/month"
                    )
                  }
                  className="mx-auto block w-full max-w-md rounded-lg border border-background-line bg-background-bg px-4 py-3 text-left text-background-textContrast text-sm transition-all hover:border-background-borderHover hover:bg-background-bgHover"
                >
                  "Create a Pro plan with 100 API calls, 5 team members, unlimited storage for
                  $29/month"
                </button>
              </div>
            </div>
          )}

          {messages.map((message) => {
            const hasContent = message.parts.some((part) => {
              if (part.type === "text" && part.text.trim()) return true
              if (part.type.startsWith("tool-")) return true
              return false
            })

            if (!hasContent && message.role === "assistant") return null

            // Calculate if this message should be hidden on desktop
            const onlyHiddenContent = message.parts.every((part) => {
              if (part.type === "text") return !part.text.trim()
              if (part.type.startsWith("tool-")) {
                // If it's an error, it's visible
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (
                  "state" in part &&
                  part.state === "output-available" &&
                  (part.output as any).state === "error"
                ) {
                  return false
                }
                // Otherwise (loading or success), it's hidden on desktop
                return true
              }
              return false
            })

            return (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === "user" ? "justify-end" : "justify-start",
                  onlyHiddenContent && "md:hidden"
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
                  {message.parts.map((part, index) => renderMessagePart(part, index, message.id))}
                </div>
              </div>
            )
          })}

          {/* Thinking indicator */}
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
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!input.trim() || isLoading) return
            sendMessage({ text: input })
            setInput("")
          }}
          className="flex items-start gap-3"
        >
          <Textarea
            id="pricing-chat-input"
            rows={1}
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (input.trim() && !isLoading) {
                  sendMessage({ text: input })
                  setInput("")
                }
              }
            }}
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
    <div className="flex h-full max-h-[800px] animate-content flex-col overflow-hidden rounded-xl border border-background-border bg-background-base shadow-sm delay-[0.2s]!">
      {chatPanel}
    </div>
  )
}
