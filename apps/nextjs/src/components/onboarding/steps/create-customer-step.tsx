import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import { Check, Copy, Loader2, UserPlus } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"

export function CreateCustomerStep({
  className,
}: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, next, updateContext } = useOnboarding()
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const apiKey = (state?.context?.flowData as { apiKey?: string })?.apiKey || ""
  const planVersionId =
    (state?.context?.flowData as { planVersionId?: string })?.planVersionId || ""

  // Default values for the demo
  const [formData, setFormData] = useState({
    name: "Onboarding User",
    email: "onboarding@example.com",
  })

  const successUrl = "http://localhost:3000/success"
  const cancelUrl = "http://localhost:3000/cancel"

  const curlCommand = `curl -X POST ${API_DOMAIN}v1/customer/signUp \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "${formData.name}",
    "email": "${formData.email}",
    "planVersionId": "${planVersionId}",
    "successUrl": "${successUrl}",
    "cancelUrl": "${cancelUrl}"
  }'`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success("Copied to clipboard")
  }

  const handleCreateWithContext = async () => {
    setIsLoading(true)
    try {
      const response = await fetch(`${API_DOMAIN}v1/customer/signUp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          planVersionId: planVersionId,
          successUrl,
          cancelUrl,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || "Failed to create customer")
      }

      const data = await response.json()
      toast.success("Customer created successfully!")

      updateContext({
        flowData: {
          customer: data,
        },
      })

      next()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className={cn("flex max-w-lg flex-col gap-6", className)}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
            <UserPlus className="size-6 text-primary" />
          </div>
          <h1 className="animate-content font-bold text-2xl delay-0!">
            Create your first Customer
          </h1>
          <div className="animate-content text-center text-muted-foreground text-sm delay-0!">
            Now that you have a plan, let's create a customer subscribed to it.
          </div>
        </div>

        <div className="animate-content delay-200!">
          <Tabs defaultValue="ui" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="ui">Quick Create</TabsTrigger>
              <TabsTrigger value="curl">cURL</TabsTrigger>
            </TabsList>

            <TabsContent value="ui" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>Customer Details</CardTitle>
                  <CardDescription>
                    Create a test customer to simulate a subscription.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    />
                  </div>
                  <Button className="w-full" onClick={handleCreateWithContext} disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      "Create Customer"
                    )}
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="curl" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle>API Request</CardTitle>
                  <CardDescription>
                    Run this command in your terminal to create a customer.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative rounded-md bg-slate-950 p-4 font-mono text-slate-50 text-xs">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all">
                      {curlCommand}
                    </pre>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute top-2 right-2 h-8 w-8 text-slate-400 hover:text-slate-50"
                      onClick={handleCopy}
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <p className="text-muted-foreground text-xs">
                      Use the Quick Create tab to proceed with the onboarding flow.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
