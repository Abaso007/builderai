"use client"
import { zodResolver } from "@hookform/resolvers/zod"
import { faqSchema } from "@unprice/db/validators"
import type { Page } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Separator } from "@unprice/ui/separator"
import { Textarea } from "@unprice/ui/text-area"
import { HelpCircle, Pencil, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import { type UseFormGetValues, type UseFormSetValue, useForm } from "react-hook-form"
import { FormProvider } from "react-hook-form"
import type { z } from "zod"

interface FAQSectionProps {
  setValue: UseFormSetValue<Page>
  getValues: UseFormGetValues<Page>
}

export function FAQSection({ setValue, getValues }: FAQSectionProps) {
  const faqs = getValues("faqs") || []
  const [editingId, setEditingId] = useState<string | null>(null)

  const faqForm = useForm<z.infer<typeof faqSchema>>({
    resolver: zodResolver(faqSchema),
    defaultValues: {
      id: "",
      question: "",
      answer: "",
    },
  })

  const handleSaveFaq = (data: z.infer<typeof faqSchema>) => {
    if (editingId) {
      const updatedFaqs = faqs.map((f) =>
        f.id === editingId ? { ...f, question: data.question, answer: data.answer } : f
      )
      setValue("faqs", updatedFaqs)
      setEditingId(null)
    } else {
      const faq: z.infer<typeof faqSchema> = {
        id: Date.now().toString(),
        question: data.question,
        answer: data.answer,
      }
      setValue("faqs", [...faqs, faq])
    }
    faqForm.reset({ id: "", question: "", answer: "" })
  }

  const handleEditFaq = (faq: z.infer<typeof faqSchema>) => {
    setEditingId(faq.id)
    faqForm.setValue("question", faq.question)
    faqForm.setValue("answer", faq.answer)
    faqForm.setValue("id", faq.id)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    faqForm.reset({ id: "", question: "", answer: "" })
  }

  const removeFaq = (faqId: string) => {
    if (editingId === faqId) {
      handleCancelEdit()
    }
    setValue(
      "faqs",
      faqs.filter((faq) => faq.id !== faqId)
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HelpCircle className="h-5 w-5" />
          Frequently Asked Questions
        </CardTitle>
        <CardDescription>Add FAQ items for your page</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new FAQ Form */}
        <FormProvider {...faqForm}>
          <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
            <FormField
              control={faqForm.control}
              name="question"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Question</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter the question" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={faqForm.control}
              name="answer"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Answer</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Enter the answer" className="min-h-[80px]" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex gap-2">
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={faqForm.handleSubmit(handleSaveFaq)}
                className="flex-1"
              >
                {editingId ? (
                  <>
                    <Pencil className="mr-2 h-4 w-4" />
                    Update FAQ
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Add FAQ
                  </>
                )}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" size="sm" onClick={handleCancelEdit}>
                  <X className="mr-2 h-4 w-4" />
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </FormProvider>

        {/* Existing FAQs */}
        {faqs.length > 0 && (
          <div className="space-y-3">
            <Separator />
            <div className="font-medium text-sm">Current FAQs ({faqs.length})</div>
            <ScrollArea className="max-h-[500px]">
              <div className="space-y-3 pr-4">
                {faqs.map((faq) => (
                  <div key={faq.id} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex min-w-0 flex-1 items-center space-y-0">
                        <p className="truncate font-medium text-sm">{faq.question}</p>
                      </div>
                      <div className="ml-2 flex shrink-0 items-start gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditFaq(faq)}
                          className="h-8 w-8 p-0"
                        >
                          <Pencil className="h-4 w-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFaq(faq.id)}
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Remove</span>
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
